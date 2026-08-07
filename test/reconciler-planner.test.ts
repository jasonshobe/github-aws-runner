import { planLaunches, planRunnerPrune } from "../lambda/reconciler/planner";

const NOW = Date.parse("2026-07-31T15:00:00Z");
const MINUTE = 60_000;
const BOOT_GRACE = 5 * MINUTE;

function job(jobId: string, ageMinutes: number) {
  return {
    jobId,
    queuedAt: new Date(NOW - ageMinutes * MINUTE).toISOString(),
    runnerName: `aws-runner-${jobId}`,
  };
}

function instance(runnerName: string, ageMinutes: number) {
  return {
    instanceId: `i-${runnerName}`,
    runnerName,
    launchedAt: new Date(NOW - ageMinutes * MINUTE).toISOString(),
  };
}

describe("planLaunches", () => {
  it("launches a runner for a stale queued job that has no idle supply", () => {
    const plan = planLaunches({
      queuedJobs: [job("100", 10)],
      runners: [],
      liveInstances: [],
      maxConcurrentRunners: 10,
      graceMs: 2 * MINUTE,
      bootGraceMs: BOOT_GRACE,
      maxTopUps: 3,
      now: NOW,
    });

    expect(plan.launchFor.map((j) => j.jobId)).toEqual(["100"]);
  });

  it("ignores a queued job still inside the grace period", () => {
    const plan = planLaunches({
      queuedJobs: [job("100", 1)],
      runners: [],
      liveInstances: [],
      maxConcurrentRunners: 10,
      graceMs: 2 * MINUTE,
      bootGraceMs: BOOT_GRACE,
      maxTopUps: 3,
      now: NOW,
    });

    expect(plan.launchFor).toEqual([]);
  });

  it("launches nothing when an idle runner is already in flight for the backlog", () => {
    const plan = planLaunches({
      queuedJobs: [job("100", 10)],
      runners: [{ id: 1, name: "aws-runner-100", status: "offline", busy: false }],
      liveInstances: [{ instanceId: "i-1", runnerName: "aws-runner-100" }],
      maxConcurrentRunners: 10,
      graceMs: 2 * MINUTE,
      bootGraceMs: BOOT_GRACE,
      maxTopUps: 3,
      now: NOW,
    });

    expect(plan.launchFor).toEqual([]);
  });

  // Reproduces the observed failure: the instance launched for job 200 came
  // online and GitHub gave it the older backlog job instead, so job 200 is
  // still queued with no runner capacity left for it.
  it("launches a replacement when the in-flight runner is busy with an older job", () => {
    const plan = planLaunches({
      queuedJobs: [job("200", 10)],
      runners: [{ id: 1, name: "aws-runner-200", status: "online", busy: true }],
      liveInstances: [{ instanceId: "i-1", runnerName: "aws-runner-200" }],
      maxConcurrentRunners: 10,
      graceMs: 2 * MINUTE,
      bootGraceMs: BOOT_GRACE,
      maxTopUps: 3,
      now: NOW,
    });

    expect(plan.launchFor.map((j) => j.jobId)).toEqual(["200"]);
  });

  it("caps launches at the remaining concurrent runner capacity", () => {
    const plan = planLaunches({
      queuedJobs: [job("100", 10), job("200", 9), job("300", 8)],
      runners: [{ id: 1, name: "aws-runner-1", status: "online", busy: true }],
      liveInstances: [{ instanceId: "i-1", runnerName: "aws-runner-1" }],
      maxConcurrentRunners: 3,
      graceMs: 2 * MINUTE,
      bootGraceMs: BOOT_GRACE,
      maxTopUps: 3,
      now: NOW,
    });

    // 3 stale jobs, 0 idle supply, but only 2 of the 3 slots are free.
    expect(plan.launchFor.map((j) => j.jobId)).toEqual(["100", "200"]);
  });

  // Reproduces the 2026-08-06 starvation: the instance booted and its runner
  // connected, but GitHub never brought the registration online, so the runner
  // could never be given the job. Counting that instance as supply left the job
  // queued for the full 60-minute watchdog timeout.
  it("stops counting an instance whose runner never came online past the boot grace", () => {
    const plan = planLaunches({
      queuedJobs: [job("100", 10)],
      runners: [{ id: 1, name: "aws-runner-100", status: "offline", busy: false }],
      liveInstances: [instance("aws-runner-100", 10)],
      maxConcurrentRunners: 10,
      graceMs: 2 * MINUTE,
      bootGraceMs: BOOT_GRACE,
      maxTopUps: 3,
      now: NOW,
    });

    expect(plan.launchFor.map((j) => j.jobId)).toEqual(["100"]);
  });

  it("reports which instances it discounted so the reason is visible in the logs", () => {
    const plan = planLaunches({
      queuedJobs: [job("100", 10)],
      runners: [{ id: 1, name: "aws-runner-100", status: "offline", busy: false }],
      liveInstances: [instance("aws-runner-100", 10), instance("aws-runner-200", 1)],
      maxConcurrentRunners: 10,
      graceMs: 2 * MINUTE,
      bootGraceMs: BOOT_GRACE,
      maxTopUps: 3,
      now: NOW,
    });

    expect(plan.discountedInstanceIds).toEqual(["i-aws-runner-100"]);
  });

  it("still counts an instance whose runner is not online yet but is inside the boot grace", () => {
    const plan = planLaunches({
      queuedJobs: [job("100", 10)],
      runners: [{ id: 1, name: "aws-runner-100", status: "offline", busy: false }],
      liveInstances: [instance("aws-runner-100", 2)],
      maxConcurrentRunners: 10,
      graceMs: 2 * MINUTE,
      bootGraceMs: BOOT_GRACE,
      maxTopUps: 3,
      now: NOW,
    });

    expect(plan.launchFor).toEqual([]);
  });

  // A healthy runner sitting idle waiting for work is real capacity no matter
  // how old it is; only never-online runners are discounted.
  it("counts an online idle runner as supply however long it has been up", () => {
    const plan = planLaunches({
      queuedJobs: [job("100", 10)],
      runners: [{ id: 1, name: "aws-runner-100", status: "online", busy: false }],
      liveInstances: [instance("aws-runner-100", 45)],
      maxConcurrentRunners: 10,
      graceMs: 2 * MINUTE,
      bootGraceMs: BOOT_GRACE,
      maxTopUps: 3,
      now: NOW,
    });

    expect(plan.launchFor).toEqual([]);
  });

  // Without this bound, a systemic failure where every replacement also fails to
  // come online (the 2026-08-06 Actions outage) would relaunch once per boot
  // grace until the concurrency cap was saturated with useless instances.
  it("stops topping up a job that has already been replaced the maximum number of times", () => {
    const plan = planLaunches({
      queuedJobs: [{ ...job("100", 30), topUps: 3 }],
      runners: [],
      liveInstances: [],
      maxConcurrentRunners: 10,
      graceMs: 2 * MINUTE,
      bootGraceMs: BOOT_GRACE,
      maxTopUps: 3,
      now: NOW,
    });

    expect(plan.launchFor).toEqual([]);
  });
});

describe("planRunnerPrune", () => {
  it("prunes an offline runner whose instance is gone", () => {
    const ids = planRunnerPrune({
      runners: [
        { id: 2217, name: "aws-runner-90927230411", status: "offline", busy: false },
      ],
      liveInstances: [],
      queuedJobs: [],
    });

    expect(ids).toEqual([2217]);
  });

  it("keeps an offline runner whose instance is still booting", () => {
    const ids = planRunnerPrune({
      runners: [{ id: 1, name: "aws-runner-100", status: "offline", busy: false }],
      liveInstances: [{ instanceId: "i-1", runnerName: "aws-runner-100" }],
      queuedJobs: [],
    });

    expect(ids).toEqual([]);
  });

  // Covers the window between generating the JIT config and RunInstances
  // returning, where the runner exists but no instance does yet.
  it("keeps an offline runner still referenced by a queued job", () => {
    const ids = planRunnerPrune({
      runners: [{ id: 1, name: "aws-runner-100", status: "offline", busy: false }],
      liveInstances: [],
      queuedJobs: [job("100", 0)],
    });

    expect(ids).toEqual([]);
  });

  it("keeps an online runner", () => {
    const ids = planRunnerPrune({
      runners: [{ id: 1, name: "aws-runner-100", status: "online", busy: false }],
      liveInstances: [],
      queuedJobs: [],
    });

    expect(ids).toEqual([]);
  });

  it("ignores runners that this stack did not mint", () => {
    const ids = planRunnerPrune({
      runners: [{ id: 9, name: "on-prem-builder-1", status: "offline", busy: false }],
      liveInstances: [],
      queuedJobs: [],
    });

    expect(ids).toEqual([]);
  });
});
