const PARAM_ENVS: Record<string, string> = {
  GITHUB_TOKEN_PARAM: "/t/github-token",
  TARGET_TYPE_PARAM: "/t/target-type",
  TARGET_SLUG_PARAM: "/t/target-slug",
  INSTANCE_TYPE_PARAM: "/t/instance-type",
  EBS_VOLUME_SIZE_PARAM: "/t/ebs",
  MAX_CONCURRENT_RUNNERS_PARAM: "/t/max",
  RUNNER_TIMEOUT_PARAM: "/t/timeout",
  RECONCILER_GRACE_SECONDS_PARAM: "/t/grace",
  RECONCILER_BOOT_GRACE_SECONDS_PARAM: "/t/boot-grace",
  RECONCILER_MAX_TOP_UPS_PARAM: "/t/top-ups",
  SPOT_ENABLED_PARAM: "/t/spot-enabled",
  SPOT_REQUIRED_PARAM: "/t/spot-required",
  QUEUED_JOBS_TABLE: "queued-jobs",
};

function row(jobId: string, ageMinutes: number, market?: string) {
  return {
    jobId: { S: jobId },
    queuedAt: { S: new Date(Date.now() - ageMinutes * 60_000).toISOString() },
    runnerName: { S: `aws-runner-${jobId}` },
    repo: { S: "o/r" },
    ...(market ? { market: { S: market } } : {}),
  };
}

describe("reconciler market handling", () => {
  const originalEnv = process.env;
  let launchRunner: jest.Mock;
  let getJobStatus: jest.Mock;
  let ssmSend: jest.SpyInstance;
  let SpotCapacityError: typeof import("../lambda/shared/spot").SpotCapacityError;
  let dynamoSend: jest.SpyInstance;
  let handler: typeof import("../lambda/reconciler").handler;
  let UpdateItemCommand: typeof import("@aws-sdk/client-dynamodb").UpdateItemCommand;
  let DeleteItemCommand: typeof import("@aws-sdk/client-dynamodb").DeleteItemCommand;
  let rows: Record<string, unknown>[];
  let params: Record<string, string>;

  beforeEach(() => {
    process.env = { ...originalEnv, ...PARAM_ENVS, AWS_REGION: "us-east-1" };
    jest.resetModules();
    launchRunner = jest.fn().mockResolvedValue("i-1");
    jest.doMock("../lambda/shared/launcher", () => ({
      ...jest.requireActual("../lambda/shared/launcher"),
      launchRunner,
    }));
    getJobStatus = jest.fn().mockResolvedValue("queued");
    jest.doMock("../lambda/webhook/github-client", () => ({
      listRunners: jest.fn().mockResolvedValue([]),
      getJobStatus,
      deleteRunner: jest.fn().mockResolvedValue(undefined),
    }));
    rows = [];
    params = {};
    const { SSMClient } = require("@aws-sdk/client-ssm");
    const dynamo = require("@aws-sdk/client-dynamodb");
    const { EC2Client } = require("@aws-sdk/client-ec2");
    UpdateItemCommand = dynamo.UpdateItemCommand;
    DeleteItemCommand = dynamo.DeleteItemCommand;
    SpotCapacityError = require("../lambda/shared/spot").SpotCapacityError;
    ssmSend = jest.spyOn(SSMClient.prototype, "send").mockImplementation(((cmd: any) => {
      const values: Record<string, string> = {
        "/t/github-token": "tok",
        "/t/target-type": "repo",
        "/t/target-slug": "o/r",
        "/t/instance-type": "c7a.large",
        "/t/ebs": "50",
        "/t/max": "5",
        "/t/timeout": "60",
        ...params,
      };
      // Like AWS, only return what was asked for.
      const requested: string[] = cmd.input.Names ?? [];
      return Promise.resolve({
        Parameters: Object.entries(values)
          .filter(([Name]) => requested.includes(Name))
          .map(([Name, Value]) => ({ Name, Value })),
      });
    }) as never);
    dynamoSend = jest
      .spyOn(dynamo.DynamoDBClient.prototype, "send")
      .mockImplementation(((cmd: unknown) =>
        Promise.resolve(
          cmd instanceof dynamo.ScanCommand ? { Items: rows } : {}
        )) as never);
    jest.spyOn(EC2Client.prototype, "send").mockResolvedValue({ Reservations: [] } as never);
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    handler = require("../lambda/reconciler").handler;
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
    jest.dontMock("../lambda/shared/launcher");
    jest.dontMock("../lambda/webhook/github-client");
  });

  const sent = (type: unknown) =>
    dynamoSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof (type as new () => object));
  const launchedIds = () => launchRunner.mock.calls.map((c) => c[0].jobId);

  test("never asks SSM for more than 10 parameter names per request", async () => {
    const { GetParametersCommand } = require("@aws-sdk/client-ssm");
    rows = [];
    await handler();
    const getParams = ssmSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof GetParametersCommand);
    expect(getParams.length).toBeGreaterThan(0);
    for (const c of getParams) expect(c.input.Names.length).toBeLessThanOrEqual(10);
  });

  test("after a Spot refusal, skips the pass's remaining Spot jobs of that type but not others", async () => {
    params["/t/max"] = "10";
    rows = [
      row("s1", 40, "spot"),
      row("s2", 30, "spot"),
      row("s3", 20, "spot"),
      row("od", 10, "on-demand"),
    ];
    launchRunner.mockImplementation((p: { jobId: string }) =>
      p.jobId === "s1"
        ? Promise.reject(new SpotCapacityError("no capacity", null))
        : Promise.resolve("i-1")
    );
    await handler();
    expect(launchedIds()).toEqual(["s1", "od"]);
    const checked = getJobStatus.mock.calls.map((c) => c[1]);
    expect(checked).toContain("s1");
    expect(checked).not.toContain("s2");
    expect(checked).not.toContain("s3");
  });

  test("tops up a row without a market attribute as On-Demand", async () => {
    rows = [row("1", 10)];
    await handler();
    expect(launchRunner).toHaveBeenCalledWith(
      expect.objectContaining({ market: "on-demand" })
    );
  });

  test("tops up a Spot row as Spot", async () => {
    rows = [row("1", 10, "spot")];
    await handler();
    expect(launchRunner).toHaveBeenCalledWith(
      expect.objectContaining({ market: "spot" })
    );
  });

  test("a refused Spot launch frees its slot for the next job and does not count as a top-up", async () => {
    params["/t/max"] = "1";
    rows = [row("od-new", 10, "on-demand"), row("spot-old", 20, "spot")];
    launchRunner.mockRejectedValueOnce(new SpotCapacityError("no capacity", null));
    await handler();
    expect(launchedIds()).toEqual(["spot-old", "od-new"]);
    const updates = sent(UpdateItemCommand);
    expect(updates).toHaveLength(1);
    expect(updates[0].input.Key).toEqual({ jobId: { S: "od-new" } });
  });

  test("an On-Demand launch failure still uses its slot", async () => {
    params["/t/max"] = "1";
    rows = [row("a", 20, "on-demand"), row("b", 10, "on-demand")];
    launchRunner.mockRejectedValueOnce(new Error("boom"));
    await handler();
    expect(launchRunner).toHaveBeenCalledTimes(1);
  });

  test("a failed launch counts as a top-up", async () => {
    rows = [row("a", 20, "on-demand")];
    launchRunner.mockRejectedValueOnce(new Error("boom"));
    await handler();
    const updates = sent(UpdateItemCommand);
    expect(updates).toHaveLength(1);
    expect(updates[0].input.Key).toEqual({ jobId: { S: "a" } });
  });

  test("a failed launch on a row deleted mid-pass is silent", async () => {
    rows = [row("a", 20, "on-demand")];
    launchRunner.mockRejectedValueOnce(new Error("boom"));
    dynamoSend.mockImplementation(((cmd: unknown) =>
      cmd instanceof UpdateItemCommand
        ? Promise.reject(Object.assign(new Error("gone"), { name: "ConditionalCheckFailedException" }))
        : Promise.resolve({ Items: rows })) as never);
    await handler();
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining("could not record the top-up count"), expect.anything());
    expect(sent(UpdateItemCommand)).toHaveLength(1);
  });

  test("a launch refused for account quota waits without spending a top-up", async () => {
    rows = [row("a", 20, "on-demand")];
    launchRunner.mockRejectedValueOnce(Object.assign(new Error("vcpu"), { name: "VcpuLimitExceeded" }));
    await expect(handler()).resolves.toBeUndefined();
    expect(sent(UpdateItemCommand)).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("waiting for quota"));
  });

  test("a failing top-up record after a failed launch is logged and the pass continues", async () => {
    rows = [row("a", 20, "on-demand"), row("b", 10, "on-demand")];
    launchRunner.mockRejectedValue(new Error("boom"));
    dynamoSend.mockImplementation(((cmd: unknown) =>
      cmd instanceof UpdateItemCommand
        ? Promise.reject(new Error("throttled"))
        : Promise.resolve({ Items: rows })) as never);
    await handler();
    expect(launchRunner).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(
      "Reconciler: could not record the top-up count for job a", expect.any(Error));
  });

  test("a refused Spot launch with nothing in overflow just moves on", async () => {
    params["/t/max"] = "5";
    rows = [row("s", 10, "spot")];
    launchRunner.mockRejectedValueOnce(new SpotCapacityError("no capacity", null));
    await expect(handler()).resolves.toBeUndefined();
    expect(sent(UpdateItemCommand)).toHaveLength(0);
  });

  test("drops a Spot row when Spot has since been disabled", async () => {
    params["/t/spot-enabled"] = "false";
    rows = [row("s", 10, "spot")];
    await handler();
    expect(launchRunner).not.toHaveBeenCalled();
    const deletes = sent(DeleteItemCommand);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].input.Key).toEqual({ jobId: { S: "s" } });
  });

  test("drops an On-Demand row when Spot has since been required", async () => {
    params["/t/spot-required"] = "true";
    rows = [row("o", 10, "on-demand")];
    await handler();
    expect(launchRunner).not.toHaveBeenCalled();
    expect(sent(DeleteItemCommand)).toHaveLength(1);
  });
});
