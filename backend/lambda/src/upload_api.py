"""Authenticated API route that issues a short-lived direct S3 upload URL."""

from __future__ import annotations

import base64
import json
import os
import re
from typing import Any
from uuid import uuid4

import boto3

from parsers.common import mapping_area_from_filename, source_area_from_filename, week_from_filename
from dynamodb.keys import OperationalContext, validate_year


DOCUMENT_TYPES = {"production", "bulk-plan", "projection"}
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
SAFE_FILENAME = re.compile(r"[^A-Za-z0-9._-]")


def create_upload_url(event: dict[str, Any]) -> dict[str, Any]:
    document_type = (event.get("pathParameters") or {}).get("documentType", "")
    if document_type not in DOCUMENT_TYPES:
        return _response(400, {"message": "documentType must be production, bulk-plan, or projection."})
    try:
        payload = _json_body(event)
        file_name = str(payload.get("fileName", "")).strip()
        content_type = str(payload.get("contentType", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
        file_size = int(payload.get("fileSize", 0))
        operational_year = validate_year(payload.get("operationalYear"))
        if not file_name.lower().endswith(".xlsx"):
            raise ValueError("Use an Excel (.xlsx) workbook.")
        if not 0 < file_size <= MAX_UPLOAD_BYTES:
            raise ValueError("The workbook must be between 1 byte and 10 MB.")
        week = int(week_from_filename(file_name))
        context = OperationalContext(os.environ["DEFAULT_ORGANIZATION_ID"], operational_year, week)
        area = _import_area(document_type, file_name)
        import_id = str(uuid4())
        safe_name = SAFE_FILENAME.sub("_", file_name)
        object_key = f"inbox/{document_type}/{context.year}/{import_id}/{safe_name}"
        upload_url = boto3.client("s3").generate_presigned_url(
            "put_object",
            Params={
                "Bucket": os.environ["WORKFLOW_BUCKET"],
                "Key": object_key,
                "ContentType": content_type,
            },
            ExpiresIn=300,
            HttpMethod="PUT",
        )
        return _response(201, {"importId": import_id, "objectKey": object_key, "uploadUrl": upload_url, "expiresInSeconds": 300, "operationalYear": context.year, "week": context.week, "area": area})
    except (TypeError, ValueError) as error:
        return _response(400, {"message": str(error)})


def _json_body(event: dict[str, Any]) -> dict[str, Any]:
    body = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8")
    data = json.loads(body)
    if not isinstance(data, dict):
        raise ValueError("The request body must be a JSON object.")
    return data


def _response(status_code: int, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {
            "content-type": "application/json",
            "access-control-allow-origin": _allowed_origin(),
            "access-control-allow-headers": "content-type,authorization",
            "access-control-allow-methods": "OPTIONS,POST",
        },
        "body": json.dumps(payload),
    }


def _allowed_origin() -> str:
    return os.environ.get("WEB_ORIGIN", "https://ware.zeegraphy.com")


def _import_area(document_type: str, file_name: str) -> str:
    if document_type == "production":
        area = source_area_from_filename(file_name)
        if not area:
            raise ValueError("Production files must be named Zip List <AREA> Wk <week>.xlsx.")
        return area
    if document_type == "projection":
        return mapping_area_from_filename(file_name)
    return "ALL"
