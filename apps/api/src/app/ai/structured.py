"""Turn Pydantic models into structured-output schemas the API accepts.

The structured-outputs subset requires `additionalProperties: false` on every
object and benefits from every property being required (the model then emits
explicit nulls instead of omitting fields). Pydantic's schema is close but not
exact, so we post-process: force those two properties on every object node and
strip `default` annotations.
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
