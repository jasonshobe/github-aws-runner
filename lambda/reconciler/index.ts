import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import {
  DynamoDBClient,
  ScanCommand,
  DeleteItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import { deleteRunner, getJobStatus, listRunners } from "../webhook/github-client";
import {
  buildRunnerName,
  launchRunner,
  TAG_LAUNCH_TIME,
  TAG_MANAGED,
  TAG_RUNNER_NAME,
} from "../shared/launcher";
import {
  planLaunches,
  planRunnerPrune,
  type LiveInstance,
  type QueuedJob,
} from "./planner";

const ec2 = new EC2Client({});
const ssm = new SSMClient({});
const dynamo = new DynamoDBClient({});

const DEFAULT_GRACE_SECONDS = 180;
/**
 * How long an instance may run before its runner has to be `online` with GitHub
 * for it to still count as capacity. Comfortably above the ~20s a healthy runner
 * takes to register, so a slow boot is never mistaken for a dead one.
 */
const DEFAULT_BOOT_GRACE_SECONDS = 300;
const DEFAULT_MAX_TOP_UPS = 3;

async function getParams() {
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
        process.env.RECONCILER_GRACE_SECONDS_PARAM!,
        process.env.RECONCILER_BOOT_GRACE_SECONDS_PARAM!,
        process.env.RECONCILER_MAX_TOP_UPS_PARAM!,
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
  const graceRaw = parseInt(
    byName[process.env.RECONCILER_GRACE_SECONDS_PARAM!],
    10
  );
  const bootGraceRaw = parseInt(
    byName[process.env.RECONCILER_BOOT_GRACE_SECONDS_PARAM!],
    10
  );
  const maxTopUpsRaw = parseInt(
    byName[process.env.RECONCILER_MAX_TOP_UPS_PARAM!],
    10
  );
  return {
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
    graceSeconds: Number.isNaN(graceRaw) ? DEFAULT_GRACE_SECONDS : graceRaw,
    bootGraceSeconds: Number.isNaN(bootGraceRaw)
      ? DEFAULT_BOOT_GRACE_SECONDS
      : bootGraceRaw,
    maxTopUps: Number.isNaN(maxTopUpsRaw) ? DEFAULT_MAX_TOP_UPS : maxTopUpsRaw,
  };
}

async function scanQueuedJobs(): Promise<QueuedJob[]> {
  const jobs: QueuedJob[] = [];
  let startKey: Record<string, any> | undefined;
  do {
    const result = await dynamo.send(
      new ScanCommand({
        TableName: process.env.QUEUED_JOBS_TABLE!,
        ExclusiveStartKey: startKey,
      })
    );
    for (const item of result.Items ?? []) {
      if (!item.jobId?.S || !item.queuedAt?.S || !item.runnerName?.S) continue;
      jobs.push({
        jobId: item.jobId.S,
        queuedAt: item.queuedAt.S,
        runnerName: item.runnerName.S,
        repo: item.repo?.S,
        instanceType: item.instanceType?.S,
        ebsSizeGb: item.ebsSizeGb?.N ? parseInt(item.ebsSizeGb.N, 10) : undefined,
        timeoutMinutes: item.timeoutMinutes?.N
          ? parseInt(item.timeoutMinutes.N, 10)
          : undefined,
        topUps: item.topUps?.N ? parseInt(item.topUps.N, 10) : 0,
      });
    }
    startKey = result.LastEvaluatedKey;
  } while (startKey);
  return jobs;
}

async function describeLiveInstances(): Promise<LiveInstance[]> {
  const instances: LiveInstance[] = [];
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
      for (const instance of reservation.Instances ?? []) {
        instances.push({
          instanceId: instance.InstanceId!,
          runnerName: instance.Tags?.find((t) => t.Key === TAG_RUNNER_NAME)?.Value,
          launchedAt:
            instance.Tags?.find((t) => t.Key === TAG_LAUNCH_TIME)?.Value ??
            instance.LaunchTime?.toISOString(),
        });
      }
    }
    nextToken = result.NextToken;
  } while (nextToken);
  return instances;
}

export async function handler(): Promise<void> {
  const params = await getParams();

  const [queuedJobs, liveInstances, runners] = await Promise.all([
    scanQueuedJobs(),
    describeLiveInstances(),
    listRunners(params.targetType, params.targetSlug, params.githubToken),
  ]);

  const busy = runners.filter((r) => r.busy).length;
  console.log(
    `Reconciler: ${queuedJobs.length} queued job(s), ${liveInstances.length} live instance(s), ` +
      `${runners.length} registered runner(s) (${busy} busy)`
  );

  const now = Date.now();
  const { launchFor, discountedInstanceIds } = planLaunches({
    queuedJobs,
    runners,
    liveInstances,
    maxConcurrentRunners: params.maxConcurrentRunners,
    graceMs: params.graceSeconds * 1000,
    bootGraceMs: params.bootGraceSeconds * 1000,
    maxTopUps: params.maxTopUps,
    now,
  });

  if (discountedInstanceIds.length > 0) {
    // Not an error on its own: an ephemeral runner deregisters itself the moment
    // it finishes a job, so an instance in teardown legitimately shows up here.
    // It only matters when a job is waiting, which is what launchFor reflects.
    console.warn(
      `Reconciler: not counting ${discountedInstanceIds.length} instance(s) as capacity — no ` +
        `online runner past the ${params.bootGraceSeconds}s boot grace: ${discountedInstanceIds.join(", ")}. ` +
        `Left for the watchdog to retire.`
    );
  }

  const stalled = queuedJobs.filter(
    (j) => (j.topUps ?? 0) >= params.maxTopUps
  );
  for (const job of stalled) {
    console.warn(
      `Reconciler: job ${job.jobId} has already been given ${job.topUps} replacement runner(s) ` +
        `and is still queued — not launching more. Something is failing beyond this stack.`
    );
  }

  if (launchFor.length === 0) {
    console.log("Reconciler: runner supply covers the backlog, nothing to launch");
  }

  // Suffix keeps the replacement runner name distinct from the one the webhook
  // already minted for this job, which GitHub would otherwise reject with 409.
  const suffix = `r${now.toString(36)}`;
  let launched = 0;

  for (const [index, job] of launchFor.entries()) {
    const waitedSeconds = Math.round((now - Date.parse(job.queuedAt)) / 1000);

    // Confirm the job is genuinely still waiting. A row whose `in_progress` or
    // `completed` delivery was missed would otherwise drive a fresh launch every
    // time the previous idle instance timed out, until the row's TTL expired.
    if (job.repo) {
      let status: string | undefined;
      try {
        status = await getJobStatus(job.repo, job.jobId, params.githubToken);
      } catch (err) {
        console.error(
          `Reconciler: could not confirm status of job ${job.jobId}, skipping this pass`,
          err
        );
        continue;
      }

      if (status !== "queued") {
        console.log(
          `Reconciler: job ${job.jobId} is ${status ?? "gone"}, not queued — dropping its row`
        );
        await dynamo.send(
          new DeleteItemCommand({
            TableName: process.env.QUEUED_JOBS_TABLE!,
            Key: { jobId: { S: job.jobId } },
          })
        );
        continue;
      }
    }

    console.log(
      `Reconciler: job ${job.jobId} has been queued ${waitedSeconds}s with no runner capacity — launching a replacement`
    );
    try {
      await launchRunner({
        jobId: job.jobId,
        runnerName: buildRunnerName(job.jobId, `${suffix}${index}`),
        instanceType: job.instanceType ?? params.instanceType,
        ebsSizeGb: job.ebsSizeGb ?? params.ebsVolumeSizeGb,
        timeoutMinutes: job.timeoutMinutes ?? params.runnerTimeoutMinutes,
        targetType: params.targetType,
        targetSlug: params.targetSlug,
        githubToken: params.githubToken,
      });
      launched++;
    } catch (err) {
      // One failed top-up must not stop the rest of the backlog being covered.
      console.error(`Reconciler: failed to launch a runner for job ${job.jobId}`, err);
      continue;
    }

    // Bounds how many replacements a single job can consume when every one of
    // them also fails to come online. Kept out of the launch try/catch so a
    // bookkeeping failure is never reported as a failed launch.
    try {
      await dynamo.send(
        new UpdateItemCommand({
          TableName: process.env.QUEUED_JOBS_TABLE!,
          Key: { jobId: { S: job.jobId } },
          UpdateExpression: "SET topUps = if_not_exists(topUps, :zero) + :one",
          // No-op if the row has since been deleted because the job started.
          ConditionExpression: "attribute_exists(jobId)",
          ExpressionAttributeValues: { ":zero": { N: "0" }, ":one": { N: "1" } },
        })
      );
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name !== "ConditionalCheckFailedException") {
        console.error(
          `Reconciler: could not record the top-up count for job ${job.jobId}`,
          err
        );
      }
    }
  }

  const pruneIds = planRunnerPrune({ runners, liveInstances, queuedJobs });
  let pruned = 0;
  for (const runnerId of pruneIds) {
    const name = runners.find((r) => r.id === runnerId)?.name;
    try {
      await deleteRunner(
        params.targetType,
        params.targetSlug,
        runnerId,
        params.githubToken
      );
      pruned++;
      console.log(`Reconciler: pruned dead runner registration ${name} (${runnerId})`);
    } catch (err) {
      console.error(`Reconciler: failed to prune runner ${name} (${runnerId})`, err);
    }
  }

  console.log(`Reconciler complete: launched ${launched}, pruned ${pruned}`);
}
