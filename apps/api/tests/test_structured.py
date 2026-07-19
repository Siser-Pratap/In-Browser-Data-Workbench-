from app.ai.schemas import ChartSuggestResponse, CleanResponse, InsightsResponse
from app.ai.structured import to_output_schema


def _object_nodes(node):
    if isinstance(node, dict):
        if node.get("type") == "object" and "properties" in node:
            yield node
        for value in node.values():
            yield from _object_nodes(value)
    elif isinstance(node, list):
        for item in node:
            yield from _object_nodes(item)


def _all_nodes(node):
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from _all_nodes(value)
    elif isinstance(node, list):
        for item in node:
            yield from _all_nodes(item)


def test_every_object_is_closed_and_fully_required():
    for model in (CleanResponse, InsightsResponse, ChartSuggestResponse):
        schema = to_output_schema(model)
        objects = list(_object_nodes(schema))
        assert objects, model.__name__
        for obj in objects:
            assert obj["additionalProperties"] is False
            assert sorted(obj["required"]) == sorted(obj["properties"].keys())


def test_defaults_are_stripped():
    schema = to_output_schema(ChartSuggestResponse)
    assert not any("default" in n for n in _all_nodes(schema))
