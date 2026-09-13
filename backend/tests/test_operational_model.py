"""Architecture tests for the OpsFlow DynamoDB weekly operational model."""

from __future__ import annotations

import sys
from pathlib import Path
import unittest


BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
LAMBDA_SOURCE = BACKEND / "lambda" / "src"
sys.path.insert(0, str(LAMBDA_SOURCE))

from dynamodb.keys import (
    OperationalContext,
    build_load_sk,
    build_bulk_plan_sk,
    build_projection_mappings_sk,
    build_market_sk,
    build_markets_pk,
    build_weeks_control_key,
    build_production_sk,
    build_projection_sk,
    build_week_pk,
    production_record_id,
)
from parsers.projection import _projection_zip
from dynamodb.operational_repository import OperationalRepository, _bulk_plan_loads, _flatten_market_records
from parsers.bulk_plan import _apply_area_sheet_overrides, _column_index, _load_from_values


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
        names = kwargs.get("ExpressionAttributeNames", {})
        machine = names.get("#machine")
        if machine:
            row_index = int(kwargs["UpdateExpression"].split("[")[1].split("]")[0])
            item[machine][row_index]["status"] = values[":status"]
        elif "#loads" in names:
            row_index = int(kwargs["UpdateExpression"].split("[")[1].split("]")[0])
            if ":status" in values:
                item["loads"][row_index]["status"] = values[":status"]
            if ":hub" in values:
                item["loads"][row_index]["assignedHubTrip"] = values[":hub"]
            item["loads"][row_index]["updatedBy"] = values[":updatedBy"]
            if ":dispatchedAt" in values:
                item["loads"][row_index]["dispatchedAt"] = values[":dispatchedAt"]
        else:
            item.update({"status": values[":status"]})
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
        key = {"pk": build_markets_pk(self.week_36), "sk": build_market_sk("FE")}
        table.put_item(Item={**key, "A01": [{"zip": "07044", "status": None}, {"zip": "07045", "status": None}]})
        repo.update_production_status(self.week_36, "FE", "A01~07045", "COMPLETE", "user-1", 1)
        self.assertEqual(table.items[(key["pk"], key["sk"])]["A01"][0]["status"], None)
        self.assertEqual(table.items[(key["pk"], key["sk"])]["A01"][1]["status"], "COMPLETE")
        self.assertIn("attribute_exists(pk)", table.last_update["ConditionExpression"])
        self.assertIn("#machine[1].#zip", table.last_update["ConditionExpression"])

    def test_missing_status_update_cannot_create_a_record(self) -> None:
        table = FakeTable()
        repo = OperationalRepository(table=table)
        with self.assertRaises(ValueError):
            repo.update_production_status(self.week_36, "FE", "A01~07045", "COMPLETE", "user-1", 1)
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
        self.assertEqual(item["sk"], "MARKET-FE")
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

    def test_compact_market_item_flattens_only_for_the_api_response(self) -> None:
        records = _flatten_market_records([{
            "pk": "2026-36", "sk": "MARKET-FE",
            "A01": [{"zip": "07045", "qty": 3959, "ir": "6:1", "job": "1081908", "market": "NNJ NSL", "status": None}],
        }], self.week_36)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["recordId"], "A01~07045")
        self.assertEqual(records[0]["sourceArea"], "FE")
        self.assertEqual(records[0]["status"], "NOT_STARTED")

    def test_bulk_plan_is_independent_from_production_markets(self) -> None:
        table = FakeTable()
        repo = OperationalRepository(table=table)
        repo._upsert_market_area(self.week_36, [{
            "sourceArea": "FE", "machine": "A01", "zip": "07045", "volume": 100,
            "ir": "6:1", "jobNumber": "1081908", "market": "NNJ NSL",
        }])
        repo._upsert_bulk_plan(self.week_36, [{"id": "36-load-100", "number": "100", "area": "FRONT_END"}])
        production = table.items[("2026-36", "MARKET-FE")]
        bulk_plan = table.items[("2026-36", build_bulk_plan_sk())]
        self.assertEqual(production["A01"][0]["zip"], "07045")
        self.assertNotIn("loads", production)
        self.assertEqual(bulk_plan["loads"][0]["number"], "100")
        self.assertEqual(_bulk_plan_loads([production, bulk_plan])[0]["number"], "100")

    def test_projection_is_one_compact_trip_to_zip_map(self) -> None:
        table = FakeTable()
        repo = OperationalRepository(table=table)
        count = repo._upsert_projection_mappings(self.week_36, "FE", {
            "4561886": ["21009C1", "21014B1", "21009C1"],
            "4561892": ["21146C1"],
        })
        item = table.items[("2026-36", build_projection_mappings_sk("FE"))]
        self.assertEqual(count, 3)
        self.assertEqual(item["mappings"], {
            "4561886": ["21009C1", "21014B1"],
            "4561892": ["21146C1"],
        })
        self.assertEqual(repo.projection_mappings(self.week_36), [{
            "market": "FE", "productionSourceArea": "FE", "productionSourceWeek": 36,
            "mappings": item["mappings"],
        }])
        self.assertNotIn("entityType", item)

    def test_projection_markets_are_retained_as_separate_items(self) -> None:
        table = FakeTable()
        repo = OperationalRepository(table=table)
        repo._upsert_projection_mappings(self.week_36, "FE", {"100": ["07045"]})
        repo._upsert_projection_mappings(self.week_36, "BE", {"200": ["07101"]})
        repo._upsert_projection_mappings(self.week_36, "PROV-BOST", {"300": ["02108"]})
        self.assertEqual(len(repo.projection_mappings(self.week_36)), 3)
        self.assertEqual(table.items[("2026-36", build_projection_mappings_sk("FE"))]["mappings"], {"100": ["07045"]})
        self.assertEqual(table.items[("2026-36", build_projection_mappings_sk("BE"))]["mappings"], {"200": ["07101"]})
        boston = table.items[("2026-36", build_projection_mappings_sk("PROV-BOST"))]
        self.assertEqual(boston["productionSourceWeek"], 36)
        repo._upsert_projection_mappings(self.week_36, "FE", {"101": ["07046"]})
        self.assertEqual(table.items[("2026-36", build_projection_mappings_sk("FE"))]["mappings"], {"100": ["07045"], "101": ["07046"]})

    def test_projection_zip_padding_preserves_leading_zeroes(self) -> None:
        self.assertEqual(_projection_zip("2113"), "02113")
        self.assertEqual(_projection_zip("2114B1"), "02114B1")

    def test_bulk_plan_reimport_updates_trip_details_and_adds_only_new_trips(self) -> None:
        table = FakeTable()
        repo = OperationalRepository(table=table)
        repo._upsert_bulk_plan(self.week_36, [{
            "id": "36-load-100", "number": "100", "carrier": "West Michigan", "stops": 8,
            "status": "READY", "destination": "Boston",
        }])
        item_key = ("2026-36", build_bulk_plan_sk())
        table.items[item_key]["loads"][0]["status"] = "LOADED"
        table.items[item_key]["loads"][0]["notes"] = "Dock appointment confirmed"

        repo._upsert_bulk_plan(self.week_36, [
            {"id": "36-load-100", "number": "100", "carrier": "Ryder", "stops": 4, "status": "READY", "destination": "Boston"},
            {"id": "36-load-101", "number": "101", "carrier": "Ryder", "stops": 4, "status": "READY", "destination": "Boston"},
        ])

        loads = table.items[item_key]["loads"]
        self.assertEqual(len(loads), 2)
        original = next(load for load in loads if load["number"] == "100")
        self.assertEqual(original["carrier"], "Ryder")
        self.assertEqual(original["stops"], 4)
        self.assertEqual(original["status"], "LOADED")
        self.assertEqual(original["notes"], "Dock appointment confirmed")
        self.assertEqual(next(load for load in loads if load["number"] == "101")["stops"], 4)

    def test_bulk_plan_status_update_targets_one_exact_trip(self) -> None:
        table = FakeTable()
        repo = OperationalRepository(table=table)
        repo._upsert_bulk_plan(self.week_36, [
            {"id": "36-load-100", "number": "100", "carrier": "Ryder", "stops": 4, "status": "READY"},
            {"id": "36-load-101", "number": "101", "carrier": "Ryder", "stops": 4, "status": "READY"},
        ])
        updated = repo.update_bulk_plan_status(self.week_36, "101", "DISPATCHED", "user-1")
        loads = table.items[("2026-36", build_bulk_plan_sk())]["loads"]
        self.assertEqual(updated["number"], "101")
        self.assertEqual(updated["status"], "DISPATCHED")
        self.assertIsNotNone(updated["dispatchedAt"])
        self.assertEqual(loads[0]["status"], "READY")
        self.assertEqual(loads[1]["status"], "DISPATCHED")
        self.assertEqual(loads[1]["updatedBy"], "user-1")

    def test_hub_assignment_is_limited_to_the_same_hub_spoke_section(self) -> None:
        table = FakeTable()
        repo = OperationalRepository(table=table)
        repo._upsert_bulk_plan(self.week_36, [
            {"id": "36-load-boston-hub", "number": "100", "routeGroup": "Boston Hub", "routeRole": "HUB_LINEHAUL"},
            {"id": "36-load-nj-hub", "number": "200", "routeGroup": "NJ Hub", "routeRole": "HUB_LINEHAUL"},
            {"id": "36-load-boston-ddu", "number": "101", "routeGroup": "Boston Hub", "routeRole": "HUB_SPOKE"},
            {"id": "36-load-shared-ddu", "number": "300", "routeGroup": "Shared", "routeRole": "SHARED"},
        ])
        updated = repo.update_bulk_plan_hub_assignment(self.week_36, "101", "100", "scheduler")
        self.assertEqual(updated["assignedHubTrip"], "100")
        with self.assertRaises(ValueError):
            repo.update_bulk_plan_hub_assignment(self.week_36, "101", "200", "scheduler")
        with self.assertRaises(ValueError):
            repo.update_bulk_plan_hub_assignment(self.week_36, "300", "100", "scheduler")

    def test_bulk_plan_reimport_preserves_hub_assignment(self) -> None:
        table = FakeTable()
        repo = OperationalRepository(table=table)
        repo._upsert_bulk_plan(self.week_36, [
            {"id": "36-load-hub", "number": "100", "routeGroup": "Boston Hub", "routeRole": "HUB_LINEHAUL"},
            {"id": "36-load-ddu", "number": "101", "routeGroup": "Boston Hub", "routeRole": "HUB_SPOKE"},
        ])
        repo.update_bulk_plan_hub_assignment(self.week_36, "101", "100", "scheduler")
        repo._upsert_bulk_plan(self.week_36, [
            {"id": "36-load-hub", "number": "100", "routeGroup": "Boston Hub", "routeRole": "HUB_LINEHAUL"},
            {"id": "36-load-ddu", "number": "101", "routeGroup": "Boston Hub", "routeRole": "HUB_SPOKE", "carrier": "Ryder"},
        ])
        loads = table.items[("2026-36", build_bulk_plan_sk())]["loads"]
        self.assertEqual(next(load for load in loads if load["number"] == "101")["assignedHubTrip"], "100")

    def test_bulk_plan_reimport_uses_latest_workbook_section_order(self) -> None:
        table = FakeTable()
        repo = OperationalRepository(table=table)
        repo._upsert_bulk_plan(self.week_36, [
            {"id": "36-load-100", "number": "100", "routeGroup": "Boston Hub", "status": "READY"},
            {"id": "36-load-200", "number": "200", "routeGroup": "Front End", "status": "READY"},
        ])
        repo._upsert_bulk_plan(self.week_36, [
            {"id": "36-load-200", "number": "200", "routeGroup": "Front End", "status": "READY"},
            {"id": "36-load-101", "number": "101", "routeGroup": "Boston Hub", "status": "READY"},
            {"id": "36-load-100", "number": "100", "routeGroup": "Boston Hub", "status": "READY"},
        ])
        loads = table.items[("2026-36", build_bulk_plan_sk())]["loads"]
        self.assertEqual([load["number"] for load in loads], ["200", "101", "100"])

    def test_bulk_plan_reads_driver_signed_pick_release_and_keeps_closed_trip_static(self) -> None:
        headers = ["Shipment ID", "Driver Signed/Pick Release Ready"]
        self.assertEqual(_column_index(headers, "driver_signed/pick_release_ready"), 1)
        closed = _load_from_values("36", {
            "shipmentId": "100", "carrier": "Ryder", "destination": "Boston", "equipment": "53FT",
            "weight": "10", "stops": "4", "sourceStatus": "Closed",
        })
        self.assertEqual(closed["sourceStatus"], "Closed")
        self.assertEqual(closed["planState"], "CLOSED")
        self.assertEqual(closed["status"], "CLOSED")

    def test_bulk_plan_area_sheet_overrides_stale_data_sheet_details(self) -> None:
        load = _load_from_values("36", {
            "shipmentId": "100", "carrier": "Ryder", "destination": "Boston", "equipment": "53FT",
            "weight": "10", "stops": "8", "sourceStatus": "Ready",
        })
        _apply_area_sheet_overrides(load, {
            "carrier": "Delivery Now", "equipment": "45FT", "destination": "Boston", "weight": "10",
            "stops": "8", "pickup": "", "sourceStatus": "Ready",
        })
        self.assertEqual(load["carrier"], "Delivery Now")
        self.assertEqual(load["equipment"], "45FT")

    def test_week_control_is_one_compact_item(self) -> None:
        table = FakeTable()
        repo = OperationalRepository(table=table)
        repo._register_week(self.week_36)
        repo._register_week(OperationalContext("opsflow-dev", 2026, 39))
        key = build_weeks_control_key()
        self.assertEqual(table.items[key], {"pk": "CONTROL", "sk": "WEEKS", "weeks": ["2026-36", "2026-39"]})


if __name__ == "__main__":
    unittest.main()
