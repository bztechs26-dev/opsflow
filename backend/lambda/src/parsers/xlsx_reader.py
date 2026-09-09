"""Small XLSX reader for the fixed OpsFlow import formats.

The Lambda only needs worksheet values, not formula evaluation, formatting, or
Excel editing.  Keeping this reader on the Python standard library avoids a
third-party Lambda layer solely to parse the supported workbooks.
"""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from pathlib import PurePosixPath
import re
from typing import Iterator
from xml.etree import ElementTree
from zipfile import ZipFile


MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"m": MAIN_NS, "r": DOC_REL_NS, "p": PACKAGE_REL_NS}
CELL_REFERENCE = re.compile(r"([A-Z]+)(\d+)$")


class WorkbookFormatError(ValueError):
    """Raised when an upload is not a readable Excel workbook."""


@dataclass(frozen=True)
class Worksheet:
    name: str
    path: str


class XlsxWorkbook:
    """Read cell values from an XLSX workbook without external dependencies."""

    def __init__(self, contents: bytes):
        try:
            self._archive = ZipFile(BytesIO(contents))
            self._shared_strings = self._read_shared_strings()
            self._worksheets = self._read_worksheets()
        except Exception as error:  # zip/xml details do not help an operations user.
            raise WorkbookFormatError("The uploaded file is not a readable .xlsx workbook.") from error

    @property
    def sheet_names(self) -> list[str]:
        return [sheet.name for sheet in self._worksheets]

    def has_sheet(self, name: str) -> bool:
        return any(sheet.name == name for sheet in self._worksheets)

    def rows(self, sheet_name: str) -> Iterator[list[str]]:
        worksheet = next((item for item in self._worksheets if item.name == sheet_name), None)
        if worksheet is None:
            raise WorkbookFormatError(f"Worksheet '{sheet_name}' was not found.")

        root = ElementTree.fromstring(self._archive.read(worksheet.path))
        for row in root.findall(".//m:sheetData/m:row", NS):
            cells: dict[int, str] = {}
            max_column = -1
            for cell in row.findall("m:c", NS):
                reference = cell.attrib.get("r", "")
                match = CELL_REFERENCE.match(reference)
                if not match:
                    continue
                column_index = _column_index(match.group(1))
                cells[column_index] = self._cell_value(cell)
                max_column = max(max_column, column_index)
            if max_column >= 0:
                yield [cells.get(index, "") for index in range(max_column + 1)]

    def cell(self, sheet_name: str, reference: str) -> str:
        match = CELL_REFERENCE.match(reference.upper())
        if not match:
            raise ValueError(f"Invalid Excel cell reference: {reference}")
        target_column = _column_index(match.group(1))
        target_row = int(match.group(2))
        for row_index, row in enumerate(self.rows(sheet_name), start=1):
            if row_index == target_row:
                return row[target_column] if target_column < len(row) else ""
        return ""

    def _read_shared_strings(self) -> list[str]:
        if "xl/sharedStrings.xml" not in self._archive.namelist():
            return []
        root = ElementTree.fromstring(self._archive.read("xl/sharedStrings.xml"))
        return ["".join(element.text or "" for element in item.findall(".//m:t", NS)) for item in root.findall("m:si", NS)]

    def _read_worksheets(self) -> list[Worksheet]:
        workbook = ElementTree.fromstring(self._archive.read("xl/workbook.xml"))
        relationships = ElementTree.fromstring(self._archive.read("xl/_rels/workbook.xml.rels"))
        targets = {
            item.attrib["Id"]: item.attrib["Target"]
            for item in relationships.findall("p:Relationship", NS)
        }
        sheets: list[Worksheet] = []
        for sheet in workbook.findall("m:sheets/m:sheet", NS):
            relation_id = sheet.attrib.get(f"{{{DOC_REL_NS}}}id", "")
            target = targets.get(relation_id)
            if target:
                sheets.append(Worksheet(sheet.attrib["name"], _workbook_target(target)))
        return sheets

    def _cell_value(self, cell: ElementTree.Element) -> str:
        cell_type = cell.attrib.get("t", "")
        if cell_type == "inlineStr":
            return "".join(element.text or "" for element in cell.findall(".//m:t", NS)).strip()
        value = cell.findtext("m:v", default="", namespaces=NS)
        if cell_type == "s":
            try:
                return self._shared_strings[int(value)].strip()
            except (IndexError, ValueError):
                return ""
        return value.strip()


def _workbook_target(target: str) -> str:
    clean_target = target.lstrip("/")
    if clean_target.startswith("xl/"):
        return clean_target
    return str(PurePosixPath("xl") / clean_target)


def _column_index(column: str) -> int:
    value = 0
    for character in column:
        value = value * 26 + ord(character) - ord("A") + 1
    return value - 1
