"""AWS Lambda entry point for the OpsFlow backend foundation."""

from typing import Any

from health import health_response
from inbox import acknowledge_inbox_uploads
from infrastructure import maintain_workflow_prefixes
from log_events import log_event


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Route the small set of events supported during the backend foundation phase."""
    request_id = getattr(context, "aws_request_id", "local")

    if event.get("RequestType") and event.get("ResponseURL"):
        log_event("workflow-prefix-maintenance-started", requestId=request_id)
        return maintain_workflow_prefixes(event, context)

    records = event.get("Records", [])
    if records and records[0].get("eventSource") == "aws:s3":
        log_event("inbox-upload-event-received", requestId=request_id, records=len(records))
        return acknowledge_inbox_uploads(event)

    log_event("health-check-received", requestId=request_id)
    return health_response()
