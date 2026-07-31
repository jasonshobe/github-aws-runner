/**
 * Pure decision logic for the reconciler.
 *
 * Background: every JIT runner this stack mints carries the same label set, so
 * GitHub treats them as fungible and hands a newly-online runner the *oldest*
 * matching queued job in the target — not the job whose webhook launched it.
 * The 1:1 "one webhook, one instance" scheme therefore only works while runner
 * supply exactly equals job demand. Any minted runner that never picks up a job
 * (instance failed to bootstrap, reaped while idle) permanently shifts the
 * queue, and the newest job starves in `queued` forever.
 *
 * The reconciler restores the invariant `supply >= demand` by comparing jobs
 * still sitting in the queued-jobs table against runner capacity actually in
 * flight, and topping up the difference.
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
}

/** A pending or running EC2 instance managed by this stack. */
export interface LiveInstance {
  instanceId: string;
  /** Value of the `github-aws-runner:runner-name` tag. */
  runnerName?: string;
}

export interface PlanInput {
  queuedJobs: QueuedJob[];
  runners: RegisteredRunner[];
  liveInstances: LiveInstance[];
  maxConcurrentRunners: number;
  graceMs: number;
  now: number;
}

export interface Plan {
  /** Jobs to mint a replacement runner and instance for, oldest first. */
  launchFor: QueuedJob[];
}

export function planLaunches(input: PlanInput): Plan {
  const stale = input.queuedJobs
    .filter((j) => input.now - Date.parse(j.queuedAt) >= input.graceMs)
    .sort((a, b) => Date.parse(a.queuedAt) - Date.parse(b.queuedAt));

  // Runner capacity in flight that has not yet claimed a job. A busy runner is
  // already executing a job that has left the queued-jobs table, so it does
  // nothing for the current backlog.
  const busyRunners = input.runners.filter((r) => r.busy).length;
  const idleSupply = Math.max(0, input.liveInstances.length - busyRunners);

  const shortfall = Math.max(0, stale.length - idleSupply);

  // Never exceed the same cap the webhook enforces.
  const freeCapacity = Math.max(
    0,
    input.maxConcurrentRunners - input.liveInstances.length
  );

  return { launchFor: stale.slice(0, Math.min(shortfall, freeCapacity)) };
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
