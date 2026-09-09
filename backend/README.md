# OpsFlow backend

This folder contains Python application code that runs in AWS Lambda.

- `lambda/src/` contains the deployed Lambda handler and its small supporting modules.
- `dynamodb/` is reserved for DynamoDB repositories and domain persistence code. No business writes are implemented yet.

The Lambda currently has two intentionally small responsibilities:

1. return the API Gateway `/health` response;
2. log uploads created under `s3://ops-flow-valassis/inbox/`.

It does not parse, move, or store uploaded files yet. Those behaviours will be added only after the file format and DynamoDB data contract are agreed.
