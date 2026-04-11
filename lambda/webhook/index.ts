import * as crypto from "crypto";
import {
  EC2Client,
  RunInstancesCommand,
  DescribeInstancesCommand,
  DescribeImagesCommand,
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

const DEFAULT_AMI_NAME = "runs-on-v2.*-ubuntu22-full-x64-*";
const DEFAULT_AMI_OWNERS = ["135269210855"];

// Cached values — populated on first invocation, reused on warm starts.
let cachedAmiId: string | undefined;
let cachedWebhookSecret: string | undefined;
let cachedParams:
  | {
      githubToken: string;
      targetType: string;
      targetSlug: string;
      instanceType: string;
      ebsVolumeSizeGb: number;
      maxConcurrentRunners: number;
      runnerTimeoutMinutes: number;
      runnerLabel: string | undefined;
      allowedInstanceTypes: string[] | undefined;
      maxEbsVolumeSizeGb: number | undefined;
    }
  | undefined;

async function resolveAmiId(): Promise<string> {
  if (cachedAmiId) return cachedAmiId;

  // Read optional SSM params; fall back to defaults if not set.
  let amiName = DEFAULT_AMI_NAME;
  let amiOwners = DEFAULT_AMI_OWNERS;

  const paramNames = [
    process.env.AMI_NAME_PARAM!,
    process.env.AMI_OWNERS_PARAM!,
  ].filter(Boolean);

  if (paramNames.length > 0) {
    const paramResult = await ssm.send(
      new GetParametersCommand({ Names: paramNames })
    );
    const byName = Object.fromEntries(
      (paramResult.Parameters ?? []).map((p: { Name?: string; Value?: string }) => [p.Name!, p.Value!])
    );
    if (byName[process.env.AMI_NAME_PARAM!]) {
      amiName = byName[process.env.AMI_NAME_PARAM!];
    }
    if (byName[process.env.AMI_OWNERS_PARAM!]) {
      amiOwners = byName[process.env.AMI_OWNERS_PARAM!].split(",").map((s) => s.trim()).filter(Boolean);
    }
  }

  const imageResult = await ec2.send(
    new DescribeImagesCommand({
      Filters: [
        { Name: "name", Values: [amiName] },
        { Name: "state", Values: ["available"] },
      ],
      Owners: amiOwners,
    })
  );

  const images = (imageResult.Images ?? []).sort((a, b) =>
    (b.CreationDate ?? "").localeCompare(a.CreationDate ?? "")
  );

  if (images.length === 0) {
    throw new Error(
      `No AMI found matching name pattern "${amiName}" owned by ${amiOwners.join(", ")}`
    );
  }

  cachedAmiId = images[0].ImageId!;
  console.log(`Resolved AMI: ${cachedAmiId} (${images[0].Name})`);
  return cachedAmiId;
}

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
  instanceType: string;
  ebsVolumeSizeGb: number;
  maxConcurrentRunners: number;
  runnerTimeoutMinutes: number;
  runnerLabel: string | undefined;
  allowedInstanceTypes: string[] | undefined;
  maxEbsVolumeSizeGb: number | undefined;
}> {
  if (cachedParams) return cachedParams;
  const result = await ssm.send(
    new GetParametersCommand({
      Names: [
        process.env.GITHUB_TOKEN_PARAM!,
        process.env.TARGET_TYPE_PARAM!,
        process.env.TARGET_SLUG_PARAM!,
        process.env.INSTANCE_TYPE_PARAM!,
        process.env.EBS_VOLUME_SIZE_PARAM!,
        process.env.MAX_CONCURRENT_RUNNERS_PARAM!,
        process.env.RUNNER_TIMEOUT_PARAM!,
        process.env.RUNNER_LABEL_PARAM!,
        process.env.ALLOWED_INSTANCE_TYPES_PARAM!,
        process.env.MAX_EBS_VOLUME_SIZE_PARAM!,
      ],
      WithDecryption: true,
    })
  );
  const byName = Object.fromEntries(
    (result.Parameters ?? []).map((p: { Name?: string; Value?: string }) => [p.Name!, p.Value!])
  );
  const allowedRaw = byName[process.env.ALLOWED_INSTANCE_TYPES_PARAM!];
  const maxEbsRaw = byName[process.env.MAX_EBS_VOLUME_SIZE_PARAM!];
  cachedParams = {
    githubToken: byName[process.env.GITHUB_TOKEN_PARAM!],
    targetType: byName[process.env.TARGET_TYPE_PARAM!],
    targetSlug: byName[process.env.TARGET_SLUG_PARAM!],
    instanceType: byName[process.env.INSTANCE_TYPE_PARAM!],
    ebsVolumeSizeGb: parseInt(byName[process.env.EBS_VOLUME_SIZE_PARAM!], 10),
    maxConcurrentRunners: parseInt(byName[process.env.MAX_CONCURRENT_RUNNERS_PARAM!], 10),
    runnerTimeoutMinutes: parseInt(byName[process.env.RUNNER_TIMEOUT_PARAM!], 10),
    // Optional — omitted from byName if the SSM parameter does not exist
    runnerLabel: byName[process.env.RUNNER_LABEL_PARAM!],
    allowedInstanceTypes: allowedRaw
      ? allowedRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined,
    maxEbsVolumeSizeGb: maxEbsRaw ? parseInt(maxEbsRaw, 10) : undefined,
  };
  return cachedParams;
}

async function countRunningRunners(): Promise<number> {
  let count = 0;
  let nextToken: string | undefined;
  do {
    const result = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: "tag:github-aws-runner:managed", Values: ["true"] },
          { Name: "instance-state-name", Values: ["pending", "running"] },
        ],
        NextToken: nextToken,
      })
    );
    for (const reservation of result.Reservations ?? []) {
      count += reservation.Instances?.length ?? 0;
    }
    nextToken = result.NextToken;
  } while (nextToken);
  return count;
}

function parseLabelValue(labels: string[], prefix: string): string | undefined {
  const label = labels.find((l) => l.startsWith(`${prefix}:`));
  return label ? label.slice(prefix.length + 1) : undefined;
}

function resolveInstanceType(
  labels: string[],
  defaultType: string,
  allowedTypes: string[] | undefined
): string {
  const labelValue = parseLabelValue(labels, "instance-type");
  if (!labelValue) return defaultType;
  if (!allowedTypes) {
    console.warn(
      `instance-type label "${labelValue}" ignored: allowed-instance-types SSM parameter not configured`
    );
    return defaultType;
  }
  if (!allowedTypes.includes(labelValue)) {
    console.warn(
      `instance-type label "${labelValue}" is not in the allowed list, using default "${defaultType}"`
    );
    return defaultType;
  }
  return labelValue;
}

function resolveTimeout(
  labels: string[],
  defaultTimeout: number,
  maxTimeout: number
): number {
  const labelValue = parseLabelValue(labels, "timeout");
  if (!labelValue) return defaultTimeout;
  const parsed = parseInt(labelValue, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    console.warn(`timeout label "${labelValue}" is not a valid number, using default ${defaultTimeout}m`);
    return defaultTimeout;
  }
  if (parsed > maxTimeout) {
    console.warn(`timeout label ${parsed}m exceeds max ${maxTimeout}m, capping`);
    return maxTimeout;
  }
  return parsed;
}

function resolveEbsSize(
  labels: string[],
  defaultSize: number,
  maxSize: number | undefined
): number {
  const labelValue = parseLabelValue(labels, "disk");
  if (!labelValue) return defaultSize;
  const parsed = parseInt(labelValue, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    console.warn(`disk label "${labelValue}" is not a valid size, using default ${defaultSize}GB`);
    return defaultSize;
  }
  if (maxSize !== undefined && parsed > maxSize) {
    console.warn(`disk label ${parsed}GB exceeds max ${maxSize}GB, capping`);
    return maxSize;
  }
  return parsed;
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildUserData(encodedJitConfig: string, cacheBucket?: string): string {
  const cacheEnv = cacheBucket
    ? `export RUNS_ON_S3_BUCKET_CACHE=${shellQuote(cacheBucket)}\n`
    : "";
  const script = `#!/bin/bash
set -euo pipefail

exec > >(tee -a /var/log/github-aws-runner-user-data.log | logger -t github-aws-runner-user-data -s 2>/dev/console) 2>&1

shutdown_on_exit() {
  local status=$?
  echo "Runner bootstrap exiting with status \${status}"
  shutdown -h now
}
trap shutdown_on_exit EXIT

JIT_CONFIG=${shellQuote(encodedJitConfig)}
${cacheEnv}
if ! id -u runner >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash runner
fi

install -d -o runner -g runner /home/runner/actions-runner
cd /home/runner/actions-runner

if [ ! -x ./run.sh ]; then
  RUNNER_VERSION="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | sed -n 's/.*"tag_name": "v\\([^"]*\\)".*/\\1/p' | head -n 1)"
  if [ -z "\${RUNNER_VERSION}" ]; then
    echo "Unable to determine latest GitHub Actions runner version"
    exit 1
  fi

  curl -fsSL \
    -o actions-runner.tar.gz \
    "https://github.com/actions/runner/releases/download/v\${RUNNER_VERSION}/actions-runner-linux-x64-\${RUNNER_VERSION}.tar.gz"
  tar xzf actions-runner.tar.gz
  rm actions-runner.tar.gz
  chown -R runner:runner /home/runner/actions-runner
fi

sudo -E -u runner ./run.sh --jitconfig "\${JIT_CONFIG}"
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

  const {
    githubToken, targetType, targetSlug,
    instanceType, ebsVolumeSizeGb,
    maxConcurrentRunners, runnerTimeoutMinutes,
    runnerLabel, allowedInstanceTypes, maxEbsVolumeSizeGb,
  } = await getParams();

  if (runnerLabel && !payload.workflow_job.labels.includes(runnerLabel)) {
    console.log(`Job ${jobId} does not include required label "${runnerLabel}", ignoring`);
    return { statusCode: 200, body: "OK" };
  }

  // Resolve instance type, EBS size, and timeout from labels (with SSM defaults and constraints)
  const resolvedInstanceType = resolveInstanceType(
    payload.workflow_job.labels,
    instanceType,
    allowedInstanceTypes
  );
  const resolvedEbsSize = resolveEbsSize(
    payload.workflow_job.labels,
    ebsVolumeSizeGb,
    maxEbsVolumeSizeGb
  );
  const resolvedTimeoutMinutes = resolveTimeout(
    payload.workflow_job.labels,
    runnerTimeoutMinutes,
    runnerTimeoutMinutes
  );

  console.log(
    `Processing workflow_job.queued event for job ${jobId} ` +
    `(instance-type=${resolvedInstanceType}, disk=${resolvedEbsSize}GB, timeout=${resolvedTimeoutMinutes}m)`
  );

  // Enforce concurrent runner cap before launching
  const runningCount = await countRunningRunners();
  if (runningCount >= maxConcurrentRunners) {
    console.warn(
      `Concurrent runner limit reached (${runningCount}/${maxConcurrentRunners}), rejecting job ${jobId}`
    );
    return { statusCode: 503, body: "Service Unavailable" };
  }

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
      ImageId: await resolveAmiId(),
      InstanceType: resolvedInstanceType as never,
      MinCount: 1,
      MaxCount: 1,
      SubnetId: process.env.SUBNET_ID!,
      SecurityGroupIds: [process.env.SECURITY_GROUP_ID!],
      IamInstanceProfile: { Arn: process.env.INSTANCE_PROFILE_ARN! },
      UserData: buildUserData(encodedJitConfig, process.env.CACHE_BUCKET_NAME),
      InstanceInitiatedShutdownBehavior: "terminate",
      BlockDeviceMappings: [
        {
          DeviceName: "/dev/sda1",
          Ebs: { VolumeSize: resolvedEbsSize, VolumeType: "gp3", DeleteOnTermination: true },
        },
      ],
      TagSpecifications: [
        {
          ResourceType: ResourceType.instance,
          Tags: [
            { Key: "Name", Value: instanceName },
            { Key: "github-aws-runner:managed", Value: "true" },
            { Key: "github-aws-runner:launch-time", Value: launchTime },
            { Key: "github-aws-runner:job-id", Value: String(jobId) },
            { Key: "github-aws-runner:timeout-minutes", Value: String(resolvedTimeoutMinutes) },
          ],
        },
      ],
    })
  );

  console.log(`Launched EC2 instance for job ${jobId}`);
  return { statusCode: 200, body: "OK" };
}
