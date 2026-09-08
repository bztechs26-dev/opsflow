import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

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

    const healthFunction = new lambda.Function(this, 'HealthFunction', {
      functionName: 'ops-flow-valassis',
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json
import urllib.request

FOLDER_MARKERS = ('inbox/.keep', 'processed/.keep', 'failed/.keep', 'web/.keep')

def send_cloudformation_response(event, context, status, data=None, reason=''):
    body = json.dumps({
        'Status': status,
        'Reason': reason or f'See CloudWatch log stream: {context.log_stream_name}',
        'PhysicalResourceId': event.get('PhysicalResourceId') or 'ops-flow-workflow-prefixes',
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'NoEcho': False,
        'Data': data or {},
    }).encode('utf-8')
    request = urllib.request.Request(
        event['ResponseURL'],
        data=body,
        headers={'content-type': '', 'content-length': str(len(body))},
        method='PUT',
    )
    with urllib.request.urlopen(request) as response:
        print(f'CloudFormation response: {response.status}')

def handler(event, context):
    # CDK invokes this branch only to maintain the agreed S3 folders and the
    # inbox/ notification. It does not process, move, or parse uploaded files.
    if event.get('RequestType') and event.get('ResponseURL'):
        try:
            if event['RequestType'] != 'Delete':
                import boto3
                properties = event['ResourceProperties']
                bucket = properties['BucketName']
                s3 = boto3.client('s3')
                for marker in FOLDER_MARKERS:
                    s3.put_object(Bucket=bucket, Key=marker, Body=b'')
                s3.put_bucket_notification_configuration(
                    Bucket=bucket,
                    NotificationConfiguration={
                        'LambdaFunctionConfigurations': [{
                            'Id': 'ops-flow-inbox-trigger',
                            'LambdaFunctionArn': properties['FunctionArn'],
                            'Events': ['s3:ObjectCreated:*'],
                            'Filter': {'Key': {'FilterRules': [{'Name': 'prefix', 'Value': 'inbox/'}]}},
                        }],
                    },
                )
            send_cloudformation_response(event, context, 'SUCCESS', {'folders': ','.join(FOLDER_MARKERS)})
        except Exception as error:
            print(f'Could not create workflow prefixes: {error}')
            send_cloudformation_response(event, context, 'FAILED', reason=str(error))
        return {'statusCode': 200}

    records = event.get('Records', [])
    if records and records[0].get('eventSource') == 'aws:s3':
        # The Python parser will be added under backend/ later. For now this
        # confirms receipt of inbox uploads without changing the source file.
        print(json.dumps({'event': 'inbox-upload-received', 'records': len(records)}))
        return {'statusCode': 202, 'body': json.dumps({'status': 'accepted'})}

    return {
        'statusCode': 200,
        'headers': {'content-type': 'application/json'},
        'body': json.dumps({'service': 'opsflow', 'status': 'ok'}),
    }
`),
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
    const webDistribution = new cloudfront.Distribution(this, 'WebDistribution', {
      defaultRootObject: 'index.html',
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
