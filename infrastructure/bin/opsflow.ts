import * as cdk from 'aws-cdk-lib';
import { OpsflowFoundationStack } from '../lib/opsflow-foundation-stack.js';

const app = new cdk.App();
const environment = app.node.tryGetContext('environment') ?? 'test';

new OpsflowFoundationStack(app, `Opsflow-${environment}-Foundation`, {
  description: 'OpsFlow shared test foundation managed by AWS CDK.',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  environment,
});
