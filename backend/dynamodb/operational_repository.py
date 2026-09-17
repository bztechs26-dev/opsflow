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
import json

from dynamodb.keys import (
    OperationalContext,
    build_import_lookup_pk,
    build_import_sk,
    build_bulk_plan_sk,
    build_projection_mappings_sk,
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


_MARKET_METADATA_FIELDS = {"pk", "sk"}
# Keep a margin below DynamoDB's 400 KB hard item limit because DynamoDB also
# counts attribute names and type metadata, not only the JSON source values.
_MAX_DYNAMODB_ITEM_BYTES = 360 * 1024


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
        elif document_type == "bulk-plan":
            count = self._upsert_bulk_plan(context, parsed["loads"])
        elif document_type == "projection":
            count = self._upsert_projection_mappings(context, parsed["market"], parsed["mappings"])
        else:
            raise ValueError(f"Unsupported document type: {document_type}")
        self._register_week(context)
        return count

    def _upsert_market_area(self, context: OperationalContext, records: list[dict[str, Any]]) -> None:
        """Store one production area as machine-keyed ZIP lists in its weekly item."""
        if not records:
            raise ValueError("A production area requires at least one ZIP record.")
        area = normalize_area(records[0]["sourceArea"])
        key = {"pk": build_markets_pk(context), "sk": build_market_sk(area)}
        existing = self._table.get_item(Key=key).get("Item") or {}
        # A workbook always describes the scheduled machine, while operations
        # may have reassigned a ZIP during the shift.  Preserve that clerk-owned
        # allocation (and its history) when a corrected workbook is imported.
        previous_rows = _scheduled_machine_zip_rows(existing)
        item: dict[str, Any] = dict(key)
        seen_zips: set[tuple[str, str]] = set()
        for record in records:
            machine = str(record.get("machine") or "Unassigned").strip() or "Unassigned"
            scheduled_machine = str(record.get("scheduledMachine") or machine).strip() or machine
            zip_value = str(record["zip"])
            identity = (scheduled_machine, zip_value)
            if identity in seen_zips:
                raise ValueError(f"Duplicate ZIP '{zip_value}' found in machine '{machine}' for {area}.")
            seen_zips.add(identity)
            previous = previous_rows.get(identity, {})
            active_machine = str(previous.get("machine") or machine)
            row = {
                "zip": zip_value,
                "qty": int(record.get("volume") or 0),
                "ir": str(record.get("ir") or ""),
                "job": str(record.get("jobNumber") or ""),
                "market": str(record.get("market") or ""),
                "scheduledMachine": scheduled_machine,
                "status": previous.get("status"),
            }
            if previous.get("movedAt"):
                row["movedAt"] = previous["movedAt"]
            if previous.get("transferHistory"):
                row["transferHistory"] = previous["transferHistory"]
            item.setdefault(active_machine, []).append(row)
        self._put_market_item(item)

    def _upsert_bulk_plan(self, context: OperationalContext, loads: list[dict[str, Any]]) -> int:
        """Merge a revised Bulk Plan into its independent weekly Shipping item.

        A Bulk Plan is a current-week plan snapshot.  Its trip/load number is
        the stable identity: a later workbook may correct planner-owned
        details such as carrier, stops, weight, or schedule for that trip,
        while a new trip is appended.  User-owned operational fields (for
        example a future UI-updated status or note) are retained.
        """
        key = {"pk": build_markets_pk(context), "sk": build_bulk_plan_sk()}
        existing = self._table.get_item(Key=key).get("Item") or {}
        merged_loads = _merge_bulk_plan_loads(existing.get("loads", []), loads)
        item = {
            **key,
            "loads": merged_loads,
        }
        self._put_market_item(item)
        return len(loads)

    def _upsert_projection_mappings(self, context: OperationalContext, market: str, mappings: dict[str, list[str]]) -> int:
        """Store one Projection market workbook as a compact trip-to-ZIP map."""
        if not mappings:
            raise ValueError("A Projection workbook requires at least one ZIP/TR mapping.")
        normalized = {
            str(trip).strip(): sorted({str(atz).strip().upper() for atz in atzs if str(atz).strip()})
            for trip, atzs in mappings.items()
            if str(trip).strip()
        }
        if not normalized or any(not atzs for atzs in normalized.values()):
            raise ValueError("Each Projection trip must contain at least one ZIP.")
        key = {"pk": build_markets_pk(context), "sk": build_projection_mappings_sk(market)}
        existing = self._table.get_item(Key=key).get("Item") or {}
        retained = existing.get("mappings", {}) if isinstance(existing.get("mappings", {}), dict) else {}
        retained = {
            str(trip): [str(zip_value) for zip_value in atzs if str(zip_value) != "00000"]
            for trip, atzs in retained.items()
            if str(trip).strip().lstrip("0") and isinstance(atzs, list)
        }
        merged = {
            str(trip): sorted({*map(str, retained.get(str(trip), [])), *atzs})
            for trip, atzs in ({**retained, **normalized}).items()
        }
        self._put_market_item({
            **key, "market": normalize_area(market),
            "productionSourceArea": normalize_area(market),
            "productionSourceWeek": context.week,
            "mappings": merged,
        })
        return sum(len(atzs) for atzs in normalized.values())

    def _put_market_item(self, item: dict[str, Any]) -> None:
        """Fail clearly before DynamoDB rejects an oversized compact item."""
        size = len(json.dumps(item, default=str, separators=(",", ":")).encode("utf-8"))
        if size > _MAX_DYNAMODB_ITEM_BYTES:
            raise ValueError(
                f"{item['sk']} is {size:,} bytes and is too close to DynamoDB's 400 KB item limit. "
                "Reduce the number of records in this source workbook before uploading."
            )
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

    def projection_mappings(self, context: OperationalContext) -> list[dict[str, Any]]:
        markets: list[dict[str, Any]] = []
        for market in ("FE", "BE", "PROV-BOST", "MMSI"):
            item = self._table.get_item(Key={"pk": build_markets_pk(context), "sk": build_projection_mappings_sk(market)}).get("Item") or {}
            mappings = item.get("mappings", {})
            if isinstance(mappings, dict) and mappings:
                markets.append({"market": market, "productionSourceArea": item.get("productionSourceArea", market), "productionSourceWeek": item.get("productionSourceWeek", context.week), "mappings": mappings})
        return markets

    def week_data(self, context: OperationalContext) -> dict[str, Any]:
        # Production is stored compactly: one item per market area and its ZIP
        # lists are nested below machine names.  The browser, however, needs a
        # normal list of ZIP records to filter, search, and render.  Flattening
        # happens only in this API read model; it does not create child items.
        weekly_items = self._query_partition(build_markets_pk(context))
        items = self._query_partition(build_week_pk(context))
        return {
            "id": str(context.week), "label": f"Week {context.week}", "organizationId": context.organization_id,
            "year": context.year, "week": context.week,
            "productionRecords": _flatten_market_records(weekly_items, context),
            "loads": _bulk_plan_loads(weekly_items),
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
            # DynamoDB requires a literal list index; expression placeholders
            # are valid for attribute names and values, not ``[index]``.
            UpdateExpression=f"SET #machine[{row_index}].#status = :status",
            ConditionExpression=f"attribute_exists(pk) AND #machine[{row_index}].#zip = :zip",
            ExpressionAttributeNames={"#machine": machine, "#status": "status", "#zip": "zip"},
            ExpressionAttributeValues={":status": status, ":zip": zip_value},
            ReturnValues="ALL_NEW",
        )["Attributes"]
        return {"status": updated[machine][row_index]["status"]}

    def move_production_zip(self, context: OperationalContext, area: str, record_id: str, target_machine: str, updated_by: str) -> dict[str, Any]:
        """Move an unfinished ZIP to another existing production machine.

        Both machine lists live in one market item, allowing a single
        conditional DynamoDB update to atomically remove the ZIP from its
        current machine and add it to the destination machine.
        """
        area = normalize_area(area)
        source_machine, zip_value = _market_record_identity(record_id)
        target_machine = str(target_machine or "").strip()
        if not target_machine:
            raise ValueError("Choose the machine receiving this ZIP.")
        if target_machine == source_machine:
            raise ValueError("This ZIP is already assigned to that machine.")
        key = {"pk": build_markets_pk(context), "sk": build_market_sk(area)}
        item = self._table.get_item(Key=key).get("Item")
        if not item:
            raise ValueError("The production market was not found.")
        source_rows = item.get(source_machine)
        if not isinstance(source_rows, list):
            raise ValueError("The current production machine was not found.")
        row_index = next((index for index, row in enumerate(source_rows) if str(row.get("zip")) == zip_value), None)
        if row_index is None:
            raise ValueError("The production ZIP was not found.")
        source_row = source_rows[row_index]
        if str(source_row.get("status") or "NOT_STARTED") in {"COMPLETE", "BLOCKED"}:
            raise ValueError("Processed ZIPs cannot be moved to another machine.")
        target_rows = item.get(target_machine, [])
        if not isinstance(target_rows, list):
            raise ValueError("The receiving machine is invalid.")
        if any(str(row.get("zip")) == zip_value for row in target_rows if isinstance(row, dict)):
            raise ValueError("That ZIP is already assigned to the receiving machine.")
        now = utc_now()
        moved_row = dict(source_row)
        moved_row["scheduledMachine"] = str(source_row.get("scheduledMachine") or source_machine)
        moved_row["movedAt"] = now
        history = list(source_row.get("transferHistory") or [])
        history.append({"from": source_machine, "to": target_machine, "movedAt": now, "updatedBy": updated_by})
        moved_row["transferHistory"] = history
        updated_source_rows = [row for index, row in enumerate(source_rows) if index != row_index]
        updated_target_rows = [*target_rows, moved_row]
        updated = self._table.update_item(
            Key=key,
            UpdateExpression="SET #source = :sourceRows, #target = :targetRows",
            ConditionExpression=f"attribute_exists(pk) AND #source[{row_index}].#zip = :zip",
            ExpressionAttributeNames={"#source": source_machine, "#target": target_machine, "#zip": "zip"},
            ExpressionAttributeValues={":sourceRows": updated_source_rows, ":targetRows": updated_target_rows, ":zip": zip_value},
            ReturnValues="ALL_NEW",
        )["Attributes"]
        current = next(row for row in updated[target_machine] if str(row.get("zip")) == zip_value)
        return {
            "machine": target_machine,
            "scheduledMachine": current.get("scheduledMachine"),
            "movedAt": current.get("movedAt"),
            "transferHistory": current.get("transferHistory", []),
        }

    def update_bulk_plan_status(self, context: OperationalContext, load_number: str, status: str, updated_by: str, status_at: str | None = None) -> dict[str, Any]:
        """Persist one Shipping load status without rewriting the weekly plan."""
        key = {"pk": build_markets_pk(context), "sk": build_bulk_plan_sk()}
        item = self._table.get_item(Key=key).get("Item")
        if not item:
            raise ValueError("The weekly Bulk Plan was not found.")
        loads = item.get("loads")
        if not isinstance(loads, list):
            raise ValueError("The weekly Bulk Plan has no loads.")
        normalized_number = str(load_number or "").strip()
        row_index = next((index for index, load in enumerate(loads) if isinstance(load, dict) and str(load.get("number") or "").strip() == normalized_number), None)
        if row_index is None:
            raise ValueError("The Bulk Plan load was not found.")
        update_expression = f"SET #loads[{row_index}].#status = :status, #loads[{row_index}].#updatedBy = :updatedBy, #loads[{row_index}].#statusUpdatedAt = :statusUpdatedAt"
        names = {"#loads": "loads", "#status": "status", "#number": "number", "#updatedBy": "updatedBy", "#statusUpdatedAt": "statusUpdatedAt"}
        values: dict[str, Any] = {":status": status, ":number": normalized_number, ":updatedBy": updated_by, ":statusUpdatedAt": status_at or utc_now()}
        if status == "DISPATCHED":
            update_expression += f", #loads[{row_index}].#dispatchedAt = :dispatchedAt"
            names["#dispatchedAt"] = "dispatchedAt"
            values[":dispatchedAt"] = values[":statusUpdatedAt"]
        updated = self._table.update_item(
            Key=key,
            UpdateExpression=update_expression,
            ConditionExpression=f"attribute_exists(pk) AND #loads[{row_index}].#number = :number",
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
            ReturnValues="ALL_NEW",
        )["Attributes"]
        current = updated["loads"][row_index]
        return {"number": normalized_number, "status": current["status"], "statusUpdatedAt": current.get("statusUpdatedAt"), "dispatchedAt": current.get("dispatchedAt")}

    def update_bulk_plan_hub_assignment(
        self, context: OperationalContext, spoke_number: str, hub_number: str | None, updated_by: str,
    ) -> dict[str, Any]:
        """Assign one hub-spoke DDU load to a linehaul in its exact section."""
        key = {"pk": build_markets_pk(context), "sk": build_bulk_plan_sk()}
        item = self._table.get_item(Key=key).get("Item")
        if not item or not isinstance(item.get("loads"), list):
            raise ValueError("The weekly Bulk Plan was not found.")
        loads = item["loads"]
        spoke_number = str(spoke_number or "").strip()
        hub_number = str(hub_number or "").strip() or None
        spoke_index = next((index for index, load in enumerate(loads) if isinstance(load, dict) and str(load.get("number") or "").strip() == spoke_number), None)
        if spoke_index is None:
            raise ValueError("The Hub Spoke load was not found.")
        spoke = loads[spoke_index]
        if spoke.get("routeRole") != "HUB_SPOKE":
            raise ValueError("Only Hub Spoke Delivery loads can be assigned to a hub trip.")
        if hub_number:
            hub = next((load for load in loads if isinstance(load, dict) and str(load.get("number") or "").strip() == hub_number), None)
            if not hub or hub.get("routeRole") != "HUB_LINEHAUL" or hub.get("routeGroup") != spoke.get("routeGroup"):
                raise ValueError("Choose a Hub Linehaul trip from the same Hub & Spoke section.")
        updated = self._table.update_item(
            Key=key,
            UpdateExpression=f"SET #loads[{spoke_index}].#assignedHubTrip = :hub, #loads[{spoke_index}].#updatedBy = :updatedBy",
            ConditionExpression=f"attribute_exists(pk) AND #loads[{spoke_index}].#number = :number",
            ExpressionAttributeNames={"#loads": "loads", "#assignedHubTrip": "assignedHubTrip", "#updatedBy": "updatedBy", "#number": "number"},
            ExpressionAttributeValues={":hub": hub_number, ":updatedBy": updated_by, ":number": spoke_number},
            ReturnValues="ALL_NEW",
        )["Attributes"]
        current = updated["loads"][spoke_index]
        return {"number": spoke_number, "assignedHubTrip": current.get("assignedHubTrip")}

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


def _scheduled_machine_zip_rows(item: dict[str, Any]) -> dict[tuple[str, str], dict[str, Any]]:
    """Read retained clerk-owned state keyed by source machine and ZIP."""
    rows_by_source: dict[tuple[str, str], dict[str, Any]] = {}
    for machine, rows in item.items():
        if machine in _MARKET_METADATA_FIELDS or not isinstance(rows, list):
            continue
        for row in rows:
            if isinstance(row, dict) and "zip" in row:
                scheduled = str(row.get("scheduledMachine") or machine)
                rows_by_source[(scheduled, str(row["zip"]))] = {**row, "machine": machine}
    return rows_by_source


def _flatten_market_records(items: list[dict[str, Any]], context: OperationalContext) -> list[dict[str, Any]]:
    """Convert compact market items into the API's ZIP-level read model."""
    records: list[dict[str, Any]] = []
    queue_order = 0
    for item in sorted(items, key=lambda value: str(value.get("sk", ""))):
        sk = str(item.get("sk", ""))
        if not sk.startswith("MARKET-"):
            continue
        area = sk.removeprefix("MARKET-")
        for machine in sorted(key for key, value in item.items() if key not in _MARKET_METADATA_FIELDS and isinstance(value, list)):
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
                    "scheduledMachine": str(row.get("scheduledMachine") or machine),
                    "movedAt": row.get("movedAt"),
                    "transferHistory": row.get("transferHistory") or [],
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


def _bulk_plan_loads(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    item = next((value for value in items if value.get("sk") == build_bulk_plan_sk()), {})
    loads = []
    for load in item.get("loads", []):
        if not isinstance(load, dict):
            continue
        value = dict(load)
        value["status"] = _normalized_shipping_status(value.get("status"))
        loads.append(value)
    return loads


def _normalized_shipping_status(value: object) -> str:
    """Render prior saved values using the current Shipping vocabulary."""
    legacy = str(value or "").upper()
    return {
        "PLANNED": "NOT_STARTED", "SCHEDULED": "NOT_STARTED", "READY": "NOT_STARTED",
        "IN_TRANSIT": "DISPATCHED", "DELIVERED": "DISPATCHED", "CANCELLED": "CLOSED",
    }.get(legacy, legacy or "NOT_STARTED")


def _merge_bulk_plan_loads(existing_loads: list[dict[str, Any]], incoming_loads: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return a load-number merge of an existing plan and one new workbook.

    ``number`` is the planner's trip/load identifier, not a display value.
    Existing records retain fields that do not originate in the workbook.  In
    particular, an operations user can later own ``status`` without an
    updated plan resetting it.  Workbook fields otherwise refresh so the
    schedule remains aligned with the latest Bulk Plan.
    """
    existing_by_number: dict[str, dict[str, Any]] = {}
    for load in existing_loads:
        if not isinstance(load, dict):
            continue
        load = dict(load)
        number = _bulk_plan_load_number(load)
        if number in existing_by_number:
            raise ValueError(f"The stored Bulk Plan has duplicate load number '{number}'.")
        existing_by_number[number] = load

    seen_incoming: set[str] = set()
    merged: list[dict[str, Any]] = []
    for incoming in incoming_loads:
        load = dict(incoming)
        number = _bulk_plan_load_number(load)
        if number in seen_incoming:
            raise ValueError(f"The uploaded Bulk Plan has duplicate load number '{number}'.")
        seen_incoming.add(number)
        current = existing_by_number.get(number)
        if current is None:
            merged.append(load)
            continue

        # A file refresh owns plan details.  Preserve dashboard fields until
        # the Shipping status/notes API is introduced.
        refreshed = {**current, **load}
        for field in ("status", "notes", "updatedBy", "updatedAt", "statusUpdatedAt", "dispatchedAt", "assignedHubTrip"):
            if field in current:
                refreshed[field] = current[field]
        merged.append(refreshed)

    # A full updated plan normally contains all active loads.  If a prior trip
    # is absent, retain it after the current workbook order for history rather
    # than silently deleting it.
    merged.extend(load for number, load in existing_by_number.items() if number not in seen_incoming)
    return merged


def _bulk_plan_load_number(load: dict[str, Any]) -> str:
    number = str(load.get("number") or "").strip()
    if not number:
        raise ValueError("Every Bulk Plan load must have a trip/load number.")
    return number


def _dynamo_values(value: Any) -> Any:
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {key: _dynamo_values(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_dynamo_values(item) for item in value]
    return value
