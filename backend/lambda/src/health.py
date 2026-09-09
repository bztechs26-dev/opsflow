"""Health endpoint response."""

import json
from typing import Any

from log_events import log_event


def health_response() -> dict[str, Any]:
    log_event("health-check-succeeded", status="ok")
    return {
        "statusCode": 200,
        "headers": {"content-type": "application/json"},
        "body": json.dumps({"service": "opsflow", "status": "ok"}),
    }
