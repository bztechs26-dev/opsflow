# DynamoDB

This folder contains the DynamoDB repository used by the Python Lambda.

`operations.py` owns the single-table access pattern for `ops-flow-valassis`:

- import metadata: `IMPORT#{importId}` / `METADATA`;
- operational data: `WEEK#{week}` partition keys for production, loads, and projection mappings;
- available-week index: `CONTROL` / `WEEK#{week}`.

It creates pending-import records, replaces the relevant records for an uploaded workbook, records completion or failure, and provides the read queries used by the web application. Raw Excel files remain in S3; only parsed operational fields are persisted here.
