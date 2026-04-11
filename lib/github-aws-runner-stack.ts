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
    const SSM_IP_UPDATER_INTERVAL      = `${p}/ip-updater-interval-hours`;
    const SSM_AMI_NAME                 = `${p}/ami-name`;
    const SSM_AMI_OWNERS               = `${p}/ami-owners`;
    const SSM_CACHE_BUCKET             = `${p}/cache-bucket`;
    const SSM_CACHE_EXPIRATION_DAYS    = `${p}/cache-expiration-days`;
    const SSM_OIDC_ROLE_POLICY_ARN     = `${p}/oidc-role-policy-arn`;
    const SSM_OIDC_SUBJECT_PATTERN     = `${p}/oidc-subject-pattern`;
    const lambdaExternalModules = ["@aws-sdk/*"];
    const optionalLookup = (parameterName: string, defaultValue = "") =>
      ssm.StringParameter.valueFromLookup(this, parameterName, defaultValue);

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

    // API Gateway stage access logging requires an account-level CloudWatch
    // Logs role to be configured before the stage is created.
    const apiGatewayCloudWatchRole = new iam.Role(this, "ApiGatewayCloudWatchRole", {
      assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonAPIGatewayPushToCloudWatchLogs"
        ),
      ],
      description: "Account-level CloudWatch Logs role for API Gateway access logging",
    });

    const apiGatewayAccount = new apigateway.CfnAccount(this, "ApiGatewayAccount", {
      cloudWatchRoleArn: apiGatewayCloudWatchRole.roleArn,
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

    // Cache bucket — optional. valueFromLookup returns a dummy string containing
    // forward-slashes when the parameter is absent; those are not valid in S3
    // bucket names, so the regex reliably detects "not configured".
    const cacheBucketRaw = optionalLookup(SSM_CACHE_BUCKET);
    const cacheBucketName = /^[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]$/.test(cacheBucketRaw)
      ? cacheBucketRaw
      : undefined;

    const cacheExpirationDaysRaw = parseInt(
      optionalLookup(SSM_CACHE_EXPIRATION_DAYS, "10"),
      10
    );
    const cacheExpirationDays = Number.isNaN(cacheExpirationDaysRaw) ? 10 : cacheExpirationDaysRaw;

    // OIDC — both parameters must be set together. Policy ARN is detected by
    // the leading "arn:aws:iam::" prefix; subject pattern by absence of the
    // CDK dummy-value prefix. If either is missing the block is skipped.
    const oidcPolicyArnRaw = optionalLookup(SSM_OIDC_ROLE_POLICY_ARN);
    const oidcPolicyArn = oidcPolicyArnRaw.startsWith("arn:aws:iam::")
      ? oidcPolicyArnRaw
      : undefined;

    const oidcSubjectPatternRaw = optionalLookup(SSM_OIDC_SUBJECT_PATTERN);
    const oidcSubjectPattern =
      oidcPolicyArn !== undefined && !oidcSubjectPatternRaw.startsWith("dummy-value-for-")
        ? oidcSubjectPatternRaw
        : undefined;

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
        externalModules: lambdaExternalModules,
      },
      environment: {
        GITHUB_TOKEN_PARAM: SSM_GITHUB_TOKEN,
        WEBHOOK_SECRET_PARAM: SSM_WEBHOOK_SECRET,
        TARGET_TYPE_PARAM: SSM_TARGET_TYPE,
        TARGET_SLUG_PARAM: SSM_TARGET_SLUG,
        SUBNET_ID: vpc.publicSubnets[0].subnetId,
        SECURITY_GROUP_ID: runnerSecurityGroup.securityGroupId,
        INSTANCE_PROFILE_ARN: instanceProfile.attrArn,
        AMI_NAME_PARAM: SSM_AMI_NAME,
        AMI_OWNERS_PARAM: SSM_AMI_OWNERS,
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
          ssmArn(this, SSM_AMI_NAME),
          ssmArn(this, SSM_AMI_OWNERS),
        ],
      })
    );

    // Needed to resolve the latest matching AMI at runtime.
    webhookFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:DescribeImages"],
        resources: ["*"],
      })
    );

    // RunInstances authorization is evaluated against each referenced EC2
    // resource. The managed tag condition only applies to the instance being
    // created, not supporting resources such as the subnet, security group,
    // network interface, AMI, or root volume.
    webhookFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:RunInstances"],
        resources: [
          `arn:aws:ec2:${this.region}:${this.account}:instance/*`,
        ],
        conditions: {
          StringEquals: {
            "aws:RequestTag/github-aws-runner:managed": "true",
          },
        },
      })
    );

    webhookFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:RunInstances"],
        resources: [
          `arn:aws:ec2:${this.region}::image/*`,
          `arn:aws:ec2:${this.region}:${this.account}:network-interface/*`,
          `arn:aws:ec2:${this.region}:${this.account}:security-group/*`,
          `arn:aws:ec2:${this.region}:${this.account}:subnet/*`,
          `arn:aws:ec2:${this.region}:${this.account}:volume/*`,
        ],
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
    api.deploymentStage.node.addDependency(apiGatewayAccount);

    // -------------------------------------------------------------------------
    // Lambda: IP updater
    // -------------------------------------------------------------------------
    const ipUpdaterFn = new NodejsFunction(this, "IpUpdaterFn", {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, "../lambda/ip-updater/index.ts"),
      handler: "handler",
      timeout: cdk.Duration.minutes(1),
      bundling: {
        externalModules: lambdaExternalModules,
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

    const ipUpdaterIntervalHours = parseInt(
      optionalLookup(SSM_IP_UPDATER_INTERVAL, "12"),
      10
    );

    new events.Rule(this, "IpUpdaterSchedule", {
      schedule: events.Schedule.rate(
        cdk.Duration.hours(Number.isNaN(ipUpdaterIntervalHours) ? 12 : ipUpdaterIntervalHours)
      ),
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
        externalModules: lambdaExternalModules,
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
          externalModules: lambdaExternalModules,
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
    // Optional: S3 cache bucket
    // -------------------------------------------------------------------------
    if (cacheBucketName !== undefined) {
      const cacheBucketFn = new NodejsFunction(this, "CacheBucketFn", {
        runtime: lambda.Runtime.NODEJS_22_X,
        entry: path.join(__dirname, "../lambda/cache-bucket/index.ts"),
        handler: "handler",
        timeout: cdk.Duration.minutes(1),
        bundling: {
          externalModules: lambdaExternalModules,
        },
      });

      cacheBucketFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["s3:CreateBucket", "s3:PutLifecycleConfiguration"],
          resources: [`arn:aws:s3:::${cacheBucketName}`],
        })
      );

      const cacheBucketProvider = new cr.Provider(this, "CacheBucketProvider", {
        onEventHandler: cacheBucketFn,
      });

      new cdk.CustomResource(this, "CacheBucket", {
        serviceToken: cacheBucketProvider.serviceToken,
        resourceType: "Custom::CacheBucket",
        properties: {
          BucketName: cacheBucketName,
          ExpirationDays: String(cacheExpirationDays),
        },
      });

      // Grant EC2 runner instances access to read and write cache objects.
      instanceRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          resources: [`arn:aws:s3:::${cacheBucketName}/*`],
        })
      );
      instanceRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["s3:ListBucket"],
          resources: [`arn:aws:s3:::${cacheBucketName}`],
        })
      );

      // Inject the bucket name into the runner environment so runs-on/cache
      // can use it without any per-workflow configuration.
      webhookFn.addEnvironment("CACHE_BUCKET_NAME", cacheBucketName);
    }

    // -------------------------------------------------------------------------
    // Optional: GitHub OIDC authentication
    // -------------------------------------------------------------------------
    if (oidcPolicyArn !== undefined && oidcSubjectPattern !== undefined) {
      // GitHub's OIDC provider — one per AWS account. If another stack in
      // the same account already manages this provider, import it instead:
      // iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(...)
      const githubOidcProvider = new iam.OpenIdConnectProvider(
        this,
        "GithubOidcProvider",
        {
          url: "https://token.actions.githubusercontent.com",
          clientIds: ["sts.amazonaws.com"],
          // AWS validates GitHub's certificate automatically; the thumbprint
          // is required by CloudFormation but not used for chain validation.
          thumbprints: ["6938fd4d98bab03faadb97b34396831e3780aea1"],
        }
      );

      const oidcRole = new iam.Role(this, "OidcRole", {
        assumedBy: new iam.WebIdentityPrincipal(
          githubOidcProvider.openIdConnectProviderArn,
          {
            StringEquals: {
              "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
            },
            StringLike: {
              "token.actions.githubusercontent.com:sub": oidcSubjectPattern,
            },
          }
        ),
        description: "Assumed by GitHub Actions workflows via OIDC",
      });

      oidcRole.addManagedPolicy(
        iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "OidcRoleManagedPolicy",
          oidcPolicyArn
        )
      );

      const oidcFn = new NodejsFunction(this, "OidcFn", {
        runtime: lambda.Runtime.NODEJS_22_X,
        entry: path.join(__dirname, "../lambda/oidc/index.ts"),
        handler: "handler",
        timeout: cdk.Duration.minutes(1),
        bundling: {
          externalModules: lambdaExternalModules,
        },
      });

      oidcFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter", "ssm:GetParameters"],
          resources: [
            ssmArn(this, SSM_GITHUB_TOKEN),
            ssmArn(this, SSM_TARGET_TYPE),
            ssmArn(this, SSM_TARGET_SLUG),
          ],
        })
      );

      const oidcProvider = new cr.Provider(this, "OidcProvider", {
        onEventHandler: oidcFn,
      });

      new cdk.CustomResource(this, "GithubOidcConfiguration", {
        serviceToken: oidcProvider.serviceToken,
        resourceType: "Custom::GithubOidcConfiguration",
        properties: {
          RoleArn: oidcRole.roleArn,
          GithubTokenParam: SSM_GITHUB_TOKEN,
          TargetTypeParam: SSM_TARGET_TYPE,
          TargetSlugParam: SSM_TARGET_SLUG,
        },
      });

      new cdk.CfnOutput(this, "OidcRoleArn", {
        value: oidcRole.roleArn,
        description: "IAM role ARN for GitHub Actions OIDC authentication",
      });
    }

    // -------------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------------
    new cdk.CfnOutput(this, "WebhookApiUrl", {
      value: api.urlForPath("/webhook"),
      description: "URL to register as the GitHub webhook endpoint",
    });

    new cdk.CfnOutput(this, "IpUpdaterFunctionName", {
      value: ipUpdaterFn.functionName,
      description: "IP updater Lambda function name — invoke manually to refresh GitHub webhook IPs immediately",
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
