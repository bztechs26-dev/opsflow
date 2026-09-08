# OpsFlow infrastructure

This workspace defines the shared **test** AWS foundation for OpsFlow using AWS CDK and TypeScript. It is the only deployed environment at this stage; local development remains on developers' workstations.

## Managed resources

- One private application bucket, `ops-flow-valassis`, with CDK-created `inbox/`, `processed/`, `failed/`, and `web/` prefixes
- CloudFront distribution for the React application
- Cognito user pool and browser client (application user sign-in will be integrated later)
- DynamoDB single-table foundation using `pk` and `sk`
- A Python Lambda named `ops-flow-valassis`, invoked by `/health` and by new objects in `inbox/`
- CloudWatch logs for the Lambda, retained for one month

The stack deliberately does **not** yet contain an import parser or business APIs. Those will be built in Python under `backend/` only after their contracts and DynamoDB access patterns are implemented.

The deployed resource name is intentionally short and readable: `ops-flow-valassis`. CDK creates an empty `.keep` marker inside each required prefix, so all four folders appear in S3 immediately after deployment. The `web/` prefix is the private CloudFront origin; it is not an additional S3 bucket.

## Legacy cleanup

The legacy prototype buckets and the original generated DynamoDB table were removed by CDK. The required `cdk-hnb659fds-assets-...` bootstrap bucket is intentionally excluded because CDK uses it to deploy this stack.

## Safe deployment flow

1. Install AWS CLI v2 and configure a temporary IAM Identity Center profile. Do not create access keys.
2. Use the `BZTech-Administrator` profile for the one-time CDK bootstrap, then use the developer profile for ordinary work where permitted.
3. Run `npm.cmd install` at repository root to install this workspace's CDK dependencies.
4. From this folder, run `npm.cmd run synth` and inspect the generated CloudFormation plan.
5. Bootstrap **only** `603437461228/us-east-1`, then run `npm.cmd run diff` and `npm.cmd run deploy` after review.

The first stack deploy uses the CloudFront domain that AWS provides. We will add the temporary `ware.zeegraphy.com` address later, after validating the foundation; it requires an ACM certificate and a DNS validation record in cPanel.
