"""S3 inbox processor: parse, upsert, then move each workbook exactly once."""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import unquote_plus

import boto3

from log_events import log_event
from parsers.bulk_plan import parse_bulk_plan
from parsers.common import mapping_area_from_filename, source_area_from_filename, week_from_filename
from parsers.production import parse_production
from parsers.projection import parse_projection
from dynamodb.keys import OperationalContext
from dynamodb.operational_repository import OperationalRepository


SUPPORTED_TYPES = {"production", "bulk-plan", "projection"}


def process_inbox_uploads(event: dict[str, Any]) -> dict[str, Any]:
    processed = 0
    ignored = 0
    for record in event.get("Records", []):
        bucket = record.get("s3", {}).get("bucket", {}).get("name", "")
        key = unquote_plus(record.get("s3", {}).get("object", {}).get("key", ""))
        if key == "inbox/.keep":
            ignored += 1
            continue
        _process_one(bucket, key)
        processed += 1
    return {"statusCode": 200, "body": f"processed={processed}, ignored={ignored}"}


def _process_one(bucket: str, key: str) -> None:
    document_type, year, import_id, file_name = _upload_identity(key)
    week = int(week_from_filename(file_name))
    context = OperationalContext(os.environ["DEFAULT_ORGANIZATION_ID"], year, week)
    area = _import_area(document_type, file_name)
    repository = OperationalRepository()
    s3 = boto3.client("s3")
    try:
        source = s3.get_object(Bucket=bucket, Key=key)
        contents = source["Body"].read()
        parsed = _parse(document_type, contents, str(week), file_name)
        count = repository.upsert_import_records(context, document_type, parsed, import_id, key)
        processed_key = f"{os.environ['PROCESSED_PREFIX']}{document_type}/year-{year}/week-{week:02d}/{file_name}"
        _move_object(s3, bucket, key, processed_key)
        log_event(
            "inbox-upload-processed",
            importId=import_id,
            documentType=document_type,
            year=year, week=week,
            records=count,
            processedKey=processed_key,
        )
    except Exception as error:
        failed_key = f"{os.environ['FAILED_PREFIX']}{document_type}/{import_id}/{file_name}"
        try:
            _move_object(s3, bucket, key, failed_key)
        except Exception as move_error:
            log_event("inbox-upload-failed-file-move", importId=import_id, key=key, error=str(move_error))
            failed_key = None
        log_event("inbox-upload-failed", importId=import_id, documentType=document_type, key=key, error=str(error))
        raise


def _upload_identity(key: str) -> tuple[str, int, str, str]:
    parts = key.split("/")
    if len(parts) != 5 or parts[0] != "inbox" or parts[1] not in SUPPORTED_TYPES:
        raise ValueError("Inbox files must use inbox/{production|bulk-plan|projection}/{year}/{import-id}/{filename}.")
    document_type, year_text, import_id, file_name = parts[1:]
    try:
        year = int(year_text)
    except ValueError as error:
        raise ValueError("Inbox uploads must include a valid operational year.") from error
    if not import_id or not file_name.lower().endswith(".xlsx"):
        raise ValueError("Inbox uploads must be Excel (.xlsx) workbooks.")
    return document_type, year, import_id, file_name


def _parse(document_type: str, contents: bytes, week: str, file_name: str) -> dict[str, Any]:
    if document_type == "production":
        return parse_production(contents, week, file_name)
    if document_type == "bulk-plan":
        return parse_bulk_plan(contents, week)
    if document_type == "projection":
        return parse_projection(contents, week, file_name)
    raise ValueError(f"Unsupported document type: {document_type}")


def _move_object(s3: Any, bucket: str, source_key: str, destination_key: str) -> None:
    s3.copy_object(Bucket=bucket, Key=destination_key, CopySource={"Bucket": bucket, "Key": source_key})
    s3.delete_object(Bucket=bucket, Key=source_key)


def _import_area(document_type: str, file_name: str) -> str:
    if document_type == "production":
        area = source_area_from_filename(file_name)
        if not area:
            raise ValueError("Production files must be named Zip List <AREA> Wk <week>.xlsx.")
        return area
    if document_type == "projection":
        return mapping_area_from_filename(file_name)
    return "ALL"
