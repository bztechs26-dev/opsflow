import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export interface OpsflowFoundationStackProps extends cdk.StackProps {
  environment: string;
}

/** A CloudFront S3 origin restricted to the web/ prefix of the application bucket. */
class WebPrefixS3Origin extends cloudfront.OriginBase {
  public constructor(
    private readonly bucket: s3.IBucket,
    originAccessControl: cloudfront.S3OriginAccessControl,
  ) {
    super(bucket.bucketRegionalDomainName, {
      originAccessControlId: originAccessControl.originAccessControlRef.originAccessControlId,
      originPath: '/web',
    });
  }

  public override bind(scope: Construct, options: cloudfront.OriginBindOptions): cloudfront.OriginBindConfig {
    if (!options.distributionId) {
      throw new Error('CloudFront distribution ID is required for the web bucket policy.');
    }

    this.bucket.addToResourcePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      conditions: {
        StringEquals: {
          'AWS:SourceArn': `arn:${cdk.Aws.PARTITION}:cloudfront::${cdk.Aws.ACCOUNT_ID}:distribution/${options.distributionId}`,
        },
      },
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
      resources: [this.bucket.arnForObjects('web/*')],
    }));

    return super.bind(scope, options);
  }

  protected override renderS3OriginConfig(): cloudfront.CfnDistribution.S3OriginConfigProperty {
    return { originAccessIdentity: '' };
  }
}

/**
 * The deliberately small, shared AWS foundation for OpsFlow.
 *
 * Application APIs and import processors are added only as their data
 * contracts are implemented. Nothing in this stack is provisioned manually.
 */
export class OpsflowFoundationStack extends cdk.Stack {
  public constructor(scope: Construct, id: string, props: OpsflowFoundationStackProps) {
    super(scope, id, props);

    const { environment } = props;
    cdk.Tags.of(this).add('Application', 'OpsFlow');
    cdk.Tags.of(this).add('Environment', environment);
    cdk.Tags.of(this).add('ManagedBy', 'AWS-CDK');

    // Files will use these prefixes: inbox/, processed/, failed/, and web/.
    // S3 creates a visible prefix when the first object is uploaded to it.
    const workflowBucket = new s3.Bucket(this, 'WorkflowBucket', {
      bucketName: 'ops-flow-valassis',
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const operationsTable = new dynamodb.Table(this, 'OperationsTable', {
      tableName: 'ops-flow-valassis',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const healthLogGroup = new logs.LogGroup(this, 'HealthLogGroup', {
      logGroupName: '/aws/lambda/ops-flow-valassis',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const backendLambdaPath = path.join(moduleDirectory, '../../backend/lambda/src');
    const healthFunction = new lambda.Function(this, 'HealthFunction', {
      functionName: 'ops-flow-valassis',
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(backendLambdaPath),
      environment: {
        FAILED_PREFIX: 'failed/',
        INBOX_PREFIX: 'inbox/',
        OPERATIONS_TABLE: operationsTable.tableName,
        PROCESSED_PREFIX: 'processed/',
        WORKFLOW_BUCKET: workflowBucket.bucketName,
      },
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      logGroup: healthLogGroup,
    });

    // S3 may invoke this Lambda only from the agreed application bucket.
    const inboxUploadPermission = new lambda.CfnPermission(this, 'InboxUploadPermission', {
      action: 'lambda:InvokeFunction',
      functionName: 'ops-flow-valassis',
      principal: 's3.amazonaws.com',
      sourceAccount: cdk.Aws.ACCOUNT_ID,
      sourceArn: workflowBucket.bucketArn,
    });
    inboxUploadPermission.addResourceDependency(healthFunction.node.defaultChild as lambda.CfnFunction);
    const workflowBucketResource = workflowBucket.node.defaultChild as s3.CfnBucket;

    healthFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: ['inbox/.keep', 'processed/.keep', 'failed/.keep', 'web/.keep']
        .map((marker) => `arn:${cdk.Aws.PARTITION}:s3:::ops-flow-valassis/${marker}`),
    }));
    healthFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:PutBucketNotification'],
      resources: [workflowBucket.bucketArn],
    }));
    const workflowPrefixes = new cdk.CfnResource(this, 'WorkflowPrefixes', {
      type: 'Custom::OpsflowWorkflowPrefixes',
      properties: {
        ServiceToken: healthFunction.functionArn,
        BucketName: workflowBucket.bucketName,
        FunctionArn: healthFunction.functionArn,
        ConfigurationVersion: 2,
      },
    });
    workflowPrefixes.addResourceDependency(workflowBucketResource);
    workflowPrefixes.addResourceDependency(inboxUploadPermission);

    const api = new apigateway.RestApi(this, 'Api', {
      deployOptions: {
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
        metricsEnabled: true,
      },
    });
    api.root.addResource('health').addMethod('GET', new apigateway.LambdaIntegration(healthFunction));

    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const webClient = userPool.addClient('WebClient', {
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      generateSecret: false,
      preventUserExistenceErrors: true,
    });

    const webOriginAccessControl = new cloudfront.S3OriginAccessControl(this, 'WebOriginAccessControl');
    const wareCertificate = acm.Certificate.fromCertificateArn(
      this,
      'WareCertificate',
      'arn:aws:acm:us-east-1:603437461228:certificate/4140c44b-1d23-42f0-a51e-a3172b033744',
    );
    const webDistribution = new cloudfront.Distribution(this, 'WebDistribution', {
      certificate: wareCertificate,
      defaultRootObject: 'index.html',
      domainNames: ['ware.zeegraphy.com'],
      defaultBehavior: {
        origin: new WebPrefixS3Origin(workflowBucket, webOriginAccessControl),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });

    new cdk.CfnOutput(this, 'ApiHealthUrl', { value: `${api.url}health` });
    new cdk.CfnOutput(this, 'CognitoUserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'CognitoWebClientId', { value: webClient.userPoolClientId });
    new cdk.CfnOutput(this, 'CloudFrontDomainName', { value: webDistribution.distributionDomainName });
    new cdk.CfnOutput(this, 'WorkflowBucketName', { value: workflowBucket.bucketName });
    new cdk.CfnOutput(this, 'InboxPrefix', { value: 'inbox/' });
    new cdk.CfnOutput(this, 'ProcessedPrefix', { value: 'processed/' });
    new cdk.CfnOutput(this, 'FailedPrefix', { value: 'failed/' });
    new cdk.CfnOutput(this, 'OperationsTableName', { value: operationsTable.tableName });
  }
}
