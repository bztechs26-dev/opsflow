"""Small JSON logger for CloudWatch-readable operational events."""

import json
from typing import Any


def log_event(event_name: str, **details: Any) -> None:
    print(json.dumps({"service": "opsflow", "event": event_name, **details}))
