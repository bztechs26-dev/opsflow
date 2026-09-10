# DynamoDB

This folder contains the DynamoDB repository used by the Python Lambda.

`keys.py` is the single authority for validated key construction. The active repository is `operational_repository.py`; it writes organization/year/week isolated data and preserves user-maintained status during normal re-imports. `operations.py` is a deprecated legacy prototype and is not imported at runtime.

See [DATA_MODEL.md](DATA_MODEL.md) for the complete key patterns, deterministic record identity, re-import policy, relationship items, and query decisions.
