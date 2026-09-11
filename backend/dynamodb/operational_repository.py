"""DynamoDB data-access layer for OpsFlow's weekly operational model.

The physical table retains its existing ``pk``/``sk`` schema.  This module
owns the new logical keys and separates spreadsheet source fields from mutable
user operations fields.
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
import os
from typing import Any

from dynamodb.keys import (
    OperationalContext,
    build_import_lookup_pk,
    build_import_sk,
    build_market_sk,
    build_markets_pk,
    build_load_requirement_sk,
    build_load_sk,
    build_production_load_sk,
    build_production_sk,
    build_projection_sk,
    build_week_pk,
    build_weeks_control_key,
    build_year_control_pk,
    normalize_area,
    normalize_record_id,
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class OperationalRepository:
    """Repository for exact-key reads/writes; normal application access uses Query."""

    def __init__(self, table: Any | None = None, table_name: str | None = None):
        if table is not None:
            self._table = table
        else:
            import boto3  # Lambda provides boto3; defer it so unit tests need no AWS SDK.
            self._table = boto3.resource("dynamodb").Table(table_name or os.environ["OPERATIONS_TABLE"])

    # Import metadata is written in the weekly partition. A narrow pointer is
    # also kept for browser polling by random import UUID without a Scan.
    def create_pending_import(
        self, context: OperationalContext, document_type: str, area: str, import_id: str, file_name: str, object_key: str,
    ) -> None:
        area = normalize_area(area)
        import_sk = build_import_sk(document_type, area, import_id)
        now = utc_now()
        item = {
            "pk": build_week_pk(context), "sk": import_sk, "entityType": "IMPORT",
            "organizationId": context.organization_id, "year": context.year, "week": context.week,
            "area": area, "importId": import_id, "importType": normalize_area(document_type),
            "fileName": file_name, "inboxKey": object_key, "status": "PENDING_UPLOAD", "createdAt": now,
        }
        self._table.put_item(Item=item, ConditionExpression="attribute_not_exists(pk) AND attribute_not_exists(sk)")
        self._table.put_item(Item={
            "pk": build_import_lookup_pk(context.organization_id, import_id), "sk": "METADATA",
            "entityType": "IMPORT_LOOKUP", "organizationId": context.organization_id,
            "year": context.year, "week": context.week, "area": area, "importType": normalize_area(document_type),
            "importSk": import_sk, "status": "PENDING_UPLOAD", "createdAt": now,
        })

    def import_metadata(self, context: OperationalContext, document_type: str, area: str, import_id: str) -> dict[str, Any] | None:
        return self._table.get_item(Key={
            "pk": build_week_pk(context), "sk": build_import_sk(document_type, area, import_id),
        }).get("Item")

    def import_metadata_by_id(self, organization_id: str, import_id: str) -> dict[str, Any] | None:
        return self._table.get_item(Key={"pk": build_import_lookup_pk(organization_id, import_id), "sk": "METADATA"}).get("Item")

    def begin_import(self, context: OperationalContext, document_type: str, area: str, import_id: str, checksum: str) -> bool:
        current = self.import_metadata(context, document_type, area, import_id)
        if not current or current.get("status") in {"PROCESSED", "FAILED"}:
            return False
        self._put_import(context, document_type, area, import_id, {"status": "PROCESSING", "checksum": checksum, "processingStartedAt": utc_now()})
        return True

    def complete_import(self, context: OperationalContext, document_type: str, area: str, import_id: str, processed_key: str, record_count: int) -> None:
        self._put_import(context, document_type, area, import_id, {
            "status": "PROCESSED", "processedKey": processed_key, "recordCount": record_count, "completedAt": utc_now(),
        })

    def fail_import(self, context: OperationalContext, document_type: str, area: str, import_id: str, message: str, failed_key: str | None) -> None:
        updates: dict[str, Any] = {"status": "FAILED", "errorMessage": message[:1000], "failedAt": utc_now()}
        if failed_key:
            updates["failedKey"] = failed_key
        self._put_import(context, document_type, area, import_id, updates)

    def _put_import(self, context: OperationalContext, document_type: str, area: str, import_id: str, updates: dict[str, Any]) -> None:
        current = self.import_metadata(context, document_type, area, import_id)
        if not current:
            raise ValueError("The import metadata record was not found.")
        self._table.put_item(Item=_dynamo_values({**current, **updates}))
        pointer = self.import_metadata_by_id(context.organization_id, import_id)
        if pointer:
            self._table.put_item(Item=_dynamo_values({**pointer, **updates}))

    def upsert_import_records(self, context: OperationalContext, document_type: str, parsed: dict[str, Any], import_id: str, source_key: str) -> int:
        if document_type == "production":
            count = len(parsed["records"])
            self._upsert_market_area(context, parsed["records"])
            self._register_week(context)
            return count
        elif document_type == "bulk-plan":
            for load in parsed["loads"]:
                self._upsert_load(context, load, import_id, source_key)
            count = len(parsed["loads"])
        elif document_type == "projection":
            for requirement in parsed["requirements"]:
                self._upsert_projection(context, requirement, import_id, source_key)
            count = len(parsed["requirements"])
        else:
            raise ValueError(f"Unsupported document type: {document_type}")
        self._register_week(context)
        self.refresh_load_relationships(context)
        return count

    def _upsert_market_area(self, context: OperationalContext, records: list[dict[str, Any]]) -> None:
        """Store one production area as machine-keyed ZIP lists in its weekly item."""
        if not records:
            raise ValueError("A production area requires at least one ZIP record.")
        area = normalize_area(records[0]["sourceArea"])
        key = {"pk": build_markets_pk(context), "sk": build_market_sk(area)}
        existing = self._table.get_item(Key=key).get("Item") or {}
        previous_statuses = _machine_zip_statuses(existing)
        item: dict[str, Any] = dict(key)
        seen_zips: set[tuple[str, str]] = set()
        for record in records:
            machine = str(record.get("machine") or "Unassigned").strip() or "Unassigned"
            zip_value = str(record["zip"])
            identity = (machine, zip_value)
            if identity in seen_zips:
                raise ValueError(f"Duplicate ZIP '{zip_value}' found in machine '{machine}' for {area}.")
            seen_zips.add(identity)
            item.setdefault(machine, []).append({
                "zip": zip_value,
                "qty": int(record.get("volume") or 0),
                "ir": str(record.get("ir") or ""),
                "job": str(record.get("jobNumber") or ""),
                "market": str(record.get("market") or ""),
                "status": previous_statuses.get(identity),
            })
        self._table.put_item(Item=_dynamo_values(item))

    def _upsert_production(self, context: OperationalContext, record: dict[str, Any], import_id: str, source_key: str) -> None:
        record_id = normalize_record_id(record["recordId"])
        area = normalize_area(record["sourceArea"])
        key = {"pk": build_week_pk(context), "sk": build_production_sk(area, record_id)}
        existing = self._table.get_item(Key=key).get("Item") or {}
        now = utc_now()
        # Source fields are refreshed. status/notes/updatedBy/version are user-owned and survive a re-import.
        item = {
            **existing, **record, **key, "entityType": "PRODUCTION", "organizationId": context.organization_id,
            "year": context.year, "week": context.week, "sourceArea": area, "recordId": record_id,
            "id": record_id, "source": dict(record), "importId": import_id, "sourceKey": source_key,
            "status": existing.get("status", record["status"]), "createdAt": existing.get("createdAt", now),
            "sourceUpdatedAt": now, "version": existing.get("version", 1),
        }
        self._table.put_item(Item=_dynamo_values(item))

    def _upsert_load(self, context: OperationalContext, load: dict[str, Any], import_id: str, source_key: str) -> None:
        load_id = normalize_record_id(load["number"])
        key = {"pk": build_week_pk(context), "sk": build_load_sk(load_id)}
        existing = self._table.get_item(Key=key).get("Item") or {}
        now = utc_now()
        self._table.put_item(Item=_dynamo_values({
            **existing, **load, **key, "entityType": "LOAD", "organizationId": context.organization_id,
            "year": context.year, "week": context.week, "loadId": load_id, "recordId": load_id,
            "source": dict(load), "importId": import_id, "sourceKey": source_key,
            "status": existing.get("status", load["status"]), "createdAt": existing.get("createdAt", now), "sourceUpdatedAt": now,
        }))

    def _upsert_projection(self, context: OperationalContext, requirement: dict[str, Any], import_id: str, source_key: str) -> None:
        area = normalize_area(requirement["sourceArea"])
        record_id = normalize_record_id(requirement["recordId"])
        key = {"pk": build_week_pk(context), "sk": build_projection_sk(area, record_id)}
        existing = self._table.get_item(Key=key).get("Item") or {}
        now = utc_now()
        self._table.put_item(Item=_dynamo_values({
            **existing, **requirement, **key, "entityType": "PROJECTION", "organizationId": context.organization_id,
            "year": context.year, "week": context.week, "area": area, "recordId": record_id,
            "source": dict(requirement), "importId": import_id, "sourceKey": source_key,
            "createdAt": existing.get("createdAt", now), "sourceUpdatedAt": now,
        }))

    def _register_week(self, context: OperationalContext) -> None:
        pk, sk = build_weeks_control_key()
        current = self._table.get_item(Key={"pk": pk, "sk": sk}).get("Item") or {}
        week_key = f"{context.year}-{context.week:02d}"
        weeks = sorted({str(value) for value in current.get("weeks", [])} | {week_key})
        self._table.put_item(Item={"pk": pk, "sk": sk, "weeks": weeks})

    def list_weeks(self, organization_id: str, year: int) -> list[str]:
        pk, sk = build_weeks_control_key()
        item = self._table.get_item(Key={"pk": pk, "sk": sk}).get("Item") or {}
        prefix = f"{year}-"
        return [value.removeprefix(prefix) for value in item.get("weeks", []) if value.startswith(prefix)]

    def week_data(self, context: OperationalContext) -> dict[str, Any]:
        # Production is stored compactly: one item per market area and its ZIP
        # lists are nested below machine names.  The browser, however, needs a
        # normal list of ZIP records to filter, search, and render.  Flattening
        # happens only in this API read model; it does not create child items.
        market_items = self._query_partition(build_markets_pk(context))
        items = self._query_partition(build_week_pk(context))
        return {
            "id": str(context.week), "label": f"Week {context.week}", "organizationId": context.organization_id,
            "year": context.year, "week": context.week,
            "productionRecords": _flatten_market_records(market_items, context),
            "loads": [item for item in items if item.get("entityType") == "LOAD"],
            "queuePlan": None,
            "projectionRequirements": [item for item in items if item.get("entityType") == "PROJECTION"],
        }

    def update_production_status(self, context: OperationalContext, area: str, record_id: str, status: str, updated_by: str, expected_version: int | None = None) -> dict[str, Any]:
        area = normalize_area(area)
        machine, zip_value = _market_record_identity(record_id)
        key = {"pk": build_markets_pk(context), "sk": build_market_sk(area)}
        item = self._table.get_item(Key=key).get("Item")
        if not item:
            raise ValueError("The production market was not found.")
        rows = item.get(machine)
        if not isinstance(rows, list):
            raise ValueError("The production machine was not found.")
        row_index = next((index for index, row in enumerate(rows) if str(row.get("zip")) == zip_value), None)
        if row_index is None:
            raise ValueError("The production ZIP was not found.")
        # Update just the nested status field.  The conditional ZIP check makes
        # sure a stale list position cannot update a different ZIP.
        updated = self._table.update_item(
            Key=key,
            UpdateExpression="SET #machine[#row].#status = :status",
            ConditionExpression="attribute_exists(pk) AND #machine[#row].#zip = :zip",
            ExpressionAttributeNames={"#machine": machine, "#status": "status", "#zip": "zip"},
            ExpressionAttributeValues={":status": status, ":zip": zip_value},
            ReturnValues="ALL_NEW",
        )["Attributes"]
        return {"status": updated[machine][row_index]["status"]}

    def refresh_load_relationships(self, context: OperationalContext) -> None:
        """Rebuild derived LOADREQ/PRODLOAD adjacency only; never source/user records."""
        items = self._query_partition(build_week_pk(context))
        relationships = [item for item in items if item.get("entityType") in {"LOAD_REQUIREMENT", "PRODUCTION_LOAD"}]
        productions = [item for item in items if item.get("entityType") == "PRODUCTION"]
        loads = {str(item.get("number")): item for item in items if item.get("entityType") == "LOAD"}
        projections = [item for item in items if item.get("entityType") == "PROJECTION"]
        with self._table.batch_writer() as batch:
            for item in relationships:
                batch.delete_item(Key={"pk": item["pk"], "sk": item["sk"]})
            for projection in projections:
                load_id = str(projection.get("trip", ""))
                if load_id not in loads:
                    continue
                for production in (item for item in productions if _same_requirement(item, projection)):
                    production_id = production["recordId"]
                    base = {
                        "organizationId": context.organization_id, "year": context.year, "week": context.week,
                        "loadId": load_id, "productionRecordId": production_id, "productionArea": production["sourceArea"],
                        "zip": production["zip"], "projectionRecordId": projection["recordId"], "updatedAt": utc_now(),
                    }
                    batch.put_item(Item={**base, "entityType": "LOAD_REQUIREMENT", "pk": build_week_pk(context), "sk": build_load_requirement_sk(load_id, production_id)})
                    batch.put_item(Item={**base, "entityType": "PRODUCTION_LOAD", "pk": build_week_pk(context), "sk": build_production_load_sk(production_id, load_id)})

    def _query_partition(self, partition_key: str) -> list[dict[str, Any]]:
        from boto3.dynamodb.conditions import Key
        items: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {"KeyConditionExpression": Key("pk").eq(partition_key)}
        while True:
            response = self._table.query(**kwargs)
            items.extend(response.get("Items", []))
            if not response.get("LastEvaluatedKey"):
                return items
            kwargs["ExclusiveStartKey"] = response["LastEvaluatedKey"]


def _same_requirement(production: dict[str, Any], projection: dict[str, Any]) -> bool:
    if _normalize_atz(production.get("zip")) != _normalize_atz(projection.get("atz")):
        return False
    job_number = str(projection.get("jobNumber") or "").strip()
    return not job_number or job_number == str(production.get("jobNumber") or "").strip()


def _normalize_atz(value: object) -> str:
    return "".join(character for character in str(value or "").upper() if character.isalnum())


def _machine_zip_statuses(item: dict[str, Any]) -> dict[tuple[str, str], Any]:
    """Read retained clerk statuses from a prior machine-keyed area item."""
    statuses: dict[tuple[str, str], Any] = {}
    for machine, rows in item.items():
        if machine in {"pk", "sk"} or not isinstance(rows, list):
            continue
        for row in rows:
            if isinstance(row, dict) and "zip" in row:
                statuses[(machine, str(row["zip"]))] = row.get("status")
    return statuses


def _flatten_market_records(items: list[dict[str, Any]], context: OperationalContext) -> list[dict[str, Any]]:
    """Convert compact market items into the API's ZIP-level read model."""
    records: list[dict[str, Any]] = []
    queue_order = 0
    for item in sorted(items, key=lambda value: str(value.get("sk", ""))):
        sk = str(item.get("sk", ""))
        if not sk.startswith("MARKET-"):
            continue
        area = sk.removeprefix("MARKET-")
        for machine in sorted(key for key, value in item.items() if key not in {"pk", "sk"} and isinstance(value, list)):
            rows = item[machine]
            for row in rows:
                if not isinstance(row, dict) or not row.get("zip"):
                    continue
                zip_value = str(row["zip"])
                records.append({
                    "id": f"{area}~{machine}~{zip_value}",
                    # This compact identity identifies the nested ZIP field for
                    # the status PATCH route; it is not a DynamoDB child key.
                    "recordId": f"{machine}~{zip_value}",
                    "sourceArea": area,
                    "week": str(context.week),
                    "market": str(row.get("market") or area),
                    "jobNumber": str(row.get("job") or "") or None,
                    "machine": machine,
                    "scheduledMachine": machine,
                    "zip": zip_value,
                    # Null in DynamoDB means the clerk has not chosen a status.
                    # The UI renders that as NOT_STARTED without writing it back.
                    "status": str(row.get("status") or "NOT_STARTED"),
                    "sourceStatus": "Blank",
                    "volume": int(row.get("qty") or 0),
                    "ir": str(row.get("ir") or ""),
                    "queueOrder": queue_order,
                })
                queue_order += 1
    return records


def _market_record_identity(record_id: str) -> tuple[str, str]:
    """Decode the API record identity ``machine~zip`` safely."""
    machine, separator, zip_value = str(record_id).partition("~")
    if not separator or not machine.strip() or not zip_value.strip():
        raise ValueError("recordId must identify a machine and ZIP.")
    return machine, zip_value


def _dynamo_values(value: Any) -> Any:
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {key: _dynamo_values(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_dynamo_values(item) for item in value]
    return value
