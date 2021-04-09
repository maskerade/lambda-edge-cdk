import * as cdk from '@aws-cdk/core';
import * as cloudfront from '@aws-cdk/aws-cloudfront';
import * as origins from '@aws-cdk/aws-cloudfront-origins';
import * as dynamodb from '@aws-cdk/aws-dynamodb';
import * as s3 from '@aws-cdk/aws-s3';
import * as iam from '@aws-cdk/aws-iam';
import * as lambda from '@aws-cdk/aws-lambda';
import * as cr from '@aws-cdk/custom-resources';
import fs = require('fs');


export class CdkLambdaEdgeStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB Table
    const table = new dynamodb.Table(this, 'AlienCards-', {
      partitionKey: { name: 'CardId', type: dynamodb.AttributeType.STRING },
      readCapacity: 5,
      writeCapacity: 5,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES
    });

    // S3 Bucket
    const bucket = new s3.Bucket(this, 'alien-cards-')

    // S3 Bucket - Create a new bucket to store 'B' variant content
    const bucketMonkeys = new s3.Bucket(this, 'monkeys-cards-')

    // Bootstrap Function & Custom Resource
    const onEvent = new lambda.SingletonFunction(this, 'Singleton', {
      uuid: 'f7d4f730-4ee1-11e8-9c2d-fa7ae01bbebc',
      code: new lambda.InlineCode(fs.readFileSync('src/custom-resources/stack-bootstrap.js', { encoding: 'utf-8' })),
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(300),
      runtime: lambda.Runtime.NODEJS_12_X,
    });

    onEvent.role?.addManagedPolicy({managedPolicyArn: 'arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess'})
    onEvent.role?.addManagedPolicy({managedPolicyArn: 'arn:aws:iam::aws:policy/AmazonS3FullAccess'})
    onEvent.role?.addManagedPolicy({managedPolicyArn: 'arn:aws:iam::aws:policy/CloudWatchLogsFullAccess'})

    const myProvider = new cr.Provider(this, 'MyProvider', {
      onEventHandler: onEvent
    });

    const resource = new cdk.CustomResource(this, 'Resource1', {
      serviceToken: myProvider.serviceToken,
      properties: {
        SrcS3Bucket: 'ws-lambda-at-edge',
        DstS3Bucket: bucket.bucketName,
        DdbTableName: table.tableName
      }
    });

    // IAM roles for lambdas - should these be created separately?

    // Edge Lambda to cloudfront distribution
    const myFunc = new cloudfront.experimental.EdgeFunction(this, 'MyFunction', {
      runtime: lambda.Runtime.NODEJS_12_X,
      handler: 'index.handler',
      code: new lambda.InlineCode(fs.readFileSync('src/edge-lambdas/ws-lambda-at-edge-add-security-headers.js', { encoding: 'utf-8' })),
    });

    // Edge Lambda to generate dynamic content for Card Pages
    const generateCardPage = new cloudfront.experimental.EdgeFunction(this, 'GenerateCardPage', {
      runtime: lambda.Runtime.NODEJS_12_X,
      handler: 'index.handler',
      code: new lambda.InlineCode(fs.readFileSync('src/edge-lambdas/ws-lambda-at-edge-generate-card-page.js', { encoding: 'utf-8' })),
    });

    generateCardPage.addToRolePolicy(new iam.PolicyStatement({
      resources: ['*'],
      actions: ['dynamodb:*'],
    }));

    // Edge Lambda to generate dynamic content for Home Pages
    const generateHomePage = new cloudfront.experimental.EdgeFunction(this, 'GenerateHomePage', {
      runtime: lambda.Runtime.NODEJS_12_X,
      handler: 'index.handler',
      code: new lambda.InlineCode(fs.readFileSync('src/edge-lambdas/ws-lambda-at-edge-generate-home-page-experiment.js', { encoding: 'utf-8' })),
    });

    generateHomePage.addToRolePolicy(new iam.PolicyStatement({
      resources: ['*'],
      actions: ['dynamodb:*'],
    }));


    // This doesn't work?
    generateCardPage.role?.addManagedPolicy({managedPolicyArn: 'arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess'})

    const originA = new origins.S3Origin(bucket);

    // CloudFront Distribution & Origin Access Identity
    const cloudfrontDistro = new cloudfront.Distribution(this, 'myDist', {
      defaultBehavior: {
        origin: originA,
        edgeLambdas: [
          {
            eventType: cloudfront.LambdaEdgeEventType.ORIGIN_RESPONSE,
            functionVersion: myFunc.currentVersion
          },
          {
            eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
            functionVersion: generateCardPage.currentVersion
          }
        ]
      },
      defaultRootObject: 'index.html'
    });


    cloudfrontDistro.addBehavior('index.html', originA, {
      cachePolicy: new cloudfront.CachePolicy(this, 'IndexCachePolicy', {
        defaultTtl: cdk.Duration.seconds(5),
        minTtl: cdk.Duration.seconds(0),
        maxTtl: cdk.Duration.seconds(5)
      }),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      edgeLambdas: [{
        eventType: cloudfront.LambdaEdgeEventType.ORIGIN_RESPONSE,
        functionVersion: generateHomePage.currentVersion
      }]
    })



  }
}
