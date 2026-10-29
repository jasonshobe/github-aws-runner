import * as crypto from "crypto";
import type { APIGatewayProxyEvent } from "aws-lambda";

const SECRET = "shh";
const PARAM_ENVS: Record<string, string> = {
  WEBHOOK_SECRET_PARAM: "/t/webhook-secret",
  GITHUB_TOKEN_PARAM: "/t/github-token",
  TARGET_TYPE_PARAM: "/t/target-type",
  TARGET_SLUG_PARAM: "/t/target-slug",
  INSTANCE_TYPE_PARAM: "/t/instance-type",
  EBS_VOLUME_SIZE_PARAM: "/t/ebs",
  MAX_CONCURRENT_RUNNERS_PARAM: "/t/max",
  RUNNER_TIMEOUT_PARAM: "/t/timeout",
  RUNNER_LABEL_PARAM: "/t/label",
  ALLOWED_INSTANCE_TYPES_PARAM: "/t/allowed",
  MAX_EBS_VOLUME_SIZE_PARAM: "/t/max-ebs",
  SPOT_ENABLED_PARAM: "/t/spot-enabled",
  SPOT_REQUIRED_PARAM: "/t/spot-required",
  QUEUED_JOBS_TABLE: "queued-jobs",
};

function event(labels: string[]): APIGatewayProxyEvent {
  const body = JSON.stringify({
    action: "queued",
    repository: { full_name: "o/r" },
    workflow_job: { id: 42, labels },
  });
  const sig = `sha256=${crypto.createHmac("sha256", SECRET).update(body).digest("hex")}`;
  return {
    body,
    headers: { "x-github-event": "workflow_job", "x-hub-signature-256": sig },
  } as unknown as APIGatewayProxyEvent;
}

describe("webhook market selection", () => {
  const originalEnv = process.env;
  let launchRunner: jest.Mock;
  let SpotCapacityError: typeof import("../lambda/shared/spot").SpotCapacityError;
  let dynamoSend: jest.SpyInstance;
  let handler: typeof import("../lambda/webhook").handler;
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;
  let PutItemCommand: typeof import("@aws-sdk/client-dynamodb").PutItemCommand;
  let spotParams: Record<string, string>;
  let ssmSend: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...originalEnv, ...PARAM_ENVS, AWS_REGION: "us-east-1" };
    jest.resetModules();
    launchRunner = jest.fn().mockResolvedValue("i-1");
    jest.doMock("../lambda/shared/launcher", () => ({
      ...jest.requireActual("../lambda/shared/launcher"),
      launchRunner,
    }));
    spotParams = {};
    const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
    const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
    const { EC2Client } = require("@aws-sdk/client-ec2");
    PutItemCommand = require("@aws-sdk/client-dynamodb").PutItemCommand;
    SpotCapacityError = require("../lambda/shared/spot").SpotCapacityError;
    ssmSend = jest.spyOn(SSMClient.prototype, "send").mockImplementation(((cmd: any) => {
      if (cmd instanceof GetParameterCommand) {
        return Promise.resolve({ Parameter: { Value: SECRET } });
      }
      const values: Record<string, string> = {
        "/t/github-token": "tok",
        "/t/target-type": "repo",
        "/t/target-slug": "o/r",
        "/t/instance-type": "c7a.large",
        "/t/ebs": "50",
        "/t/max": "5",
        "/t/timeout": "60",
        ...spotParams,
      };
      // Like AWS, only return what was asked for.
      const requested: string[] = cmd.input.Names ?? [];
      return Promise.resolve({
        Parameters: Object.entries(values)
          .filter(([Name]) => requested.includes(Name))
          .map(([Name, Value]) => ({ Name, Value })),
      });
    }) as never);
    dynamoSend = jest.spyOn(DynamoDBClient.prototype, "send").mockResolvedValue({} as never);
    jest.spyOn(EC2Client.prototype, "send").mockResolvedValue({ Reservations: [] } as never);
    log = jest.spyOn(console, "log").mockImplementation(() => {});
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    handler = require("../lambda/webhook").handler;
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
    jest.dontMock("../lambda/shared/launcher");
  });

  const puts = () =>
    dynamoSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof PutItemCommand);
  const storedMarket = () => puts()[0].input.Item?.market;

  test("never asks SSM for more than 10 parameter names per request", async () => {
    const { GetParametersCommand } = require("@aws-sdk/client-ssm");
    await handler(event(["self-hosted"]));
    const getParams = ssmSend.mock.calls
      .map((c) => c[0])
      .filter((c) => c instanceof GetParametersCommand);
    expect(getParams.length).toBeGreaterThan(0);
    for (const c of getParams) expect(c.input.Names.length).toBeLessThanOrEqual(10);
  });

  test("keeps today's behavior with no spot parameters or labels", async () => {
    const res = await handler(event(["self-hosted"]));
    expect(res.statusCode).toBe(200);
    expect(launchRunner).toHaveBeenCalledWith(
      expect.objectContaining({ market: "on-demand" })
    );
    expect(storedMarket()).toEqual({ S: "on-demand" });
  });

  test("launches Spot for spot:true", async () => {
    await handler(event(["self-hosted", "spot:true"]));
    expect(launchRunner).toHaveBeenCalledWith(expect.objectContaining({ market: "spot" }));
    expect(storedMarket()).toEqual({ S: "spot" });
  });

  test("launches Spot for an unlabeled job when spot-required is true", async () => {
    spotParams["/t/spot-required"] = "true";
    await handler(event(["self-hosted"]));
    expect(launchRunner).toHaveBeenCalledWith(expect.objectContaining({ market: "spot" }));
    expect(storedMarket()).toEqual({ S: "spot" });
  });

  test("rejects spot:true when spot-enabled is false without writing a row", async () => {
    spotParams["/t/spot-enabled"] = "false";
    const res = await handler(event(["self-hosted", "spot:true"]));
    expect(res.statusCode).toBe(200);
    expect(launchRunner).not.toHaveBeenCalled();
    expect(puts()).toHaveLength(0);
    const msgs = [...warn.mock.calls, ...log.mock.calls].map((c) => String(c[0]));
    expect(msgs.some((m) => m.includes("42") && m.includes("spot:true"))).toBe(true);
  });

  test("rejects spot:false when spot-required is true without writing a row", async () => {
    spotParams["/t/spot-required"] = "true";
    const res = await handler(event(["self-hosted", "spot:false"]));
    expect(res.statusCode).toBe(200);
    expect(launchRunner).not.toHaveBeenCalled();
    expect(puts()).toHaveLength(0);
    const msgs = [...warn.mock.calls, ...log.mock.calls].map((c) => String(c[0]));
    expect(msgs.some((m) => m.includes("42") && m.includes("spot:false"))).toBe(true);
  });

  test("returns 200 and keeps the row when Spot capacity is refused", async () => {
    launchRunner.mockRejectedValue(new SpotCapacityError("x", null));
    const res = await handler(event(["self-hosted", "spot:true"]));
    expect(res.statusCode).toBe(200);
    expect(puts()).toHaveLength(1);
  });
});
