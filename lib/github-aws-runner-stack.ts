import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import * as path from "path";

const SSM_GITHUB_TOKEN = "/github-aws-runner/github-token";
const SSM_WEBHOOK_SECRET = "/github-aws-runner/webhook-secret";
const SSM_TARGET_TYPE = "/github-aws-runner/target-type";
const SSM_TARGET_SLUG = "/github-aws-runner/target-slug";
const SSM_RUNNER_TIMEOUT = "/github-aws-runner/runner-timeout-minutes";
const SSM_INSTANCE_TYPE = "/github-aws-runner/instance-type";
const SSM_EBS_VOLUME_SIZE = "/github-aws-runner/ebs-volume-size-gb";

export interface GithubAwsRunnerProps extends cdk.StackProps {
  /** GitHub webhook source CIDR blocks (from /meta API) used for initial resource policy */
  initialWebhookIps: string[];
}

export class GithubAwsRunnerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GithubAwsRunnerProps) {
    super(scope, id, props);

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
    // Lambda: Webhook handler
    // -------------------------------------------------------------------------
    const webhookFn = new NodejsFunction(this, "WebhookFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, "../lambda/webhook/index.ts"),
      handler: "handler",
      timeout: cdk.Duration.seconds(30),
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
        ],
      })
    );

    webhookFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:RunInstances"],
        resources: ["*"],
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

    // -------------------------------------------------------------------------
    // REST API with resource policy restricting to GitHub webhook IPs
    // -------------------------------------------------------------------------
    const api = new apigateway.RestApi(this, "WebhookApi", {
      restApiName: "github-aws-runner-webhook",
      description: "Receives GitHub Actions webhook events",
      policy: buildResourcePolicy(props.initialWebhookIps),
      deployOptions: {
        stageName: "prod",
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
