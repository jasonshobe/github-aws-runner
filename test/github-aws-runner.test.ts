import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { GithubAwsRunnerStack } from "../lib/github-aws-runner-stack";

const FAKE_WEBHOOK_IPS = ["140.82.112.0/20", "185.199.108.0/22"];

function buildTemplate(): Template {
  const app = new cdk.App();
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

  test("creates a VPC with a public subnet", () => {
    template.hasResourceProperties("AWS::EC2::VPC", {
      EnableDnsHostnames: true,
      EnableDnsSupport: true,
    });
    template.resourceCountIs("AWS::EC2::Subnet", 1);
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

  test("creates five Lambda functions (webhook, ip-updater, watchdog, custom-resource, provider framework)", () => {
    template.resourceCountIs("AWS::Lambda::Function", 5);
  });

  test("creates two EventBridge rules (IP updater and watchdog)", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(12 hours)",
    });
    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(15 minutes)",
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
});
