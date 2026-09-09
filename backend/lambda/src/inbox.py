"""Initial S3 inbox event handling.

Parsing and file movement deliberately do not belong here yet. This module only
acknowledges events from the existing S3 notification on the inbox/ prefix.
"""

import json
from typing import Any
from urllib.parse import unquote_plus

from log_events import log_event


def acknowledge_inbox_uploads(event: dict[str, Any]) -> dict[str, Any]:
    uploads: list[dict[str, str]] = []
    ignored_markers = 0

    for record in event.get("Records", []):
        s3_record = record.get("s3", {})
        bucket = s3_record.get("bucket", {}).get("name", "")
        key = unquote_plus(s3_record.get("object", {}).get("key", ""))

        # Folder markers are not business uploads.
        if key and key != "inbox/.keep":
            uploads.append({"bucket": bucket, "key": key})
        elif key:
            ignored_markers += 1

    log_event(
        "inbox-upload-acknowledged",
        uploads=uploads,
        uploadCount=len(uploads),
        ignoredMarkers=ignored_markers,
    )
    return {
        "statusCode": 202,
        "body": json.dumps({"status": "accepted", "uploads": len(uploads)}),
    }
