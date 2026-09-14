"""Bulk Plan workbook parser."""

from __future__ import annotations

from typing import Any

from parsers.common import number, text
from parsers.xlsx_reader import XlsxWorkbook


def parse_bulk_plan(contents: bytes, week: str) -> dict[str, list[dict[str, Any]]]:
    workbook = XlsxWorkbook(contents)
    detail_loads = _parse_data_sheet(workbook, week) if workbook.has_sheet("Data") else []
    grouped_loads = _parse_area_sheets(workbook, week, detail_loads)
    loads = grouped_loads or detail_loads or _parse_tabular_sheet(workbook, week)
    if not loads:
        raise ValueError("The Bulk Plan workbook contains no valid load rows.")
    return {"loads": loads}


def _parse_data_sheet(workbook: XlsxWorkbook, week: str) -> list[dict[str, Any]]:
    headers: list[str] = []
    seen: set[str] = set()
    loads: list[dict[str, Any]] = []
    for row in workbook.rows("Data"):
        if "Shipment ID" in row:
            headers = row
            continue
        if not headers:
            continue
        shipment = _column(row, headers, "Shipment ID")
        shipment_text = text(shipment)
        if not shipment_text or shipment_text.lower() == "shipment id" or shipment_text in seen:
            continue
        seen.add(shipment_text)
        loads.append(_load_from_values(week, {
            "shipmentId": shipment,
            "carrier": _column(row, headers, "Service Provider Name"),
            "equipment": _column(row, headers, "First Equipment Group ID"),
            "destination": _column(row, headers, "Destination Location Name"),
            "weight": _column(row, headers, "Total Gross Weight"),
            "stops": _column(row, headers, "Number of Stops"),
            "pickup": _column(row, headers, "Start Time"),
            "delivery": _column(row, headers, "End Time"),
            "sourceStatus": _source_status(row, headers),
        }))
    return loads


def _parse_area_sheets(workbook: XlsxWorkbook, week: str, detail_loads: list[dict[str, Any]]) -> list[dict[str, Any]]:
    detail_by_shipment = {load["number"]: load for load in detail_loads}
    grouped: list[dict[str, Any]] = []
    for sheet_name in workbook.sheet_names:
        area = _shipping_area(sheet_name)
        if not area:
            continue
        headers: list[str] = []
        section_lines: list[str] = []
        route_group = f"{area} direct loads"
        route_role = "DIRECT"
        linehaul_count = 0
        saw_linehaul = False
        for row in workbook.rows(sheet_name):
            if "Shipment ID" in row or "Shipment Number" in row:
                headers = row
                continue
            if not headers:
                continue
            shipment_column = _column_index(headers, "Shipment ID")
            if shipment_column < 0:
                shipment_column = _column_index(headers, "Shipment Number")
            shipment = _row_value(row, shipment_column)
            number_value = text(shipment)
            if not number_value or not number_value.isdigit():
                heading = text(_row_value(row, 0))
                if heading:
                    if heading.lower() == "shared":
                        route_group, route_role, section_lines, saw_linehaul, linehaul_count = (
                            "Shared direct delivery", "SHARED", [heading], False, 0
                        )
                    else:
                        section_lines = (section_lines + [heading])[-2:]
                        title = " - ".join(section_lines)
                        if "hub" in title.lower() and "spoke" in title.lower():
                            route_group, route_role, saw_linehaul, linehaul_count = title, "HUB_LINEHAUL", False, 0
                        elif not saw_linehaul:
                            route_group, route_role = title, "DIRECT"
                elif route_role == "HUB_LINEHAUL" and linehaul_count > 0:
                    route_role, saw_linehaul = "HUB_SPOKE", True
                continue

            destination = _column(row, headers, "Destination") or _column(row, headers, "Destination SCF")
            if route_role == "HUB_LINEHAUL" and "hub" not in text(destination).lower() and linehaul_count > 0:
                route_role, saw_linehaul = "HUB_SPOKE", True
            detail = detail_by_shipment.get(number_value)
            area_values = {
                "shipmentId": shipment,
                "carrier": _column(row, headers, "Carrier"),
                "equipment": _column(row, headers, "Equipment"),
                "destination": destination,
                "weight": _column(row, headers, "Weight"),
                "stops": _column(row, headers, "# of Stops"),
                "pickup": _column(row, headers, "Pick release") or _column(row, headers, "Pick Release"),
                "sourceStatus": _source_status(row, headers),
            }
            load = dict(detail) if detail else _load_from_values(week, area_values)
            if detail:
                _apply_area_sheet_overrides(load, area_values)
            load.update({
                "area": area,
                "routeGroup": route_group,
                "routeRole": route_role,
                "destinationType": _destination_type(destination, route_group),
            })
            grouped.append(load)
            if route_role == "HUB_LINEHAUL":
                linehaul_count += 1
    deduplicated: dict[str, dict[str, Any]] = {}
    for load in grouped:
        deduplicated.setdefault(load["id"], load)
    return list(deduplicated.values())


def _parse_tabular_sheet(workbook: XlsxWorkbook, week: str) -> list[dict[str, Any]]:
    required = {"Shipment ID", "Service Provider Name", "Destination Location Name"}
    for sheet_name in workbook.sheet_names:
        rows = list(workbook.rows(sheet_name))
        if not rows or not required.issubset(set(rows[0])):
            continue
        headers = rows[0]
        loads = []
        for row in rows[1:]:
            shipment = _column(row, headers, "Shipment ID")
            if text(shipment) and text(shipment).lower() != "shipment id":
                loads.append(_load_from_values(week, {
                    "shipmentId": shipment,
                    "carrier": _column(row, headers, "Service Provider Name"),
                    "equipment": _column(row, headers, "First Equipment Group ID"),
                    "destination": _column(row, headers, "Destination Location Name"),
                    "weight": _column(row, headers, "Total Gross Weight"),
                    "stops": _column(row, headers, "Number of Stops"),
                    "sourceStatus": _source_status(row, headers),
                }))
        if loads:
            return loads
    return []


def _load_from_values(week: str, values: dict[str, object]) -> dict[str, Any]:
    shipment = text(values["shipmentId"])
    destination = text(values.get("destination")) or "Unassigned destination"
    pickup = text(values.get("pickup"))
    delivery = text(values.get("delivery"))
    source_status = text(values.get("sourceStatus"))
    weight_pounds = int(number(values.get("weight")))
    return {
        "id": f"{week}-load-{shipment}",
        "week": week,
        "number": shipment,
        "carrier": text(values.get("carrier")) or "Unassigned carrier",
        "destination": destination,
        "destinationType": _destination_type(destination),
        "equipment": text(values.get("equipment")).replace("_", " ") or "Not specified",
        "weight": f"{weight_pounds:,} lb",
        "weightPounds": weight_pounds,
        "stops": int(number(values.get("stops"))),
        "pickup": pickup or "Bulk-plan schedule pending",
        "deliveryDate": delivery or None,
        # ``sourceStatus`` is the planner's Driver Signed/Pick Release Ready
        # value.  It is refreshed for every workbook version; dashboard
        # status is retained by the repository once a user changes it.
        "sourceStatus": source_status,
        "planState": _plan_state(source_status),
        "status": _load_status(source_status),
    }


def _shipping_area(sheet_name: str) -> str | None:
    name = sheet_name.lower()
    if "front" in name:
        return "FRONT_END"
    if "back" in name:
        return "BACK_END"
    if "solo" in name:
        return "SOLO"
    if "mmsi" in name:
        return "MMSI"
    if "prov" in name or "boston" in name:
        return "PROVIDENCE_BOSTON"
    return None


def _destination_type(destination: str, route_group: str = "") -> str:
    lowered = destination.lower()
    group = route_group.lower()
    if "pcd" in lowered:
        return "PCD"
    if "boston globe" in group and "ri nh ma" in group:
        return "SCF"
    return "HUB" if "hub" in lowered else "SCF" if "scf" in lowered else "DDU"


def _load_status(source_status: str) -> str:
    status = source_status.lower()
    if "close" in status or "cancel" in status:
        return "CLOSED"
    if "deliver" in status:
        return "DISPATCHED"
    if "in transit" in status or "in_transit" in status or "in-transit" in status:
        return "DISPATCHED"
    if "loaded" in status:
        return "LOADED"
    if "delay" in status:
        return "DELAYED"
    if any(marker in status for marker in ("issue", "declin")):
        return "DELAYED"
    if "stage" in status:
        return "STAGED"
    if "ready" in status or "accept" in status:
        return "NOT_STARTED"
    if "plan" in status:
        return "NOT_STARTED"
    return "NOT_STARTED"


def _plan_state(source_status: str) -> str:
    """Return whether a planner still considers the trip active."""
    status = source_status.lower()
    return "CLOSED" if "close" in status or "cancel" in status else "ACTIVE"


def _source_status(row: list[str], headers: list[str]) -> str:
    """Read the planner status, supporting the client's fixed header name."""
    explicit = _column(row, headers, "driver_signed/pick_release_ready")
    if explicit:
        return text(explicit)
    return " ".join(filter(None, [
        text(_column(row, headers, "Status")),
        text(_column(row, headers, "Status", 1)),
        text(_column(row, headers, "8125_Status")),
    ]))


def _apply_area_sheet_overrides(load: dict[str, Any], values: dict[str, object]) -> None:
    """Refresh detail data with an operational area sheet's nonblank values.

    Bulk Plans contain a Data detail sheet and operational Front End/Back End/
    Solo sheets.  Planners commonly correct carrier or equipment in the
    operational sheet before issuing a revised workbook.  Those corrections
    must win over a stale value in Data for the same trip.
    """
    carrier = text(values.get("carrier"))
    equipment = text(values.get("equipment"))
    destination = text(values.get("destination"))
    pickup = text(values.get("pickup"))
    source_status = text(values.get("sourceStatus"))
    if carrier:
        load["carrier"] = carrier
    if equipment:
        load["equipment"] = equipment.replace("_", " ")
    if destination:
        load["destination"] = destination
        load["destinationType"] = _destination_type(destination)
    if pickup:
        load["pickup"] = pickup

    weight = text(values.get("weight"))
    if weight:
        weight_pounds = int(number(weight))
        load["weightPounds"] = weight_pounds
        load["weight"] = f"{weight_pounds:,} lb"
    stops = text(values.get("stops"))
    if stops:
        load["stops"] = int(number(stops))
    if source_status:
        load["sourceStatus"] = source_status
        load["planState"] = _plan_state(source_status)
        load["status"] = _load_status(source_status)


def _column(row: list[str], headers: list[str], name: str, occurrence: int = 0) -> str:
    position = _column_index(headers, name, occurrence)
    return _row_value(row, position)


def _column_index(headers: list[str], name: str, occurrence: int = 0) -> int:
    matches = 0
    for index, value in enumerate(headers):
        if _header_name(value) == _header_name(name):
            if matches == occurrence:
                return index
            matches += 1
    return -1


def _header_name(value: object) -> str:
    return text(value).strip().lower().replace(" ", "_").replace("-", "_")


def _row_value(row: list[str], index: int) -> str:
    return row[index] if 0 <= index < len(row) else ""
