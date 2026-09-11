"""Authenticated, exact-key production status updates."""

from __future__ import annotations

import base64
import json
import os
from typing import Any

from dynamodb.keys import OperationalContext
from dynamodb.operational_repository import OperationalRepository


ALLOWED_STATUSES = {"NOT_STARTED", "IN_PROGRESS", "COMPLETE", "BLOCKED", "SKIPPED"}


def update_production_status(event: dict[str, Any]) -> dict[str, Any]:
    try:
        path = event.get("pathParameters") or {}
        context = OperationalContext(os.environ["DEFAULT_ORGANIZATION_ID"], path.get("year"), path.get("week"))
        area = str(path.get("area", ""))
        body = _json_body(event)
        status = str(body.get("status", "")).upper()
        if status not in ALLOWED_STATUSES:
            raise ValueError("status must be one of NOT_STARTED, IN_PROGRESS, COMPLETE, BLOCKED, or SKIPPED.")
        expected_version = body.get("version")
        if expected_version is not None:
            expected_version = int(expected_version)
            if expected_version < 1:
                raise ValueError("version must be a positive integer.")
        claims = ((event.get("requestContext") or {}).get("authorizer") or {}).get("claims") or {}
        updated_by = str(claims.get("sub") or claims.get("email") or "authenticated-user")
        # Machine and ZIP are request data, not URL path data: ZIP/ATZ values
        # commonly contain spaces and suffixes such as "07054 F1".
        machine = str(body.get("machine", ""))
        zip_value = str(body.get("zip", ""))
        item = OperationalRepository().update_production_status(
            context, area, f"{machine}~{zip_value}", status, updated_by, expected_version,
        )
        return _response(200, item)
    except (TypeError, ValueError) as error:
        return _response(400, {"message": str(error)})
    except Exception as error:
        if _conditional_failure(error):
            # The condition prevents UpdateItem from creating a row. The client
            # must refresh if it supplied a stale version or an unknown record.
            return _response(409, {"message": "This production record was not found or was changed by another user. Refresh and try again."})
        raise


def _json_body(event: dict[str, Any]) -> dict[str, Any]:
    body = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8")
    payload = json.loads(body)
    if not isinstance(payload, dict):
        raise ValueError("The request body must be a JSON object.")
    return payload


def _conditional_failure(error: Exception) -> bool:
    response = getattr(error, "response", {})
    return response.get("Error", {}).get("Code") == "ConditionalCheckFailedException"


def _response(status_code: int, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {
            "content-type": "application/json",
            "access-control-allow-origin": os.environ.get("WEB_ORIGIN", "https://ware.zeegraphy.com"),
            "access-control-allow-headers": "content-type,authorization",
            "access-control-allow-methods": "OPTIONS,GET,POST,PATCH",
        },
        "body": json.dumps(payload, default=str),
    }
