"""Parse the model's response into (sql, explanation) or a clarification."""

import re
from dataclasses import dataclass

_SQL_BLOCK = re.compile(r"```(?:sql)?\s*\n(.*?)```", re.DOTALL | re.IGNORECASE)
_CLARIFY = re.compile(r"^\s*CLARIFY:\s*(.+)", re.DOTALL)


@dataclass
class ParsedResponse:
    sql: str | None = None
    explanation: str = ""
    clarification: str | None = None


def parse_response(text: str) -> ParsedResponse:
    clarify = _CLARIFY.match(text)
    if clarify:
        return ParsedResponse(clarification=clarify.group(1).strip().splitlines()[0])

    match = _SQL_BLOCK.search(text)
    if not match:
        return ParsedResponse()

    sql = match.group(1).strip()
    explanation = _SQL_BLOCK.sub("", text).strip().splitlines()
    return ParsedResponse(sql=sql, explanation=explanation[0].strip() if explanation else "")
