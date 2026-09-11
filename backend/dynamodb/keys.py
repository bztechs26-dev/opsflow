"""Validated, centralized DynamoDB keys for OpsFlow operational data.

The project uses *operational* week numbers.  A caller must always supply the
year; this module never guesses a year from the current date.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass


_IDENTIFIER = re.compile(r"^[A-Z0-9][A-Z0-9_-]{0,63}$")
_RECORD_IDENTIFIER = re.compile(r"^[A-Z0-9][A-Z0-9_-]{0,127}$")


@dataclass(frozen=True)
class OperationalContext:
    """The immutable context that isolates a tenant's weekly operations."""

    organization_id: str
    year: int
    week: int

    def __post_init__(self) -> None:
        object.__setattr__(self, "organization_id", normalize_organization_id(self.organization_id))
        object.__setattr__(self, "year", validate_year(self.year))
        object.__setattr__(self, "week", validate_week(self.week))


def normalize_organization_id(value: str) -> str:
    normalized = str(value or "").strip().upper().replace(" ", "-")
    if not _IDENTIFIER.fullmatch(normalized):
        raise ValueError("organizationId must contain 1-64 letters, numbers, hyphens, or underscores.")
    return normalized


def normalize_area(value: str) -> str:
    normalized = str(value or "").strip().upper().replace(" ", "-")
    if not _IDENTIFIER.fullmatch(normalized):
        raise ValueError("area must contain 1-64 letters, numbers, hyphens, or underscores.")
    return normalized


def normalize_record_id(value: str) -> str:
    normalized = str(value or "").strip().upper()
    if not _RECORD_IDENTIFIER.fullmatch(normalized):
        raise ValueError("recordId must contain 1-128 letters, numbers, hyphens, or underscores.")
    return normalized


def validate_year(value: int | str) -> int:
    try:
        year = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError("operationalYear must be a four-digit year.") from error
    if not 2000 <= year <= 2100:
        raise ValueError("operationalYear must be between 2000 and 2100.")
    return year


def validate_week(value: int | str) -> int:
    try:
        week = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError("operational week must be a number between 1 and 53.") from error
    if not 1 <= week <= 53:
        raise ValueError("operational week must be between 1 and 53.")
    return week


def build_week_pk(context: OperationalContext) -> str:
    return f"ORG#{context.organization_id}#YEAR#{context.year}#WEEK#{context.week:02d}"


def build_year_control_pk(organization_id: str, year: int | str) -> str:
    return f"ORG#{normalize_organization_id(organization_id)}#YEAR#{validate_year(year)}#CONTROL"


def build_import_lookup_pk(organization_id: str, import_id: str) -> str:
    """A narrow lookup partition used by the authenticated upload-progress API."""
    return f"ORG#{normalize_organization_id(organization_id)}#IMPORT#{normalize_record_id(import_id)}"


def build_production_sk(area: str, record_id: str) -> str:
    return f"PRODUCTION#{normalize_area(area)}#{normalize_record_id(record_id)}"


def build_projection_sk(area: str, record_id: str) -> str:
    return f"PROJECTION#{normalize_area(area)}#{normalize_record_id(record_id)}"


def build_load_sk(load_id: str) -> str:
    return f"LOAD#{normalize_record_id(load_id)}"


def build_load_requirement_sk(load_id: str, production_record_id: str) -> str:
    return f"LOADREQ#{normalize_record_id(load_id)}#{normalize_record_id(production_record_id)}"


def build_production_load_sk(production_record_id: str, load_id: str) -> str:
    return f"PRODLOAD#{normalize_record_id(production_record_id)}#{normalize_record_id(load_id)}"


def build_import_sk(document_type: str, area: str, import_id: str) -> str:
    return f"IMPORT#{normalize_area(document_type)}#{normalize_area(area)}#{normalize_record_id(import_id)}"


def build_markets_sk() -> str:
    """The single weekly business-summary item containing market maps."""
    return "MARKETS"


def stable_record_id(prefix: str, identity: dict[str, object]) -> str:
    """Return a deterministic opaque ID for a normalized source-row identity."""
    normalized_prefix = normalize_area(prefix)
    encoded = json.dumps(identity, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return f"{normalized_prefix}-{hashlib.sha256(encoded.encode('utf-8')).hexdigest()[:24].upper()}"


def production_record_id(
    *,
    area: str,
    zip_value: str,
    job_number: str | None,
    market: str,
    ir: str,
    occurrence: int,
) -> str:
    """Build a stable ID without treating ZIP as a unique operational key.

    The source workbook has no verified row-ID column.  Its row identity is the
    normalized business fields plus a deterministic duplicate occurrence.  A
    repeat import of the same workbook therefore produces the same ID, while
    two valid rows sharing a ZIP do not collide.
    """
    if occurrence < 1:
        raise ValueError("occurrence must be at least 1.")
    return stable_record_id("PR", {
        "area": normalize_area(area),
        "zip": str(zip_value or "").strip().upper(),
        "jobNumber": str(job_number or "").strip().upper(),
        "market": str(market or "").strip().upper(),
        "ir": str(ir or "").strip().upper(),
        "occurrence": occurrence,
    })


def projection_record_id(*, area: str, trip: str, atz: str, job_number: str | None) -> str:
    return stable_record_id("PJ", {
        "area": normalize_area(area),
        "trip": str(trip or "").strip().upper(),
        "atz": str(atz or "").strip().upper(),
        "jobNumber": str(job_number or "").strip().upper(),
    })
