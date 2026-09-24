"""Production QA workbook parser."""

from __future__ import annotations

from typing import Any

from dynamodb.keys import production_record_id
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
        duplicate_occurrences: dict[tuple[str, str, str, str, str], int] = {}
        source_area = requested_area
        area_records = []
        for row in workbook.rows(sheet_name):
            if not row or not is_zip(_value(row, 0)) or number(_value(row, 1)) <= 0:
                continue
            machine = text(_value(row, 6)) or text(_value(row, 5)) or "Unassigned"
            # H01 is source-workbook data that is outside the OpsFlow workflow.
            if machine.strip().upper() == "H01":
                continue
            zip_value = format_zip(_value(row, 0))
            market = text(_value(row, 4)) or source_area
            job_number = text(_value(row, 3)) or None
            ir = text(_value(row, 2))
            identity = (source_area.upper(), zip_value.upper(), (job_number or "").upper(), market.upper(), ir.upper())
            occurrence = duplicate_occurrences.get(identity, 0) + 1
            duplicate_occurrences[identity] = occurrence
            record_id = production_record_id(
                area=source_area,
                zip_value=zip_value,
                job_number=job_number,
                market=market,
                ir=ir,
                occurrence=occurrence,
            )
            area_records.append({
                "id": record_id,
                "recordId": record_id,
                "week": week,
                "market": market,
                "sourceArea": source_area,
                "sourceSheet": sheet_name,
                "jobNumber": job_number,
                "machine": machine,
                "scheduledMachine": text(_value(row, 5)) or None,
                "zip": zip_value,
                "status": _status(_value(row, 7)),
                "sourceStatus": text(_value(row, 7)) or "Blank",
                "volume": int(number(_value(row, 1))),
                "ir": ir,
                "queueOrder": queue_order,
                "sourceOccurrence": occurrence,
            })
            queue_order += 1
        if area_records:
            affected_areas.append(source_area)
            records.extend(area_records)

    if not records:
        raise ValueError("No ZIP-level production rows were found. Check column A for ZIP/ATZ and column B for quantity.")

    return {
        "records": records,
        "queuePlan": _queue_plan(workbook),
        "affectedAreas": affected_areas,
    }


def _status(value: object) -> str:
    normalized = text(value).lower()
    if normalized == "done":
        return "COMPLETE"
    if normalized in {"hold", "short"}:
        return "BLOCKED"
    return "NOT_STARTED"


def _value(row: list[str], index: int) -> str:
    return row[index] if 0 <= index < len(row) else ""


def _queue_plan(workbook: XlsxWorkbook) -> dict[str, Any] | None:
    """Read the optional Crew Size sheet included with Production QA files."""
    if not workbook.has_sheet("Crew Size"):
        return None
    rows = list(workbook.rows("Crew Size"))
    if not rows:
        return None
    shift_hours = number(_value(rows[0], 1))
    header_index = next((index for index, row in enumerate(rows) if any(text(cell).strip().lower() == "machine" for cell in row)), None)
    if header_index is None or shift_hours <= 0:
        return None
    headers = {text(value).strip().lower(): index for index, value in enumerate(rows[header_index])}
    machine_column = headers.get("machine")
    packages_column = headers.get("expected packages")
    lhpt_column = headers.get("lhpt goal")
    if machine_column is None or packages_column is None or lhpt_column is None:
        return None
    machines = [
        {
            "machine": text(_value(row, machine_column)),
            "expectedPackages": int(number(_value(row, packages_column))),
            "lhptGoal": number(_value(row, lhpt_column)),
        }
        for row in rows[header_index + 1:]
        if text(_value(row, machine_column))
        and number(_value(row, packages_column)) > 0
        and number(_value(row, lhpt_column)) > 0
    ]
    return {"shiftHours": shift_hours, "machines": machines} if machines else None
