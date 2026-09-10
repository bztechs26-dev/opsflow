"""AWS Lambda entry point for the OpsFlow import and health APIs."""

import sys
from pathlib import Path

# The deployed asset is the complete backend/ folder, so make the Lambda
# runtime code and the sibling dynamodb/ package available to its imports.
_SOURCE_DIRECTORY = Path(__file__).resolve().parent
_BACKEND_DIRECTORY = _SOURCE_DIRECTORY.parent.parent
sys.path[:0] = [str(_SOURCE_DIRECTORY), str(_BACKEND_DIRECTORY)]

from typing import Any

from health import health_response
from import_processor import process_inbox_uploads
from infrastructure import maintain_workflow_prefixes
from log_events import log_event
from read_api import read_operations
from status_update_api import update_production_status
from upload_api import create_upload_url


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Route CloudFormation, S3 imports, and the small HTTP API surface."""
    request_id = getattr(context, "aws_request_id", "local")

    if event.get("RequestType") and event.get("ResponseURL"):
        log_event("workflow-prefix-maintenance-started", requestId=request_id)
        return maintain_workflow_prefixes(event, context)

    records = event.get("Records", [])
    if records and records[0].get("eventSource") == "aws:s3":
        log_event("inbox-upload-event-received", requestId=request_id, records=len(records))
        return process_inbox_uploads(event)

    if event.get("resource") == "/uploads/{documentType}" and event.get("httpMethod") == "POST":
        log_event("upload-url-requested", requestId=request_id, documentType=(event.get("pathParameters") or {}).get("documentType"))
        return create_upload_url(event)

    if event.get("httpMethod") == "GET" and event.get("resource") in {"/weeks", "/weeks/{week}", "/projections", "/imports/{importId}"}:
        return read_operations(event)

    if event.get("httpMethod") == "PATCH" and event.get("resource") == "/production/{year}/{week}/{area}/{recordId}/status":
        return update_production_status(event)

    log_event("health-check-received", requestId=request_id)
    return health_response()
