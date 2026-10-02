/**
 * Pure decision logic for the reconciler.
 *
 * Background: GitHub hands a newly-online runner the oldest queued job that
 * matches the runner's labels — not necessarily the job whose webhook launched
 * it. The 1:1 "one webhook, one instance" scheme therefore only works while
 * matching runner supply exactly equals matching job demand. Any minted runner
 * that never picks up a job (instance failed to bootstrap, reaped while idle)
 * permanently shifts that label set's queue, and a job starves in `queued`
 * forever.
 *
 * The reconciler restores the invariant `supply >= demand` by comparing jobs
 * still sitting in the queued-jobs table against runner capacity actually in
 * flight for each label set, and topping up the difference.
 */

/** Prefix shared by every runner name this stack mints. */
export const RUNNER_NAME_PREFIX = "aws-runner-";

/** A job the webhook saw go `queued` and has not yet seen start or finish. */
export interface QueuedJob {
  jobId: string;
  /** ISO-8601 timestamp of the `workflow_job.queued` event. */
  queuedAt: string;
  /** Name of the JIT runner minted for this job. */
  runnerName: string;
  /** `owner/repo` the job belongs to, used to re-check its status on GitHub. */
  repo?: string;
  /** How many replacement runners the reconciler has already launched for it. */
  topUps?: number;
  /** Labels from the workflow job's `runs-on` selector. */
  labels?: string[];
  instanceType?: string;
  ebsSizeGb?: number;
  timeoutMinutes?: number;
}

/** A runner registration as returned by the GitHub runners API. */
export interface RegisteredRunner {
  id: number;
  name: string;
  status: string;
  busy: boolean;
  labels?: { name: string }[] | string[];
}

/** A pending or running EC2 instance managed by this stack. */
export interface LiveInstance {
  instanceId: string;
  /** Value of the `github-aws-runner:runner-name` tag. */
  runnerName?: string;
  /** Value of the `github-aws-runner:launch-time` tag. */
  launchedAt?: string;
}

export interface PlanInput {
  queuedJobs: QueuedJob[];
  runners: RegisteredRunner[];
  liveInstances: LiveInstance[];
  maxConcurrentRunners: number;
  graceMs: number;
  /**
   * How long an instance is allowed to be running before its runner must be
   * `online` with GitHub for the instance to still count as usable capacity.
   */
  bootGraceMs: number;
  /**
   * Cap on replacement runners per job. Bounds the damage when every
   * replacement also fails to come online, which is what a GitHub-side outage
   * looks like from here.
   */
  maxTopUps: number;
  now: number;
}

export interface Plan {
  /** Jobs to mint a replacement runner and instance for, oldest first. */
  launchFor: QueuedJob[];
  /**
   * Instances that are running but were not counted as capacity because their
   * runner never came online. Reported so the reason a top-up happened is
   * visible in the logs.
   */
  discountedInstanceIds: string[];
}

function labelNames(
  labels: { name: string }[] | string[] | undefined
): string[] | undefined {
  if (!labels) return undefined;
  return labels.map((label) =>
    typeof label === "string" ? label : label.name
  );
}

function hasAllLabels(
  runnerLabels: { name: string }[] | string[] | undefined,
  jobLabels: string[] | undefined
): boolean {
  if (!jobLabels || jobLabels.length === 0) return true;
  const available = new Set(labelNames(runnerLabels) ?? []);
  return jobLabels.every((label) => available.has(label));
}

function jobIdForRunnerName(runnerName: string | undefined): string | undefined {
  if (!runnerName?.startsWith(RUNNER_NAME_PREFIX)) return undefined;
  const withoutPrefix = runnerName.slice(RUNNER_NAME_PREFIX.length);
  return withoutPrefix.split("-", 1)[0];
}

export function planLaunches(input: PlanInput): Plan {
  const stale = input.queuedJobs
    .filter((j) => input.now - Date.parse(j.queuedAt) >= input.graceMs)
    .filter((j) => (j.topUps ?? 0) < input.maxTopUps)
    .sort((a, b) => Date.parse(a.queuedAt) - Date.parse(b.queuedAt));

  // An instance only represents real capacity while it can still plausibly take
  // a job. Past the boot grace its runner must actually be `online` with
  // GitHub — an instance whose runner never registered (failed bootstrap, or
  // GitHub dropping the session as during the 2026-08-06 Actions outage) can
  // never be handed work, and counting it stalls the backlog until the watchdog
  // times the instance out.
  const runnerByName = new Map(input.runners.map((r) => [r.name, r]));
  const usableInstances = input.liveInstances.filter((i) => {
    const launchedAt = i.launchedAt ? Date.parse(i.launchedAt) : NaN;
    // Missing or unparseable launch time — assume it is still booting rather
    // than risk launching duplicate capacity for it.
    if (Number.isNaN(launchedAt)) return true;
    if (input.now - launchedAt <= input.bootGraceMs) return true;
    return i.runnerName !== undefined
      && runnerByName.get(i.runnerName)?.status === "online";
  });

  const jobById = new Map(input.queuedJobs.map((j) => [j.jobId, j]));

  const idleSupply = usableInstances
    .map((instance) => {
      const runner = instance.runnerName
        ? runnerByName.get(instance.runnerName)
        : undefined;
      if (runner?.busy) return undefined;
      const jobId = jobIdForRunnerName(instance.runnerName);
      const sourceJob = jobId ? jobById.get(jobId) : undefined;
      return {
        runnerLabels: runner ? labelNames(runner.labels) : sourceJob?.labels,
      };
    })
    .filter(
      (supply): supply is { runnerLabels: string[] | undefined } =>
        supply !== undefined
    );

  const uncovered = stale.filter((queuedJob) => {
    const supplyIndex = idleSupply.findIndex((supply) =>
      hasAllLabels(supply.runnerLabels, queuedJob.labels)
    );
    if (supplyIndex === -1) return true;
    idleSupply.splice(supplyIndex, 1);
    return false;
  });

  const shortfall = uncovered.length;

  // Never exceed the same cap the webhook enforces.
  const freeCapacity = Math.max(
    0,
    input.maxConcurrentRunners - input.liveInstances.length
  );

  const usableIds = new Set(usableInstances.map((i) => i.instanceId));

  return {
    launchFor: uncovered.slice(0, Math.min(shortfall, freeCapacity)),
    discountedInstanceIds: input.liveInstances
      .filter((i) => !usableIds.has(i.instanceId))
      .map((i) => i.instanceId),
  };
}

export interface PruneInput {
  runners: RegisteredRunner[];
  liveInstances: LiveInstance[];
  queuedJobs: QueuedJob[];
}

/**
 * Identifies runner registrations this stack minted that can never come online:
 * the JIT config was generated but the instance that was supposed to consume it
 * no longer exists. An ephemeral runner deregisters itself once it finishes a
 * job, so a lingering `offline` record with no live instance behind it is dead
 * weight.
 *
 * A runner still referenced by a queued-jobs row is left alone — that covers the
 * window between minting the JIT config and the instance appearing in EC2.
 */
export function planRunnerPrune(input: PruneInput): number[] {
  const liveRunnerNames = new Set(
    input.liveInstances.map((i) => i.runnerName).filter((n): n is string => !!n)
  );
  const pendingRunnerNames = new Set(input.queuedJobs.map((j) => j.runnerName));

  return input.runners
    .filter(
      (r) =>
        r.name.startsWith(RUNNER_NAME_PREFIX) &&
        r.status === "offline" &&
        !r.busy &&
        !liveRunnerNames.has(r.name) &&
        !pendingRunnerNames.has(r.name)
    )
    .map((r) => r.id);
}
