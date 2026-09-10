"""ZIP/TR projection mapping workbook parser."""

from __future__ import annotations

from typing import Any

from dynamodb.keys import projection_record_id
from parsers.common import mapping_area_from_filename, normalize_atz, text, whole_number
from parsers.xlsx_reader import XlsxWorkbook


def parse_projection(contents: bytes, week: str, file_name: str) -> dict[str, Any]:
    workbook = XlsxWorkbook(contents)
    requirements: dict[tuple[str, str, str], dict[str, Any]] = {}
    trips: set[str] = set()
    for sheet_name in workbook.sheet_names:
        rows = list(workbook.rows(sheet_name))
        header_index = next((
            index for index, row in enumerate(rows)
            if text(_value(row, 0)).lower() == "zip" and text(_value(row, 2)).lower() == "tr"
        ), -1)
        if header_index < 0:
            continue
        for row in rows[header_index + 1:]:
            atz = normalize_atz(_value(row, 0))
            trip = text(_value(row, 2))
            if not atz or not trip.isdigit():
                continue
            job_number = text(_value(row, 4))
            key = (trip, atz, job_number)
            trips.add(trip)
            current = requirements.get(key)
            if current:
                current["requiredHH"] += whole_number(_value(row, 5))
            else:
                source_area = mapping_area_from_filename(file_name)
                requirements[key] = {
                    "week": week,
                    "trip": trip,
                    "atz": atz,
                    "jobNumber": job_number,
                    "requiredHH": whole_number(_value(row, 5)),
                    "sourceArea": source_area,
                    "recordId": projection_record_id(
                        area=source_area,
                        trip=trip,
                        atz=atz,
                        job_number=job_number,
                    ),
                }
    if not requirements:
        raise ValueError("No ZIP/TR mappings were found. The workbook must have ZIP in column A and TR in column C.")
    return {"requirements": list(requirements.values()), "tripCount": len(trips)}


def _value(row: list[str], index: int) -> str:
    return row[index] if 0 <= index < len(row) else ""
