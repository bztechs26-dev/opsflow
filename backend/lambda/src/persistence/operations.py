"""Single-table DynamoDB persistence for the three OpsFlow workbook types."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
import os
from typing import Any, Iterable

import boto3
from boto3.dynamodb.conditions import Key


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class OperationsRepository:
    """Persist imports and operational records in the ops-flow-valassis table."""

    def __init__(self, table_name: str | None = None):
        self._table = boto3.resource("dynamodb").Table(table_name or os.environ["OPERATIONS_TABLE"])

    def import_metadata(self, import_id: str) -> dict[str, Any] | None:
        return self._table.get_item(Key={"pk": f"IMPORT#{import_id}", "sk": "METADATA"}).get("Item")

    def create_pending_import(self, import_id: str, document_type: str, file_name: str, object_key: str) -> None:
        self._table.put_item(
            Item={
                "pk": f"IMPORT#{import_id}",
                "sk": "METADATA",
                "entityType": "IMPORT",
                "importId": import_id,
                "documentType": document_type,
                "fileName": file_name,
                "inboxKey": object_key,
                "status": "PENDING_UPLOAD",
                "createdAt": utc_now(),
            },
            ConditionExpression="attribute_not_exists(pk)",
        )

    def begin_import(self, import_id: str, document_type: str, file_name: str, inbox_key: str, checksum: str) -> bool:
        existing = self.import_metadata(import_id)
        if existing and existing.get("status") in {"PROCESSED", "FAILED"}:
            return False
        now = utc_now()
        self._table.put_item(
            Item={
                **(existing or {}),
                "pk": f"IMPORT#{import_id}",
                "sk": "METADATA",
                "entityType": "IMPORT",
                "importId": import_id,
                "documentType": document_type,
                "fileName": file_name,
                "inboxKey": inbox_key,
                "checksum": checksum,
                "status": "PROCESSING",
                "createdAt": existing.get("createdAt", now) if existing else now,
                "processingStartedAt": now,
            },
        )
        return True

    def replace_import_records(
        self,
        document_type: str,
        week: str,
        parsed: dict[str, Any],
        import_id: str,
        source_key: str,
    ) -> int:
        existing = self._week_items(week)
        deletions = self._records_to_replace(document_type, parsed, existing)
        records = self._items_for(document_type, week, parsed, import_id, source_key)
        with self._table.batch_writer() as batch:
            for item in deletions:
                batch.delete_item(Key={"pk": item["pk"], "sk": item["sk"]})
            for item in records:
                batch.put_item(Item=_dynamo_values(item))
        self._table.put_item(Item={
            "pk": "CONTROL",
            "sk": f"WEEK#{week}",
            "entityType": "WEEK",
            "week": week,
            "updatedAt": utc_now(),
        })
        return len(records)

    def list_weeks(self) -> list[str]:
        response = self._table.query(KeyConditionExpression=Key("pk").eq("CONTROL"))
        return sorted((item["week"] for item in response.get("Items", []) if item.get("entityType") == "WEEK"), key=int)

    def week_data(self, week: str) -> dict[str, Any]:
        items = self._week_items(week)
        records = [item for item in items if item.get("entityType") == "PRODUCTION"]
        loads = [item for item in items if item.get("entityType") == "LOAD"]
        plan = next((item for item in items if item.get("entityType") == "QUEUE_PLAN"), None)
        mappings = [item for item in items if item.get("entityType") == "PROJECTION_MAPPING"]
        return {
            "id": week,
            "label": f"Week {week}",
            "productionRecords": records,
            "loads": loads,
            "queuePlan": _queue_plan(plan, items),
            "projectionRequirements": mappings,
        }

    def complete_import(self, import_id: str, week: str, processed_key: str, record_count: int) -> None:
        self._table.update_item(
            Key={"pk": f"IMPORT#{import_id}", "sk": "METADATA"},
            UpdateExpression="SET #status = :status, week = :week, processedKey = :processedKey, recordCount = :recordCount, completedAt = :completedAt",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={
                ":status": "PROCESSED",
                ":week": week,
                ":processedKey": processed_key,
                ":recordCount": record_count,
                ":completedAt": utc_now(),
            },
        )

    def fail_import(self, import_id: str, message: str, failed_key: str | None = None) -> None:
        expression = "SET #status = :status, errorMessage = :message, failedAt = :failedAt"
        values: dict[str, Any] = {":status": "FAILED", ":message": message[:1000], ":failedAt": utc_now()}
        if failed_key:
            expression += ", failedKey = :failedKey"
            values[":failedKey"] = failed_key
        self._table.update_item(
            Key={"pk": f"IMPORT#{import_id}", "sk": "METADATA"},
            UpdateExpression=expression,
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues=values,
        )

    def _week_items(self, week: str) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {"KeyConditionExpression": Key("pk").eq(f"WEEK#{week}")}
        while True:
            response = self._table.query(**kwargs)
            items.extend(response.get("Items", []))
            key = response.get("LastEvaluatedKey")
            if not key:
                return items
            kwargs["ExclusiveStartKey"] = key

    def _records_to_replace(
        self, document_type: str, parsed: dict[str, Any], existing: Iterable[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        if document_type == "production":
            areas = set(parsed["affectedAreas"])
            return [
                item for item in existing
                if item.get("entityType") == "PRODUCTION" and item.get("sourceArea") in areas
            ]
        if document_type == "bulk-plan":
            return [item for item in existing if item.get("entityType") == "LOAD"]
        if document_type == "projection":
            area = parsed["requirements"][0]["sourceArea"]
            return [
                item for item in existing
                if item.get("entityType") == "PROJECTION_MAPPING" and item.get("sourceArea") == area
            ]
        raise ValueError(f"Unsupported document type: {document_type}")
    def _items_for(
        self, document_type: str, week: str, parsed: dict[str, Any], import_id: str, source_key: str
    ) -> list[dict[str, Any]]:
        base = {"pk": f"WEEK#{week}", "importId": import_id, "sourceKey": source_key, "updatedAt": utc_now()}
        if document_type == "production":
            items = [
                {**base, **record, "sk": f"PRODUCTION#{record['sourceArea']}#{record['queueOrder']:06d}", "entityType": "PRODUCTION"}
                for record in parsed["records"]
            ]
            if parsed.get("queuePlan"):
                plan = parsed["queuePlan"]
                items.append({**base, "sk": "QUEUE#PLAN", "entityType": "QUEUE_PLAN", **plan})
                items.extend({
                    **base,
                    "sk": f"QUEUE#MACHINE#{machine['machine']}",
                    "entityType": "QUEUE_MACHINE",
                    **machine,
                } for machine in plan["machines"])
            return items
        if document_type == "bulk-plan":
            return [{**base, **load, "sk": f"LOAD#{load['number']}", "entityType": "LOAD"} for load in parsed["loads"]]
        if document_type == "projection":
            return [{
                **base,
                **requirement,
                "sk": f"MAPPING#{requirement['trip']}#{requirement['atz']}#{requirement['jobNumber'] or '-'}",
                "entityType": "PROJECTION_MAPPING",
            } for requirement in parsed["requirements"]]
        raise ValueError(f"Unsupported document type: {document_type}")


def _dynamo_values(value: Any) -> Any:
    """boto3 requires Decimal rather than float for DynamoDB Number values."""
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {key: _dynamo_values(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_dynamo_values(item) for item in value]
    return value


def _queue_plan(plan: dict[str, Any] | None, items: Iterable[dict[str, Any]]) -> dict[str, Any] | None:
    if not plan:
        return None
    machines = [
        {key: value for key, value in item.items() if key in {"machine", "expectedPackages", "lhptGoal"}}
        for item in items if item.get("entityType") == "QUEUE_MACHINE"
    ]
    return {"shiftHours": plan.get("shiftHours"), "machines": machines}
