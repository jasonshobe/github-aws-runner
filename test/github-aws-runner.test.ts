import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { GithubAwsRunnerStack } from "../lib/github-aws-runner-stack";

const FAKE_WEBHOOK_IPS = ["140.82.112.0/20", "185.199.108.0/22"];

function buildTemplate(parameters: Record<string, string> = {}, prefix = "/github-aws-runner"): Template {
  const app = new cdk.App();
  app.node.setContext("ssmPrefix", prefix);
  for (const [name, value] of Object.entries(parameters)) {
    app.node.setContext(
      `ssm:account=123456789012:parameterName=${prefix}/${name}:region=us-east-1`,
      value
    );
  }
  app.node.setContext(
    "availability-zones:account=123456789012:region=us-east-1",
    ["us-east-1a", "us-east-1c", "us-east-1-bos-1a", "us-east-1b"]
  );
  const stack = new GithubAwsRunnerStack(app, "TestStack", {
    initialWebhookIps: FAKE_WEBHOOK_IPS,
    env: { account: "123456789012", region: "us-east-1" },
  });
  return Template.fromStack(stack);
}

describe("GithubAwsRunnerStack", () => {
  let template: Template;

  beforeAll(() => {
    template = buildTemplate();
  });

  test("enables DNS on the VPC", () => {
    template.hasResourceProperties("AWS::EC2::VPC", {
      EnableDnsHostnames: true,
      EnableDnsSupport: true,
    });
  });

  test("keeps the original subnet unchanged so upgrades never replace it", () => {
    const subnets = template.findResources("AWS::EC2::Subnet");
    expect(subnets.RunnerVpcpublicSubnet1Subnet740263F6.Properties.CidrBlock).toBe("10.0.0.0/16");
  });

  test("adds a secondary CIDR and one /21 public subnet per extra standard AZ", () => {
    template.hasResourceProperties("AWS::EC2::VPCCidrBlock", { CidrBlock: "10.1.0.0/16" });
    template.resourceCountIs("AWS::EC2::Subnet", 3); // 1a (original), 1b, 1c — not the Local Zone
    template.hasResourceProperties("AWS::EC2::Subnet", {
      AvailabilityZone: "us-east-1b", CidrBlock: "10.1.8.0/21", MapPublicIpOnLaunch: true,
    });
    template.hasResourceProperties("AWS::EC2::Subnet", {
      AvailabilityZone: "us-east-1c", CidrBlock: "10.1.16.0/21", MapPublicIpOnLaunch: true,
    });
  });

  test("routes each extra subnet to the internet gateway", () => {
    // Original subnet's route plus one per extra subnet.
    template.resourcePropertiesCountIs("AWS::EC2::Route",
      { DestinationCidrBlock: "0.0.0.0/0", GatewayId: Match.anyValue() }, 3);
  });

  test("webhook and reconciler Lambdas receive SUBNET_IDS instead of SUBNET_ID", () => {
    const fns = Object.values(template.findResources("AWS::Lambda::Function")).filter(
      (f: any) => f.Properties?.Environment?.Variables?.SPOT_ENABLED_PARAM !== undefined
    );
    expect(fns).toHaveLength(2);
    for (const fn of fns as any[]) {
      expect(fn.Properties.Environment.Variables.SUBNET_IDS).toBeDefined();
      expect(fn.Properties.Environment.Variables.SUBNET_ID).toBeUndefined();
      // Subnet 1 first, then the extras in AZ-letter order whatever order the AZs arrive in.
      const subnets = template.findResources("AWS::EC2::Subnet");
      const logicalIdFor = (az: string) =>
        Object.keys(subnets).find((id) => subnets[id].Properties.AvailabilityZone === az);
      const refs = fn.Properties.Environment.Variables.SUBNET_IDS["Fn::Join"][1].filter((part: unknown) => part !== ",");
      expect(refs).toEqual([
        { Ref: "RunnerVpcpublicSubnet1Subnet740263F6" },
        { Ref: logicalIdFor("us-east-1b") },
        { Ref: logicalIdFor("us-east-1c") },
      ]);
    }
  });

  test("creates a security group with no ingress rules", () => {
    template.hasResourceProperties("AWS::EC2::SecurityGroup", {
      GroupDescription: "Security group for GitHub Actions runner EC2 instances",
    });
  });

  test("creates an EC2 instance role and instance profile", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: "ec2.amazonaws.com" },
            Action: "sts:AssumeRole",
          }),
        ]),
      }),
    });
    template.resourceCountIs("AWS::IAM::InstanceProfile", 1);
  });

  test("creates a REST API named github-aws-runner-webhook", () => {
    template.hasResourceProperties("AWS::ApiGateway::RestApi", {
      Name: "github-aws-runner-webhook",
    });
  });

  test("configures the API Gateway CloudWatch Logs role required for access logs", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: "apigateway.amazonaws.com" },
            Action: "sts:AssumeRole",
          }),
        ]),
      }),
      ManagedPolicyArns: Match.anyValue(),
    });

    template.hasResourceProperties("AWS::ApiGateway::Account", {
      CloudWatchRoleArn: Match.anyValue(),
    });
  });

  test("REST API has a resource policy denying non-GitHub IPs", () => {
    template.hasResourceProperties("AWS::ApiGateway::RestApi", {
      Policy: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Deny",
            Condition: Match.objectLike({
              NotIpAddress: Match.objectLike({
                "aws:SourceIp": Match.arrayWith(FAKE_WEBHOOK_IPS),
              }),
            }),
          }),
        ]),
      }),
    });
  });

  test("creates six Lambda functions (webhook, ip-updater, watchdog, reconciler, custom-resource, provider framework)", () => {
    template.resourceCountIs("AWS::Lambda::Function", 6);
  });

  test("creates three EventBridge rules (IP updater, watchdog and reconciler)", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(12 hours)",
    });
    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(15 minutes)",
    });
    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(2 minutes)",
    });
  });

  test("IP updater receives the deployed API and stage", () => {
    const apiId = Object.keys(template.findResources("AWS::ApiGateway::RestApi"))[0];
    const stageId = Object.keys(template.findResources("AWS::ApiGateway::Stage", {
      Properties: { RestApiId: { Ref: apiId }, StageName: "prod" },
    }))[0];
    expect(stageId).toBeDefined();
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          REST_API_ID: { Ref: apiId },
          REST_API_STAGE_NAME: { Ref: stageId },
          ACCOUNT_ID: "123456789012",
        }),
      },
    });
  });

  test("IP updater can update the API policy and create deployments only for its API", () => {
    const apiId = Object.keys(template.findResources("AWS::ApiGateway::RestApi"))[0];
    const updaterId = Object.keys(template.findResources("AWS::Lambda::Function"))
      .find((id) => id.startsWith("IpUpdaterFn"))!;
    const updater = template.toJSON().Resources[updaterId];
    const roleId = updater.Properties.Role["Fn::GetAtt"][0];
    const apiArn = {
      "Fn::Join": ["", ["arn:aws:apigateway:us-east-1::/restapis/", { Ref: apiId }]],
    };
    const deploymentsArn = {
      "Fn::Join": ["", ["arn:aws:apigateway:us-east-1::/restapis/", { Ref: apiId }, "/deployments"]],
    };
    template.hasResourceProperties("AWS::IAM::Policy", {
      Roles: [{ Ref: roleId }],
      PolicyDocument: {
        Version: "2012-10-17",
        Statement: Match.arrayWith([
          {
            Effect: "Allow",
            Action: ["apigateway:PATCH", "apigateway:UpdateRestApiPolicy"],
            Resource: apiArn,
          },
          {
            Effect: "Allow",
            Action: "apigateway:POST",
            Resource: deploymentsArn,
          },
        ]),
      },
    });
  });

  test("creates the queued jobs table with a TTL attribute", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [{ AttributeName: "jobId", KeyType: "HASH" }],
      BillingMode: "PAY_PER_REQUEST",
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    });
  });

  test("webhook Lambda can record and clear queued job rows", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["dynamodb:PutItem", "dynamodb:DeleteItem"]),
          }),
        ]),
      }),
    });
  });

  test("reconciler Lambda can launch replacement runners", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "ec2:RunInstances",
            Condition: {
              StringEquals: {
                "aws:RequestTag/github-aws-runner:managed": "true",
              },
            },
          }),
        ]),
      }),
    });
  });

  test("creates a custom resource for GitHub webhook registration", () => {
    template.resourceCountIs("Custom::GithubWebhookRegistration", 1);
  });

  test("outputs the webhook API URL", () => {
    template.hasOutput("WebhookApiUrl", {});
  });

  test("webhook Lambda has required environment variables", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          GITHUB_TOKEN_PARAM: "/github-aws-runner/github-token",
          WEBHOOK_SECRET_PARAM: "/github-aws-runner/webhook-secret",
          TARGET_TYPE_PARAM: "/github-aws-runner/target-type",
          TARGET_SLUG_PARAM: "/github-aws-runner/target-slug",
          AMI_NAME_PARAM: "/github-aws-runner/ami-name",
          AMI_OWNERS_PARAM: "/github-aws-runner/ami-owners",
        }),
      }),
    });
  });

  test("allows webhook Lambda to launch tagged instances with required supporting EC2 resources", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "ec2:RunInstances",
            Resource: "arn:aws:ec2:us-east-1:123456789012:instance/*",
            Condition: {
              StringEquals: {
                "aws:RequestTag/github-aws-runner:managed": "true",
              },
            },
          }),
          Match.objectLike({
            Action: "ec2:RunInstances",
            Resource: Match.arrayWith([
              "arn:aws:ec2:us-east-1::image/*",
              "arn:aws:ec2:us-east-1:123456789012:network-interface/*",
              "arn:aws:ec2:us-east-1:123456789012:security-group/*",
              "arn:aws:ec2:us-east-1:123456789012:subnet/*",
              "arn:aws:ec2:us-east-1:123456789012:volume/*",
              "arn:aws:ec2:us-east-1:123456789012:spot-instances-request/*",
            ]),
          }),
        ]),
      },
    });
  });

  test("webhook and reconciler Lambdas receive the Spot parameter names", () => {
    const fns = Object.values(template.findResources("AWS::Lambda::Function")).filter(
      (f: any) =>
        f.Properties?.Environment?.Variables?.SPOT_ENABLED_PARAM === "/github-aws-runner/spot-enabled" &&
        f.Properties?.Environment?.Variables?.SPOT_REQUIRED_PARAM === "/github-aws-runner/spot-required"
    );
    expect(fns).toHaveLength(2);
  });

  test("launching Lambdas may create only the EC2 Spot service-linked role", () => {
    const policies = Object.values(template.findResources("AWS::IAM::Policy")).filter((p: any) =>
      (p.Properties.PolicyDocument.Statement as any[]).some(
        (st) =>
          st.Action === "iam:CreateServiceLinkedRole" &&
          st.Condition?.StringEquals?.["iam:AWSServiceName"] === "spot.amazonaws.com"
      )
    );
    expect(policies).toHaveLength(2);
  });

  test("launching Lambdas may read the Spot SSM parameters", () => {
    const json = JSON.stringify(template.findResources("AWS::IAM::Policy"));
    expect(json.split(":parameter/github-aws-runner/spot-enabled").length - 1).toBe(2);
    expect(json.split(":parameter/github-aws-runner/spot-required").length - 1).toBe(2);
  });
});

describe("OIDC subject patterns", () => {
  const policyArn = "arn:aws:iam::123456789012:policy/MyWorkflowPolicy";

  test.each([
    "repo:myorg/*:*",
    "repo:myorg/myrepo:ref:refs/heads/main",
    "repo:myorg@123/myrepo@456:ref:refs/heads/main",
    "repository_id:456:environment:Production",
  ])("preserves the existing single subject value %s", (subject) => {
    const template = buildTemplate({
      "oidc-role-policy-arn": policyArn,
      "oidc-subject-pattern": subject,
    });
    expectOidcTrust(template, subject);
  });

  test("trusts both legacy and immutable subjects from a JSON array", () => {
    const template = buildTemplate({
      "oidc-role-policy-arn": policyArn,
      "oidc-subject-pattern": '["repo:myorg/*:*","repo:myorg@123/*:*"]',
    });
    expectOidcTrust(template, ["repo:myorg/*:*", "repo:myorg@123/*:*"]);
  });

  test("supports exact subjects in an array with a custom SSM prefix", () => {
    const template = buildTemplate({
      "oidc-role-policy-arn": policyArn,
      "oidc-subject-pattern": ' ["repo:myorg/myrepo:ref:refs/heads/main", "repo:myorg@123/myrepo@456:ref:refs/heads/main"] ',
    }, "/custom-runner");
    expectOidcTrust(template, [
      "repo:myorg/myrepo:ref:refs/heads/main",
      "repo:myorg@123/myrepo@456:ref:refs/heads/main",
    ]);
  });

  test.each([
    "[]",
    '["repo:myorg/*:*", 123]',
    '["repo:myorg/*:*", null]',
    '["repo:myorg/*:*", ""]',
    '["   "]',
    '["repo:myorg/*:*"',
  ])("rejects invalid subject arrays at synth time: %s", (subject) => {
    expect(() => buildTemplate({
      "oidc-role-policy-arn": policyArn,
      "oidc-subject-pattern": subject,
    })).toThrow(/oidc-subject-pattern.*non-empty JSON array of non-empty strings/);
  });

  test.each<Record<string, string>>([
    {},
    { "oidc-role-policy-arn": policyArn },
    { "oidc-role-policy-arn": policyArn, "oidc-subject-pattern": "" },
    { "oidc-subject-pattern": '["repo:myorg/*:*"]' },
  ])("leaves OIDC disabled when either parameter is missing: %j", (parameters) => {
    const template = buildTemplate(parameters);
    template.resourceCountIs("Custom::GithubOidcConfiguration", 0);
    template.resourceCountIs("AWS::IAM::OIDCProvider", 0);
  });
});

function expectOidcTrust(template: Template, subjects: string | string[]): void {
  template.hasResourceProperties("AWS::IAM::Role", {
    Description: "Assumed by GitHub Actions workflows via OIDC",
    ManagedPolicyArns: ["arn:aws:iam::123456789012:policy/MyWorkflowPolicy"],
    AssumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Action: "sts:AssumeRoleWithWebIdentity",
        Principal: { Federated: Match.anyValue() },
        Condition: {
          StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
          StringLike: { "token.actions.githubusercontent.com:sub": subjects },
        },
      }],
    },
  });
  template.resourceCountIs("Custom::GithubOidcConfiguration", 1);
  template.hasOutput("OidcRoleArn", {});
}
