"""Turn Pydantic models into structured-output schemas.

Used two ways, both of which take standard JSON Schema: Gemini's
`response_json_schema` for the Phase 2 endpoints, and `parameters_json_schema`
on a function declaration for the analyst's tools.

Pydantic's output is close but benefits from two adjustments. Marking every
property required makes the model emit explicit nulls rather than omitting
fields, which turns "absent" into a value the parser can distinguish from a
truncated response. `additionalProperties: false` keeps it from inventing keys
the Pydantic model will then reject. `default` is stripped because it describes
what *our* code does when a field is missing, and is only noise to the model.
"""

from typing import Any

from pydantic import BaseModel


def to_output_schema(model: type[BaseModel]) -> dict[str, Any]:
    schema = model.model_json_schema()
    _tighten(schema)
    return schema


def _tighten(node: Any) -> None:
    if isinstance(node, dict):
        if node.get("type") == "object" and "properties" in node:
            node["additionalProperties"] = False
            node["required"] = list(node["properties"].keys())
        node.pop("default", None)
        for value in node.values():
            _tighten(value)
    elif isinstance(node, list):
        for item in node:
            _tighten(item)
