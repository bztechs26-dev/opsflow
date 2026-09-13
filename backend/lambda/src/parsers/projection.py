"""ZIP/TR projection mapping workbook parser."""

from __future__ import annotations

from typing import Any

from parsers.common import normalize_atz, projection_market_from_filename, text
from parsers.xlsx_reader import XlsxWorkbook


def parse_projection(contents: bytes, week: str, file_name: str) -> dict[str, Any]:
    workbook = XlsxWorkbook(contents)
    mappings: dict[str, set[str]] = {}
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
            mappings.setdefault(trip, set()).add(atz)
    if not mappings:
        raise ValueError("No ZIP/TR mappings were found. The workbook must have ZIP in column A and TR in column C.")
    # Projection deliberately retains only the two source values needed for
    # readiness matching. Workbook name, color, and unrelated columns are not
    # part of the data model.
    return {"market": projection_market_from_filename(file_name), "mappings": {trip: sorted(zips) for trip, zips in mappings.items()}, "tripCount": len(mappings)}


def _value(row: list[str], index: int) -> str:
    return row[index] if 0 <= index < len(row) else ""
