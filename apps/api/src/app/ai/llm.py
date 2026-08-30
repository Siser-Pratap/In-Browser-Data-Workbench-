"""The Gemini seam.

Everything provider-specific lives here: client construction, request config,
usage accounting, and the mapping from SDK exceptions to the error events the
SSE contract defines. `service.py` and `chat_service.py` deal in plain dicts and
never import `google.genai` directly, so swapping providers again means
rewriting this file and nothing else.

Two Gemini specifics are worth stating up front because they are easy to get
wrong and fail quietly:

**Automatic function calling is switched off, always.** The SDK will happily
execute tool calls itself and hand back only the final answer. That would be
catastrophic here: our tools are executed *in the user's browser* against their
local DuckDB, so a server-side auto-invocation loop would either fail or, worse,
change what the agent is allowed to touch. `disable=True` is not a tuning knob.

**Roles are `user` and `model`.** There is no `assistant` role. A conversation
built with the wrong role name is accepted by the type system and rejected — or
silently mishandled — by the API.
"""

from __future__ import annotations

from typing import Any

from google import genai
from google.genai import errors as genai_errors
from google.genai import types

# Gemini's own vocabulary, so the rest of the codebase doesn't have to know it.
ROLE_USER = "user"
ROLE_MODEL = "model"

_THINKING_LEVELS = {
    "minimal": types.ThinkingLevel.MINIMAL,
    "low": types.ThinkingLevel.LOW,
    "medium": types.ThinkingLevel.MEDIUM,
    "high": types.ThinkingLevel.HIGH,
}


def build_client(api_key: str) -> genai.Client:
    """A client for the configured key.

    Constructed even when the key is empty so the service can be instantiated
    at import time; every endpoint checks `settings.ai_unconfigured_reason`
    before it calls anything, so an empty key surfaces as a 503 rather than a
    crash. Which key that is depends on the environment — see
    `Settings.active_gemini_api_key`.
    """
    return genai.Client(api_key=api_key or "unset")


def thinking_config(effort: str) -> types.ThinkingConfig:
    """Map our `ai_effort` setting onto Gemini's thinking level."""
    return types.ThinkingConfig(
        thinking_level=_THINKING_LEVELS.get(effort.lower(), types.ThinkingLevel.MEDIUM)
    )


def generation_config(
    *,
    system_instruction: str,
    max_output_tokens: int,
    effort: str,
    output_schema: dict[str, Any] | None = None,
    tools: list[dict[str, Any]] | None = None,
    force_no_tools: bool = False,
) -> types.GenerateContentConfig:
    """Build one request config.

    `output_schema` and `tools` are mutually exclusive in practice: a response
    constrained to a JSON schema has no room to emit a function call, and asking
    for both is a request the model cannot satisfy.
    """
    config = types.GenerateContentConfig(
        system_instruction=system_instruction,
        max_output_tokens=max_output_tokens,
        thinking_config=thinking_config(effort),
        # See the module docstring: our tools run in the browser.
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
    )

    if output_schema is not None:
        # `response_json_schema` takes standard JSON Schema, which is what
        # `structured.py` already produces — no second schema dialect to keep in
        # step with the Pydantic models.
        config.response_mime_type = "application/json"
        config.response_json_schema = output_schema
        return config

    if tools is not None:
        config.tools = [
            types.Tool(
                function_declarations=[
                    types.FunctionDeclaration(
                        name=tool["name"],
                        description=tool.get("description", ""),
                        parameters_json_schema=tool.get("input_schema"),
                    )
                    for tool in tools
                ]
            )
        ]

    if force_no_tools:
        # The wrap-up turn: the model must answer in prose rather than reach for
        # another tool, which is how a capped conversation still terminates with
        # something useful.
        config.tool_config = types.ToolConfig(
            function_calling_config=types.FunctionCallingConfig(
                mode=types.FunctionCallingConfigMode.NONE
            )
        )

    return config


def usage_of(response: Any) -> dict[str, int]:
    """Token counts, in the shape the budget and the SSE contract expect.

    Thinking tokens are billed and are therefore counted as output — leaving
    them out would let a reasoning-heavy conversation quietly overrun the daily
    budget it is supposed to be bounded by.
    """
    metadata = getattr(response, "usage_metadata", None)
    if metadata is None:
        return {"input_tokens": 0, "output_tokens": 0}
    output = int(metadata.candidates_token_count or 0) + int(
        getattr(metadata, "thoughts_token_count", 0) or 0
    )
    return {"input_tokens": int(metadata.prompt_token_count or 0), "output_tokens": output}


def text_of(response: Any) -> str:
    """Concatenate the text parts of a response, ignoring thoughts and calls."""
    return "".join(part.text or "" for part in _parts(response) if part.text and not part.thought)


def function_calls_of(response: Any) -> list[dict[str, Any]]:
    """Every function call in a response, with an id guaranteed to exist.

    Gemini populates `FunctionCall.id` for parallel calls but may leave it unset
    otherwise, while our browser contract requires a stable id to echo back with
    each result. Synthesising one when it is missing keeps that contract
    unchanged — the frontend never learns which provider is behind it.
    """
    calls: list[dict[str, Any]] = []
    for index, part in enumerate(_parts(response)):
        call = part.function_call
        if call is None:
            continue
        calls.append(
            {
                "id": call.id or f"call_{index}",
                "name": call.name or "",
                "input": dict(call.args or {}),
            }
        )
    return calls


def _parts(response: Any) -> list[Any]:
    candidates = getattr(response, "candidates", None) or []
    if not candidates:
        return []
    content = getattr(candidates[0], "content", None)
    return list(getattr(content, "parts", None) or [])


# -- conversation building ---------------------------------------------------


def user_text(text: str) -> dict[str, Any]:
    return {"role": ROLE_USER, "parts": [{"text": text}]}


def model_text(text: str) -> dict[str, Any]:
    return {"role": ROLE_MODEL, "parts": [{"text": text}]}


def model_parts(response: Any) -> dict[str, Any]:
    """The assistant turn, preserved verbatim for the next request.

    Text and function calls both have to survive: dropping the calls would leave
    the following `function_response` parts with nothing to answer, which the
    API rejects.

    **`thought_signature` must survive too, and this is the subtle one.**
    Thinking models attach an opaque signature to the part carrying a function
    call, and it has to be echoed back with that part when the conversation
    continues. Drop it and the *next* request fails with "Function call is
    missing a thought_signature in functionCall parts" — so the failure lands on
    the resume, one step away from the code that caused it, and only for tool
    calls. It is why the agent loop cannot simply rebuild parts from name+args.
    """
    parts: list[dict[str, Any]] = []
    for part in _parts(response):
        if part.function_call is not None:
            entry: dict[str, Any] = {
                "function_call": {
                    "id": part.function_call.id,
                    "name": part.function_call.name,
                    "args": dict(part.function_call.args or {}),
                }
            }
            if part.thought_signature is not None:
                entry["thought_signature"] = part.thought_signature
            parts.append(entry)
        elif part.text and not part.thought:
            entry = {"text": part.text}
            if part.thought_signature is not None:
                entry["thought_signature"] = part.thought_signature
            parts.append(entry)
    return {"role": ROLE_MODEL, "parts": parts}


def function_response_part(call_id: str, name: str, payload: Any) -> dict[str, Any]:
    """One tool result.

    `response` must be an object — a bare string or list is rejected — so
    non-dict payloads are wrapped rather than sent as-is.
    """
    response = payload if isinstance(payload, dict) else {"result": payload}
    return {"function_response": {"id": call_id, "name": name, "response": response}}


# -- errors ------------------------------------------------------------------

APIError = genai_errors.APIError


def error_event(exc: Exception) -> dict[str, str]:
    """Map an SDK failure onto the SSE `error` event the clients understand.

    Status codes rather than exception classes: the SDK groups everything under
    `ClientError`/`ServerError`, so the code is the only thing that distinguishes
    "your key is wrong" from "you are going too fast".

    The two 400 cases are worth separating and are the reason this reads the
    message body at all. Gemini answers a bad key with **400 INVALID_ARGUMENT /
    API_KEY_INVALID**, not the 401 you would expect — so without this the single
    most likely misconfiguration would surface to the user as the generic "the
    AI service rejected the request", which says nothing about what to fix.
    """
    status = getattr(exc, "code", None) or getattr(exc, "status_code", None)
    detail = str(exc)

    if status in (401, 403) or "API_KEY_INVALID" in detail:
        return _error(
            "not_configured",
            "AI is not configured on this server (missing or invalid API key).",
        )
    if status == 429:
        return _error("upstream_rate_limited", "The AI service is rate-limited; try again shortly.")
    if status == 404 or "NOT_FOUND" in detail:
        return _error(
            "model_not_found",
            "The configured AI model was not found. Check AI_MODEL against the models your "
            "Gemini key can access.",
        )
    if status == 400:
        return _error("upstream_error", "The AI service rejected the request.")
    return _error("upstream_error", "The AI service failed to respond.")


def _error(code: str, message: str) -> dict[str, str]:
    return {"type": "error", "code": code, "message": message}
