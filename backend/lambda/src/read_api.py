"""Read-only operations API for the React application."""

from __future__ import annotations

from decimal import Decimal
import json
from typing import Any

from dynamodb.operations import OperationsRepository


def read_operations(event: dict[str, Any]) -> dict[str, Any]:
    repository = OperationsRepository()
    path = event.get("resource")
    if path == "/weeks":
        weeks = repository.list_weeks()
        return _response(200, {"weeks": weeks})
    if path == "/weeks/{week}":
        week = (event.get("pathParameters") or {}).get("week", "")
        return _response(200, repository.week_data(week))
    if path == "/projections":
        week = (event.get("queryStringParameters") or {}).get("week", "")
        if not week:
            return _response(400, {"message": "week is required."})
        return _response(200, {"requirements": repository.week_data(week)["projectionRequirements"]})
    return _response(404, {"message": "Route not found."})


def _response(status_code: int, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {
            "content-type": "application/json",
            "access-control-allow-origin": "https://ware.zeegraphy.com",
        },
        "body": json.dumps(payload, default=_json_default),
    }


def _json_default(value: Any) -> Any:
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    raise TypeError(f"{type(value).__name__} is not JSON serializable")
