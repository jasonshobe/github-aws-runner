import * as crypto from "crypto";
import {
  EC2Client,
  RunInstancesCommand,
  ResourceType,
} from "@aws-sdk/client-ec2";
import {
  SSMClient,
  GetParameterCommand,
  GetParametersCommand,
} from "@aws-sdk/client-ssm";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { generateJitConfig } from "./github-client";

const ec2 = new EC2Client({});
const ssm = new SSMClient({});

// Cached SSM values — populated on first invocation, reused on warm starts.
let cachedWebhookSecret: string | undefined;
let cachedParams:
  | {
      githubToken: string;
      targetType: string;
      targetSlug: string;
    }
  | undefined;

async function getWebhookSecret(): Promise<string> {
  if (cachedWebhookSecret) return cachedWebhookSecret;
  const result = await ssm.send(
    new GetParameterCommand({
      Name: process.env.WEBHOOK_SECRET_PARAM!,
      WithDecryption: true,
    })
  );
  cachedWebhookSecret = result.Parameter!.Value!;
  return cachedWebhookSecret;
}

async function getParams(): Promise<{
  githubToken: string;
  targetType: string;
  targetSlug: string;
}> {
  if (cachedParams) return cachedParams;
  const result = await ssm.send(
    new GetParametersCommand({
      Names: [
        process.env.GITHUB_TOKEN_PARAM!,
        process.env.TARGET_TYPE_PARAM!,
        process.env.TARGET_SLUG_PARAM!,
      ],
      WithDecryption: true,
    })
  );
  const byName = Object.fromEntries(
    (result.Parameters ?? []).map((p: { Name?: string; Value?: string }) => [p.Name!, p.Value!])
  );
  cachedParams = {
    githubToken: byName[process.env.GITHUB_TOKEN_PARAM!],
    targetType: byName[process.env.TARGET_TYPE_PARAM!],
    targetSlug: byName[process.env.TARGET_SLUG_PARAM!],
  };
  return cachedParams;
}

function verifySignature(secret: string, body: string, header: string): boolean {
  const expected = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex")}`;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(header, "utf8")
    );
  } catch {
    return false;
  }
}

function buildUserData(encodedJitConfig: string): string {
  const script = `#!/bin/bash
set -euxo pipefail
JIT_CONFIG="${encodedJitConfig}"
cd /home/runner/actions-runner
./run.sh --jitconfig "\${JIT_CONFIG}"
shutdown -h now
`;
  return Buffer.from(script).toString("base64");
}

export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const githubEvent = event.headers["x-github-event"] ?? event.headers["X-GitHub-Event"];
  const signatureHeader =
    event.headers["x-hub-signature-256"] ?? event.headers["X-Hub-Signature-256"];
  const rawBody = event.body ?? "";

  // Validate signature
  if (!signatureHeader) {
    console.warn("Missing x-hub-signature-256 header");
    return { statusCode: 401, body: "Unauthorized" };
  }

  const secret = await getWebhookSecret();
  if (!verifySignature(secret, rawBody, signatureHeader)) {
    console.warn("Webhook signature validation failed");
    return { statusCode: 401, body: "Unauthorized" };
  }

  // Parse and filter events
  if (githubEvent !== "workflow_job") {
    return { statusCode: 200, body: "OK" };
  }

  const payload = JSON.parse(rawBody) as {
    action: string;
    workflow_job: {
      id: number;
      labels: string[];
    };
  };

  if (payload.action !== "queued") {
    return { statusCode: 200, body: "OK" };
  }

  if (!payload.workflow_job.labels.includes("self-hosted")) {
    return { statusCode: 200, body: "OK" };
  }

  const jobId = payload.workflow_job.id;
  console.log(`Processing workflow_job.queued event for job ${jobId}`);

  const { githubToken, targetType, targetSlug } = await getParams();

  // Generate JIT runner config
  const { encodedJitConfig } = await generateJitConfig(
    jobId,
    targetType,
    targetSlug,
    githubToken
  );
  console.log(`Generated JIT config for job ${jobId}`);

  // Launch EC2 instance
  const launchTime = new Date().toISOString();
  const instanceName = `github-runner-${jobId}`;

  await ec2.send(
    new RunInstancesCommand({
      ImageId: process.env.AMI_ID!,
      InstanceType: (process.env.INSTANCE_TYPE ?? "c7a.large") as never,
      MinCount: 1,
      MaxCount: 1,
      SubnetId: process.env.SUBNET_ID!,
      SecurityGroupIds: [process.env.SECURITY_GROUP_ID!],
      IamInstanceProfile: { Arn: process.env.INSTANCE_PROFILE_ARN! },
      UserData: buildUserData(encodedJitConfig),
      InstanceInitiatedShutdownBehavior: "terminate",
      TagSpecifications: [
        {
          ResourceType: ResourceType.instance,
          Tags: [
            { Key: "Name", Value: instanceName },
            { Key: "github-aws-runner:managed", Value: "true" },
            { Key: "github-aws-runner:launch-time", Value: launchTime },
            { Key: "github-aws-runner:job-id", Value: String(jobId) },
          ],
        },
      ],
    })
  );

  console.log(`Launched EC2 instance for job ${jobId}`);
  return { statusCode: 200, body: "OK" };
}
