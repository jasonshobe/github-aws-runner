import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import * as path from "path";

export interface GithubAwsRunnerProps extends cdk.StackProps {
  /** GitHub webhook source CIDR blocks (from /meta API) used for initial resource policy */
  initialWebhookIps: string[];
}

export class GithubAwsRunnerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GithubAwsRunnerProps) {
    super(scope, id, props);

    // SSM parameter prefix — override with CDK context key "ssmPrefix".
    // Example: cdk deploy --context ssmPrefix=/my-runner
    const rawPrefix = (this.node.tryGetContext("ssmPrefix") as string | undefined) ?? "/github-aws-runner";
    const p = rawPrefix.replace(/\/$/, ""); // strip any trailing slash

    const SSM_GITHUB_TOKEN             = `${p}/github-token`;
    const SSM_WEBHOOK_SECRET           = `${p}/webhook-secret`;
    const SSM_TARGET_TYPE              = `${p}/target-type`;
    const SSM_TARGET_SLUG              = `${p}/target-slug`;
    const SSM_RUNNER_TIMEOUT           = `${p}/runner-timeout-minutes`;
    const SSM_INSTANCE_TYPE            = `${p}/instance-type`;
    const SSM_EBS_VOLUME_SIZE          = `${p}/ebs-volume-size-gb`;
    const SSM_MAX_CONCURRENT_RUNNERS   = `${p}/max-concurrent-runners`;
    const SSM_API_THROTTLE_RATE        = `${p}/api-throttle-rate-limit`;
    const SSM_API_THROTTLE_BURST       = `${p}/api-throttle-burst-limit`;
    const SSM_RUNNER_LABEL             = `${p}/runner-label`;
    const SSM_ALLOWED_INSTANCE_TYPES   = `${p}/allowed-instance-types`;
    const SSM_MAX_EBS_VOLUME_SIZE      = `${p}/max-ebs-volume-size-gb`;

    // -------------------------------------------------------------------------
    // VPC — single public subnet, no NAT Gateway
    // -------------------------------------------------------------------------
    const vpc = new ec2.Vpc(this, "RunnerVpc", {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          mapPublicIpOnLaunch: true,
        },
      ],
    });

    const runnerSecurityGroup = new ec2.SecurityGroup(this, "RunnerSg", {
      vpc,
      description: "Security group for GitHub Actions runner EC2 instances",
      allowAllOutbound: true,
    });

    // -------------------------------------------------------------------------
    // EC2 instance role — runners need to self-terminate
    // -------------------------------------------------------------------------
    const instanceRole = new iam.Role(this, "RunnerInstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "Role assumed by GitHub Actions runner EC2 instances",
    });

    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ec2:TerminateInstances"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "ec2:ResourceTag/github-aws-runner:managed": "true",
          },
        },
      })
    );

    const instanceProfile = new iam.CfnInstanceProfile(
      this,
      "RunnerInstanceProfile",
      { roles: [instanceRole.roleName] }
    );

    // -------------------------------------------------------------------------
    // AMI — RunsOn runner image resolved at synth time
    // -------------------------------------------------------------------------
    const runnerAmi = ec2.MachineImage.lookup({
      name: "runs-on-v2.*-ubuntu22-full-x64-*",
      owners: ["135269210855"],
    });
    const amiId = runnerAmi.getImage(this).imageId;

    // -------------------------------------------------------------------------
    // Max concurrent runners — read at synth time for Lambda reserved concurrency;
    // also passed to the Lambda for the runtime EC2 cap check.
    // Requires cdk deploy to pick up SSM changes.
    // -------------------------------------------------------------------------
    const maxConcurrentRunnersStr = ssm.StringParameter.valueFromLookup(
      this,
      SSM_MAX_CONCURRENT_RUNNERS
    );
    const maxConcurrentRunners = parseInt(maxConcurrentRunnersStr, 10);
    // valueFromLookup returns a dummy string on first synth before the context
    // is populated; fall back to a safe default so the synth does not fail.
    const reservedConcurrency = Number.isNaN(maxConcurrentRunners)
      ? 10
      : maxConcurrentRunners;

    const apiThrottleRate = parseInt(
      ssm.StringParameter.valueFromLookup(this, SSM_API_THROTTLE_RATE),
      10
    );
    const throttlingRateLimit = Number.isNaN(apiThrottleRate) ? 10 : apiThrottleRate;

    const apiThrottleBurst = parseInt(
      ssm.StringParameter.valueFromLookup(this, SSM_API_THROTTLE_BURST),
      10
    );
    const throttlingBurstLimit = Number.isNaN(apiThrottleBurst) ? 5 : apiThrottleBurst;

    // -------------------------------------------------------------------------
    // Lambda: Webhook handler
    // -------------------------------------------------------------------------
    const webhookFn = new NodejsFunction(this, "WebhookFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, "../lambda/webhook/index.ts"),
      handler: "handler",
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: reservedConcurrency,
      bundling: {
        externalModules: [],
      },
      environment: {
        GITHUB_TOKEN_PARAM: SSM_GITHUB_TOKEN,
        WEBHOOK_SECRET_PARAM: SSM_WEBHOOK_SECRET,
        TARGET_TYPE_PARAM: SSM_TARGET_TYPE,
        TARGET_SLUG_PARAM: SSM_TARGET_SLUG,
        SUBNET_ID: vpc.publicSubnets[0].subnetId,
        SECURITY_GROUP_ID: runnerSecurityGroup.securityGroupId,
        INSTANCE_PROFILE_ARN: instanceProfile.attrArn,
        AMI_ID: amiId,
        INSTANCE_TYPE_PARAM: SSM_INSTANCE_TYPE,
        EBS_VOLUME_SIZE_PARAM: SSM_EBS_VOLUME_SIZE,
        MAX_CONCURRENT_RUNNERS_PARAM: SSM_MAX_CONCURRENT_RUNNERS,
        RUNNER_LABEL_PARAM: SSM_RUNNER_LABEL,
        ALLOWED_INSTANCE_TYPES_PARAM: SSM_ALLOWED_INSTANCE_TYPES,
        MAX_EBS_VOLUME_SIZE_PARAM: SSM_MAX_EBS_VOLUME_SIZE,
        RUNNER_TIMEOUT_PARAM: SSM_RUNNER_TIMEOUT,
      },
    });

    webhookFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:GetParameters"],
        resources: [
          ssmArn(this, SSM_GITHUB_TOKEN),
          ssmArn(this, SSM_WEBHOOK_SECRET),
          ssmArn(this, SSM_TARGET_TYPE),
          ssmArn(this, SSM_TARGET_SLUG),
          ssmArn(this, SSM_INSTANCE_TYPE),
          ssmArn(this, SSM_EBS_VOLUME_SIZE),
          ssmArn(this, SSM_MAX_CONCURRENT_RUNNERS),
          ssmArn(this, SSM_RUNNER_LABEL),
          ssmArn(this, SSM_ALLOWED_INSTANCE_TYPES),
          ssmArn(this, SSM_MAX_EBS_VOLUME_SIZE),
          ssmArn(this, SSM_RUNNER_TIMEOUT),
        ],
      })
    );

    // RunInstances is allowed only when the request includes the managed tag,
    // preventing the Lambda role from launching untagged instances.
    webhookFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:RunInstances"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "aws:RequestTag/github-aws-runner:managed": "true",
          },
        },
      })
    );

    webhookFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:CreateTags"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "ec2:CreateAction": "RunInstances",
          },
        },
      })
    );

    webhookFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [instanceRole.roleArn],
      })
    );

    // Needed for the concurrent runner cap check before launching.
    webhookFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:DescribeInstances"],
        resources: ["*"],
      })
    );

    // -------------------------------------------------------------------------
    // REST API with resource policy restricting to GitHub webhook IPs
    // -------------------------------------------------------------------------
    const accessLogGroup = new logs.LogGroup(this, "WebhookApiAccessLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const api = new apigateway.RestApi(this, "WebhookApi", {
      restApiName: "github-aws-runner-webhook",
      description: "Receives GitHub Actions webhook events",
      policy: buildResourcePolicy(props.initialWebhookIps),
      deployOptions: {
        stageName: "prod",
        throttlingRateLimit,
        throttlingBurstLimit,
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
      },
    });

    const webhookResource = api.root.addResource("webhook");
    webhookResource.addMethod(
      "POST",
      new apigateway.LambdaIntegration(webhookFn)
    );

    // -------------------------------------------------------------------------
    // Lambda: IP updater
    // -------------------------------------------------------------------------
    const ipUpdaterFn = new NodejsFunction(this, "IpUpdaterFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, "../lambda/ip-updater/index.ts"),
      handler: "handler",
      timeout: cdk.Duration.minutes(1),
      bundling: {
        externalModules: [],
      },
      environment: {
        REST_API_ID: api.restApiId,
        ACCOUNT_ID: this.account,
      },
    });

    ipUpdaterFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["apigateway:PATCH"],
        resources: [
          `arn:aws:apigateway:${this.region}::/restapis/${api.restApiId}`,
        ],
      })
    );

    new events.Rule(this, "IpUpdaterSchedule", {
      schedule: events.Schedule.rate(cdk.Duration.hours(12)),
      targets: [new eventsTargets.LambdaFunction(ipUpdaterFn)],
    });

    // -------------------------------------------------------------------------
    // Lambda: Watchdog
    // -------------------------------------------------------------------------
    const watchdogFn = new NodejsFunction(this, "WatchdogFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, "../lambda/watchdog/index.ts"),
      handler: "handler",
      timeout: cdk.Duration.minutes(5),
      bundling: {
        externalModules: [],
      },
      environment: {
        RUNNER_TIMEOUT_PARAM: SSM_RUNNER_TIMEOUT,
      },
    });

    watchdogFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [ssmArn(this, SSM_RUNNER_TIMEOUT)],
      })
    );

    watchdogFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:DescribeInstances"],
        resources: ["*"],
      })
    );

    watchdogFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:TerminateInstances"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "ec2:ResourceTag/github-aws-runner:managed": "true",
          },
        },
      })
    );

    new events.Rule(this, "WatchdogSchedule", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
      targets: [new eventsTargets.LambdaFunction(watchdogFn)],
    });

    // -------------------------------------------------------------------------
    // Custom resource: GitHub webhook registration
    // -------------------------------------------------------------------------
    const webhookRegistrationFn = new NodejsFunction(
      this,
      "WebhookRegistrationFn",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        entry: path.join(__dirname, "../lambda/custom-resource/index.ts"),
        handler: "handler",
        timeout: cdk.Duration.minutes(5),
        bundling: {
          externalModules: [],
        },
      }
    );

    webhookRegistrationFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:GetParameters"],
        resources: [
          ssmArn(this, SSM_GITHUB_TOKEN),
          ssmArn(this, SSM_WEBHOOK_SECRET),
          ssmArn(this, SSM_TARGET_TYPE),
          ssmArn(this, SSM_TARGET_SLUG),
        ],
      })
    );

    const provider = new cr.Provider(this, "WebhookRegistrationProvider", {
      onEventHandler: webhookRegistrationFn,
    });

    new cdk.CustomResource(this, "GithubWebhookRegistration", {
      serviceToken: provider.serviceToken,
      resourceType: "Custom::GithubWebhookRegistration",
      properties: {
        WebhookUrl: api.urlForPath("/webhook"),
        GithubTokenParam: SSM_GITHUB_TOKEN,
        WebhookSecretParam: SSM_WEBHOOK_SECRET,
        TargetTypeParam: SSM_TARGET_TYPE,
        TargetSlugParam: SSM_TARGET_SLUG,
      },
    });

    // -------------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------------
    new cdk.CfnOutput(this, "WebhookApiUrl", {
      value: api.urlForPath("/webhook"),
      description: "URL to register as the GitHub webhook endpoint",
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildResourcePolicy(cidrBlocks: string[]): iam.PolicyDocument {
  return new iam.PolicyDocument({
    statements: [
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["execute-api:Invoke"],
        resources: ["execute-api:/*"],
        conditions: {
          NotIpAddress: {
            "aws:SourceIp": cidrBlocks,
          },
        },
      }),
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.AnyPrincipal()],
        actions: ["execute-api:Invoke"],
        resources: ["execute-api:/*"],
      }),
    ],
  });
}

function ssmArn(stack: cdk.Stack, paramName: string): string {
  return `arn:aws:ssm:${stack.region}:${stack.account}:parameter${paramName}`;
}
