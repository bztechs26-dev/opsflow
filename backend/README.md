# OpsFlow backend

This folder contains Python application code that runs in AWS Lambda.

- `lambda/src/parsers/` contains dependency-free parsers for Production QA, Bulk Plan, and ZIP/TR Projection workbooks.
- `dynamodb/` contains the DynamoDB single-table repository used by the Lambda.
- `lambda/src/import_processor.py` controls the S3 inbox → parsed records → DynamoDB → processed/failed workflow.
- `lambda/src/upload_api.py` issues a five-minute, Cognito-protected direct S3 upload URL.

The raw workbook is always retained in S3. Parsed operational fields are stored in DynamoDB; the entire workbook is never copied there. Each import uses an immutable `inbox/{type}/{import-id}/{file}` key so duplicate S3 notifications do not create a second import.

## Production Zip List intake

Production uploads must use `Zip List <AREA> Wk <week>.xlsx`, for example `Zip List FE Wk 36.xlsx`. The Lambda extracts `FE` (or another uppercase area code) and `36` from the filename. Each such workbook is expected to have one worksheet; only that worksheet is read. No other worksheet is scanned, and only the parsed operational fields—not the source workbook—are written to DynamoDB.
