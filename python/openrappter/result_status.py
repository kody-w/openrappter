import json
from typing import Any


def agent_result_is_error(result: Any) -> bool:
    if not isinstance(result, str):
        return False
    try:
        parsed = json.loads(result)
    except (TypeError, ValueError):
        return False
    return (
        isinstance(parsed, dict)
        and isinstance(parsed.get("status"), str)
        and parsed["status"].lower() == "error"
    )
