"""Production QA workbook parser."""

from __future__ import annotations

from typing import Any

from parsers.common import format_zip, is_zip, number, source_area_from_filename, text
from parsers.xlsx_reader import XlsxWorkbook


def parse_production(contents: bytes, week: str, file_name: str) -> dict[str, Any]:
    workbook = XlsxWorkbook(contents)
    requested_area = source_area_from_filename(file_name)
    if not requested_area:
        raise ValueError(
            "Production uploads must be named Zip List <AREA> Wk <week>.xlsx, for example Zip List FE Wk 36.xlsx."
        )
    if not workbook.sheet_names:
        raise ValueError("The production workbook must contain one worksheet.")

    # Production intake is one Zip List workbook per area and week. The file name
    # is authoritative; read only its first (and expected only) worksheet.
    selected_sheets = [workbook.sheet_names[0]]

    records: list[dict[str, Any]] = []
    affected_areas: list[str] = []
    for sheet_name in selected_sheets:
        queue_order = 0
        source_area = requested_area
        area_records = []
        for row in workbook.rows(sheet_name):
            if not row or not is_zip(_value(row, 0)) or number(_value(row, 1)) <= 0:
                continue
            area_records.append(
                {
                    "id": f"{week}-{source_area}-{queue_order}",
                    "week": week,
                    "market": text(_value(row, 4)) or source_area,
                    "sourceArea": source_area,
                    "sourceSheet": sheet_name,
                    "jobNumber": text(_value(row, 3)) or None,
                    "machine": text(_value(row, 6)) or text(_value(row, 5)) or "Unassigned",
                    "scheduledMachine": text(_value(row, 5)) or None,
                    "zip": format_zip(_value(row, 0)),
                    "status": _status(_value(row, 7)),
                    "sourceStatus": text(_value(row, 7)) or "Blank",
                    "volume": int(number(_value(row, 1))),
                    "ir": text(_value(row, 2)),
                    "queueOrder": queue_order,
                }
            )
            queue_order += 1
        if area_records:
            affected_areas.append(source_area)
            records.extend(area_records)

    if not records:
        raise ValueError("No ZIP-level production rows were found. Check column A for ZIP/ATZ and column B for quantity.")

    return {
        "records": records,
        "queuePlan": None,
        "affectedAreas": affected_areas,
    }


def _status(value: object) -> str:
    normalized = text(value).lower()
    if normalized == "done":
        return "COMPLETE"
    if normalized == "in process":
        return "IN_PROGRESS"
    if normalized in {"hold", "short"}:
        return "BLOCKED"
    return "NOT_STARTED"


def _value(row: list[str], index: int) -> str:
    return row[index] if 0 <= index < len(row) else ""
