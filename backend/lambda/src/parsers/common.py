"""Shared parser helpers and stable operation identifiers."""

from __future__ import annotations

import re


WEEK_PATTERN = re.compile(r"\b(?:wk|week)\b[.\s_-]*(\d{1,2})\b", re.IGNORECASE)
ZIP_LIST_AREA_PATTERN = re.compile(
    r"\bzip\s+list\s+([A-Za-z][A-Za-z0-9_-]*)\s+(?:wk|week)\b",
    re.IGNORECASE,
)
ZIP_PATTERN = re.compile(r"^\d{3,5}(?:\s+[A-Za-z](?:\d+)?)?$")
ZIP_KEY_PATTERN = re.compile(r"^\d{5}(?:[A-Z](?:\d+)?)?$")


def text(value: object) -> str:
    return str(value or "").strip()


def number(value: object) -> float:
    try:
        return float(text(value).replace(",", ""))
    except ValueError:
        return 0.0


def whole_number(value: object) -> int:
    return int(round(number(value)))


def week_from_filename(file_name: str) -> str:
    match = WEEK_PATTERN.search(file_name)
    if not match:
        raise ValueError("The filename must include a week number, for example Zip List FE Wk 36.xlsx.")
    return match.group(1)


def normalize_atz(value: object) -> str:
    return re.sub(r"[^A-Z0-9]", "", text(value).upper())


def zip_key(value: object) -> str:
    normalized = re.sub(r"\s+", "", text(value).upper())
    return normalized if ZIP_KEY_PATTERN.fullmatch(normalized) else ""


def is_zip(value: object) -> bool:
    return bool(ZIP_PATTERN.fullmatch(text(value)))


def format_zip(value: object) -> str:
    parts = text(value).split()
    if not parts:
        return ""
    return f"{parts[0].zfill(5)}{' ' + parts[1] if len(parts) > 1 else ''}"


def source_area_from_filename(file_name: str) -> str | None:
    zip_list_match = ZIP_LIST_AREA_PATTERN.search(file_name)
    if zip_list_match:
        return zip_list_match.group(1).upper().replace("_", "-")

    name = file_name.lower()
    if "mmsi" in name:
        return "MMSI"
    if any(marker in name for marker in ("bost", "prov", "hart")):
        return "PROV-BOST"
    if re.search(r"\bbe\b", name):
        return "BE"
    if re.search(r"\bfe\b", name):
        return "FE"
    return None


def mapping_area_from_filename(file_name: str) -> str:
    name = file_name.upper()
    if re.search(r"\b(?:BE|BACK[ _-]?END)\b", name):
        return "BACK_END"
    if re.search(r"\b(?:FE|FRONT[ _-]?END)\b", name):
        return "FRONT_END"
    if "MMSI" in name:
        return "MMSI"
    if re.search(r"\b(?:BOST|BOS|PROV|HART)\b", name):
        return "PROVIDENCE_BOSTON"
    return "UNASSIGNED"
