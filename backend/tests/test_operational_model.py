"""Architecture tests for the OpsFlow DynamoDB weekly operational model."""

from __future__ import annotations

import sys
from pathlib import Path
import unittest


BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from dynamodb.keys import (
    OperationalContext,
    build_load_sk,
    build_market_sk,
    build_markets_pk,
    build_weeks_control_key,
    build_production_sk,
    build_projection_sk,
    build_week_pk,
    production_record_id,
)
from dynamodb.operational_repository import OperationalRepository


class FakeTable:
    def __init__(self) -> None:
        self.items: dict[tuple[str, str], dict] = {}
        self.last_update: dict | None = None

    def get_item(self, *, Key: dict) -> dict:
        item = self.items.get((Key["pk"], Key["sk"]))
        return {"Item": dict(item)} if item else {}

    def put_item(self, *, Item: dict, **_: object) -> dict:
        self.items[(Item["pk"], Item["sk"])] = dict(Item)
        return {}

    def update_item(self, **kwargs: object) -> dict:
        self.last_update = kwargs
        key = kwargs["Key"]
        item = self.items.get((key["pk"], key["sk"]))
        if item is None:
            raise ConditionalFailure()
        values = kwargs["ExpressionAttributeValues"]
        item.update({"status": values[":status"], "version": values[":next_version"], "updatedBy": values[":updated_by"]})
        self.items[(key["pk"], key["sk"])] = item
        return {"Attributes": item}


class ConditionalFailure(Exception):
    response = {"Error": {"Code": "ConditionalCheckFailedException"}}


class OperationalKeyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.week_36 = OperationalContext("opsflow-dev", 2026, 36)

    def test_week_36_and_week_39_are_isolated(self) -> None:
        self.assertNotEqual(build_week_pk(self.week_36), build_week_pk(OperationalContext("opsflow-dev", 2026, 39)))

    def test_same_week_number_in_another_year_is_isolated(self) -> None:
        self.assertNotEqual(build_week_pk(self.week_36), build_week_pk(OperationalContext("opsflow-dev", 2027, 36)))

    def test_areas_do_not_collide(self) -> None:
        self.assertNotEqual(build_production_sk("FE", "PR-1"), build_production_sk("BE", "PR-1"))

    def test_entity_types_do_not_collide(self) -> None:
        self.assertNotEqual(build_production_sk("FE", "PR-1"), build_projection_sk("FE", "PR-1"))
        self.assertNotEqual(build_production_sk("FE", "PR-1"), build_load_sk("5600012"))

    def test_two_rows_with_same_zip_do_not_collide(self) -> None:
        first = production_record_id(area="FE", zip_value="19720", job_number="100", market="FE", ir="A", occurrence=1)
        second = production_record_id(area="FE", zip_value="19720", job_number="200", market="FE", ir="A", occurrence=1)
        duplicate = production_record_id(area="FE", zip_value="19720", job_number="100", market="FE", ir="A", occurrence=2)
        self.assertNotEqual(first, second)
        self.assertNotEqual(first, duplicate)

    def test_same_source_row_has_stable_deterministic_id(self) -> None:
        arguments = {"area": "FE", "zip_value": "19720", "job_number": "100", "market": "FE", "ir": "A", "occurrence": 1}
        self.assertEqual(production_record_id(**arguments), production_record_id(**arguments))

    def test_status_update_targets_only_exact_week_and_record(self) -> None:
        table = FakeTable()
        repo = OperationalRepository(table=table)
        record_id = "PR-EXACT"
        key = {"pk": build_week_pk(self.week_36), "sk": build_production_sk("FE", record_id)}
        table.put_item(Item={**key, "entityType": "PRODUCTION", "recordId": record_id, "status": "NOT_STARTED", "version": 1})
        repo.update_production_status(self.week_36, "FE", record_id, "COMPLETE", "user-1", 1)
        self.assertEqual(table.items[(key["pk"], key["sk"])]["status"], "COMPLETE")
        self.assertIn("attribute_exists(pk)", table.last_update["ConditionExpression"])
        self.assertIn("recordId = :record_id", table.last_update["ConditionExpression"])

    def test_missing_status_update_cannot_create_a_record(self) -> None:
        table = FakeTable()
        repo = OperationalRepository(table=table)
        with self.assertRaises(ConditionalFailure):
            repo.update_production_status(self.week_36, "FE", "PR-MISSING", "COMPLETE", "user-1", 1)
        self.assertEqual(table.items, {})

    def test_reimport_preserves_user_status(self) -> None:
        table = FakeTable()
        repo = OperationalRepository(table=table)
        record = {
            "id": "PR-ROW", "recordId": "PR-ROW", "sourceArea": "FE", "zip": "19720", "market": "FE",
            "jobNumber": "100", "machine": "A01", "scheduledMachine": "A01", "sourceStatus": "Blank",
            "status": "NOT_STARTED", "volume": 100, "ir": "A", "queueOrder": 0, "sourceOccurrence": 1,
        }
        repo._upsert_production(self.week_36, record, "import-1", "inbox/source.xlsx")
        key = (build_week_pk(self.week_36), build_production_sk("FE", "PR-ROW"))
        table.items[key]["status"] = "COMPLETE"
        changed_source = {**record, "volume": 125, "status": "NOT_STARTED"}
        repo._upsert_production(self.week_36, changed_source, "import-2", "inbox/corrected.xlsx")
        self.assertEqual(table.items[key]["status"], "COMPLETE")
        self.assertEqual(table.items[key]["volume"], 125)

    def test_production_area_is_grouped_by_machine_in_one_item(self) -> None:
        table = FakeTable()
        repo = OperationalRepository(table=table)
        records = [
            {"sourceArea": "FE", "machine": "A01", "zip": "07960 F1", "volume": 100, "ir": "6:1", "jobNumber": "1082234", "market": "NNJ NSL"},
            {"sourceArea": "FE", "machine": "A01", "zip": "07960 B1", "volume": 125, "ir": "5:1", "jobNumber": "1082234", "market": "NNJ NSL"},
            {"sourceArea": "FE", "machine": "A02", "zip": "08831 F1", "volume": 50, "ir": "2:1", "jobNumber": "1082235", "market": "NNJ NSL"},
        ]
        repo._upsert_market_area(self.week_36, records)
        item = table.items[(build_markets_pk(self.week_36), build_market_sk("FE"))]
        self.assertEqual(item["pk"], "2026-36")
        self.assertEqual(item["sk"], "MARKETS#FE")
        self.assertEqual([row["zip"] for row in item["A01"]], ["07960 F1", "07960 B1"])
        self.assertEqual(item["A02"][0]["qty"], 50)
        self.assertIsNone(item["A01"][0]["status"])

    def test_reimport_preserves_machine_zip_status(self) -> None:
        table = FakeTable()
        repo = OperationalRepository(table=table)
        records = [{"sourceArea": "FE", "machine": "A01", "zip": "07960 F1", "volume": 100, "ir": "6:1", "jobNumber": "1082234", "market": "NNJ NSL"}]
        repo._upsert_market_area(self.week_36, records)
        item = table.items[(build_markets_pk(self.week_36), build_market_sk("FE"))]
        item["A01"][0]["status"] = "COMPLETE"
        repo._upsert_market_area(self.week_36, [{**records[0], "volume": 125}])
        updated = table.items[(build_markets_pk(self.week_36), build_market_sk("FE"))]
        self.assertEqual(updated["A01"][0]["status"], "COMPLETE")
        self.assertEqual(updated["A01"][0]["qty"], 125)

    def test_week_control_is_one_compact_item(self) -> None:
        table = FakeTable()
        repo = OperationalRepository(table=table)
        repo._register_week(self.week_36)
        repo._register_week(OperationalContext("opsflow-dev", 2026, 39))
        key = build_weeks_control_key()
        self.assertEqual(table.items[key], {"pk": "CONTROL", "sk": "WEEKS", "weeks": ["2026-36", "2026-39"]})


if __name__ == "__main__":
    unittest.main()
