"""Infrastructure-only support for the CDK custom resource.

This preserves the agreed S3 folders and the inbox/ Lambda notification. It is
not part of the future import parser or DynamoDB persistence workflow.
"""

import json
import urllib.request
from typing import Any


FOLDER_MARKERS = ("inbox/.keep", "processed/.keep", "failed/.keep", "web/.keep")


def _send_cloudformation_response(
    event: dict[str, Any], context: Any, status: str, data: dict[str, str] | None = None, reason: str = ""
) -> None:
    body = json.dumps(
        {
            "Status": status,
            "Reason": reason or f"See CloudWatch log stream: {context.log_stream_name}",
            "PhysicalResourceId": event.get("PhysicalResourceId") or "ops-flow-workflow-prefixes",
            "StackId": event["StackId"],
            "RequestId": event["RequestId"],
            "LogicalResourceId": event["LogicalResourceId"],
            "NoEcho": False,
            "Data": data or {},
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        event["ResponseURL"],
        data=body,
        headers={"content-type": "", "content-length": str(len(body))},
        method="PUT",
    )
    with urllib.request.urlopen(request) as response:
        print(f"CloudFormation response: {response.status}")


def maintain_workflow_prefixes(event: dict[str, Any], context: Any) -> dict[str, int]:
    """Create folder markers and retain the S3 ObjectCreated inbox/ notification."""
    try:
        if event["RequestType"] != "Delete":
            import boto3

            properties = event["ResourceProperties"]
            bucket = properties["BucketName"]
            s3_client = boto3.client("s3")
            for marker in FOLDER_MARKERS:
                s3_client.put_object(Bucket=bucket, Key=marker, Body=b"")
            s3_client.put_bucket_notification_configuration(
                Bucket=bucket,
                NotificationConfiguration={
                    "LambdaFunctionConfigurations": [
                        {
                            "Id": "ops-flow-inbox-trigger",
                            "LambdaFunctionArn": properties["FunctionArn"],
                            "Events": ["s3:ObjectCreated:*"],
                            "Filter": {"Key": {"FilterRules": [{"Name": "prefix", "Value": "inbox/"}]}},
                        }
                    ]
                },
            )
        _send_cloudformation_response(event, context, "SUCCESS", {"folders": ",".join(FOLDER_MARKERS)})
    except Exception as error:  # CloudFormation must receive a response even when setup fails.
        print(f"Could not maintain workflow prefixes: {error}")
        _send_cloudformation_response(event, context, "FAILED", reason=str(error))

    return {"statusCode": 200}
