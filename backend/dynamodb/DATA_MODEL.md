# OpsFlow operational data model

## Scope and week semantics

OpsFlow stores **explicit company operational year and week numbers**. These
are not inferred from the server clock and are not assumed to be ISO calendar
weeks. The upload request provides `operationalYear`; the workbook filename
provides a validated week number. The current development organization is an
environment setting (`DEFAULT_ORGANIZATION_ID=opsflow-dev`), not a hard-coded
persistence assumption.

## Table and primary key

The physical table has a composite primary key named `pk` and `sk`.

```text
PK = ORG#<organizationId>#YEAR#<year>#WEEK#<week>
```

Example:

```text
ORG#OPSFLOW-DEV#YEAR#2026#WEEK#36
```

This isolates Week 36 from Week 39 and from Week 36 of another year. ZIP is
not a partition key or unique record identity because it repeats across weeks,
areas, jobs, and potentially within the same workbook.

## Sort key patterns

```text
PRODUCTION#<area>#<recordId>
PROJECTION#<area>#<recordId>
LOAD#<loadId>
LOADREQ#<loadId>#<productionRecordId>
PRODLOAD#<productionRecordId>#<loadId>
IMPORT#<type>#<area>#<importId>
```

`LOADREQ` is the load-to-production adjacency record. `PRODLOAD` is the
reverse adjacency record, added because a production status update needs to
find affected loads without a scan. No GSI is currently created: all active
queries are constrained to a known weekly partition.

The available-week list uses a small control partition:

```text
PK = ORG#<organizationId>#YEAR#<year>#CONTROL
SK = WEEK#<week>
```

Browser polling uses a narrow import lookup pointer:

```text
PK = ORG#<organizationId>#IMPORT#<importId>
SK = METADATA
```

It prevents a table Scan while leaving the authoritative import audit item in
the week partition.

## Examples

Production:

```json
{
  "pk": "ORG#OPSFLOW-DEV#YEAR#2026#WEEK#36",
  "sk": "PRODUCTION#FE#PR-2D4A...",
  "entityType": "PRODUCTION",
  "organizationId": "OPSFLOW-DEV",
  "year": 2026,
  "week": 36,
  "sourceArea": "FE",
  "recordId": "PR-2D4A...",
  "zip": "19720",
  "jobNumber": "100",
  "status": "COMPLETE",
  "updatedBy": "cognito-sub",
  "version": 2
}
```

Projection:

```text
PK = ORG#OPSFLOW-DEV#YEAR#2026#WEEK#36
SK = PROJECTION#FE#PJ-7B1C...
```

Shipping load:

```text
PK = ORG#OPSFLOW-DEV#YEAR#2026#WEEK#36
SK = LOAD#5600012
```

## Production identity and idempotency

The current ZIP-list workbook has no verified source-row ID. A production
`recordId` is therefore a deterministic SHA-256-derived value of normalized
area, ZIP/ATZ, job number, market, IR, and duplicate occurrence. The same
source row re-imports to the same key; two rows using the same ZIP do not
collide. If a workbook supplies a real immutable row ID in the future, that
identifier should replace the duplicate-occurrence component.

Imports use deterministic operational keys, so retried S3 events upsert the
same records rather than creating duplicates. A normal re-import is **MERGE**
mode: source fields refresh, while user-owned `status`, `notes`, `updatedBy`,
and `version` remain intact. Removing stale source rows or intentionally
replacing user state requires a future explicit, privileged replace workflow;
it is never implicit.

## Source versus operational ownership

Source fields include ZIP, job number, market, machine, IR, volume, and source
status. Operational fields include status, notes, updated time, updated user,
and version. The repository writes this boundary deliberately and the status
endpoint only changes operational fields with an exact `PK + SK` conditional
update.

## Current access patterns

- List available weeks for one organization/year: Query control partition.
- View one week: Query the week partition.
- View Production FE: Query the week partition with `begins_with(SK, "PRODUCTION#FE#")` (the repository can add the filtered endpoint when paging is introduced).
- Update a Production status: exact `UpdateItem` by organization, year, week, area, and record ID; conditional existence/entity/version protection.
- Find loads affected by a production record: Query the weekly partition for the `PRODLOAD` adjacency key.

No GSI is justified today. Historical ZIP lookup, machine-wide queries, and
load-status cross-week reporting are deferred until those access patterns are
required and measured.

## Deployment note

The current deployed test table is named `ops-flow-valassis` and has only the
physical `pk`/`sk` schema required by this model. The logical-key migration is
non-destructive, but importing real workbooks requires deployment of this code
and the Lambda environment defaults. Existing legacy `IMPORT#.../METADATA`
test rows are not read by the new model and should be removed only through an
explicit approved cleanup step.
