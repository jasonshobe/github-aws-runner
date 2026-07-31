import * as crypto from "crypto";
import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import {
  DynamoDBClient,
  PutItemCommand,
  DeleteItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  SSMClient,
  GetParameterCommand,
  GetParametersCommand,
} from "@aws-sdk/client-ssm";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { buildRunnerName, launchRunner, TAG_MANAGED } from "../shared/launcher";

const ec2 = new EC2Client({});
const ssm = new SSMClient({});
const dynamo = new DynamoDBClient({});

/**
 * How long a queued-jobs row survives if neither `in_progress` nor `completed`
 * ever arrives for it. Purely a backstop against leaked rows; the reconciler
 * relies on the row being removed promptly by those events.
 */
const ROW_TTL_SECONDS = 24 * 60 * 60;

// Cached values — populated on first invocation, reused on warm starts.
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

async function getParams(): Promise<NonNullable<typeof cachedParams>> {
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
    (result.Parameters ?? []).map((p: { Name?: string; Value?: string }) => [
      p.Name!,
      p.Value!,
    ])
  );
  const allowedRaw = byName[process.env.ALLOWED_INSTANCE_TYPES_PARAM!];
  const maxEbsRaw = byName[process.env.MAX_EBS_VOLUME_SIZE_PARAM!];
  cachedParams = {
    githubToken: byName[process.env.GITHUB_TOKEN_PARAM!],
    targetType: byName[process.env.TARGET_TYPE_PARAM!],
    targetSlug: byName[process.env.TARGET_SLUG_PARAM!],
    instanceType: byName[process.env.INSTANCE_TYPE_PARAM!],
    ebsVolumeSizeGb: parseInt(byName[process.env.EBS_VOLUME_SIZE_PARAM!], 10),
    maxConcurrentRunners: parseInt(
      byName[process.env.MAX_CONCURRENT_RUNNERS_PARAM!],
      10
    ),
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
          { Name: `tag:${TAG_MANAGED}`, Values: ["true"] },
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
    console.warn(
      `timeout label "${labelValue}" is not a valid number, using default ${defaultTimeout}m`
    );
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
    console.warn(
      `disk label "${labelValue}" is not a valid size, using default ${defaultSize}GB`
    );
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

export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const githubEvent =
    event.headers["x-github-event"] ?? event.headers["X-GitHub-Event"];
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
    repository?: { full_name?: string };
    workflow_job: {
      id: number;
      labels: string[];
    };
  };

  if (!payload.workflow_job.labels.includes("self-hosted")) {
    return { statusCode: 200, body: "OK" };
  }

  const jobId = String(payload.workflow_job.id);

  // A job that has started or finished is no longer part of the backlog the
  // reconciler needs to cover. Note that GitHub may hand the job to a runner
  // minted for a *different* job, so this is the only reliable signal that this
  // particular job left the queue.
  if (payload.action === "in_progress" || payload.action === "completed") {
    await dynamo.send(
      new DeleteItemCommand({
        TableName: process.env.QUEUED_JOBS_TABLE!,
        Key: { jobId: { S: jobId } },
      })
    );
    console.log(`Cleared queued-job row for job ${jobId} (${payload.action})`);
    return { statusCode: 200, body: "OK" };
  }

  if (payload.action !== "queued") {
    return { statusCode: 200, body: "OK" };
  }

  const {
    githubToken,
    targetType,
    targetSlug,
    instanceType,
    ebsVolumeSizeGb,
    maxConcurrentRunners,
    runnerTimeoutMinutes,
    runnerLabel,
    allowedInstanceTypes,
    maxEbsVolumeSizeGb,
  } = await getParams();

  if (runnerLabel && !payload.workflow_job.labels.includes(runnerLabel)) {
    console.log(
      `Job ${jobId} does not include required label "${runnerLabel}", ignoring`
    );
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

  const runnerName = buildRunnerName(jobId);
  const queuedAt = new Date().toISOString();

  // Recorded before the runner is minted so the reconciler never prunes a
  // registration whose instance has not appeared in EC2 yet.
  await dynamo.send(
    new PutItemCommand({
      TableName: process.env.QUEUED_JOBS_TABLE!,
      Item: {
        jobId: { S: jobId },
        queuedAt: { S: queuedAt },
        runnerName: { S: runnerName },
        // Lets the reconciler re-check on GitHub whether the job is still
        // waiting before it spends money on extra capacity.
        ...(payload.repository?.full_name
          ? { repo: { S: payload.repository.full_name } }
          : {}),
        instanceType: { S: resolvedInstanceType },
        ebsSizeGb: { N: String(resolvedEbsSize) },
        timeoutMinutes: { N: String(resolvedTimeoutMinutes) },
        expiresAt: {
          N: String(Math.floor(Date.parse(queuedAt) / 1000) + ROW_TTL_SECONDS),
        },
      },
    })
  );

  // Enforce concurrent runner cap before launching. The row stays in the table,
  // so the reconciler picks this job up once capacity frees.
  const runningCount = await countRunningRunners();
  if (runningCount >= maxConcurrentRunners) {
    console.warn(
      `Concurrent runner limit reached (${runningCount}/${maxConcurrentRunners}), deferring job ${jobId} to the reconciler`
    );
    return { statusCode: 200, body: "OK" };
  }

  await launchRunner({
    jobId,
    runnerName,
    instanceType: resolvedInstanceType,
    ebsSizeGb: resolvedEbsSize,
    timeoutMinutes: resolvedTimeoutMinutes,
    targetType,
    targetSlug,
    githubToken,
  });

  return { statusCode: 200, body: "OK" };
}
