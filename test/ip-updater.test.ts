import {
  APIGatewayClient,
  CreateDeploymentCommand,
  UpdateRestApiCommand,
} from "@aws-sdk/client-api-gateway";
import { handler } from "../lambda/ip-updater";

describe("IP updater", () => {
  const originalEnv = process.env;
  let send: jest.SpyInstance;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      REST_API_ID: "webhook-api",
      REST_API_STAGE_NAME: "prod",
      AWS_REGION: "us-east-1",
      ACCOUNT_ID: "123456789012",
    };
    send = jest.spyOn(APIGatewayClient.prototype, "send").mockResolvedValue({} as never);
    jest.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({
      hooks: ["140.82.112.0/20", "9.234.106.48/28"],
    })));
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  test("deploys the refreshed webhook policy to the configured stage after updating it", async () => {
    await handler();

    expect(send).toHaveBeenCalledTimes(2);
    const update = send.mock.calls[0][0] as UpdateRestApiCommand;
    expect(update).toBeInstanceOf(UpdateRestApiCommand);
    expect(update.input.restApiId).toBe("webhook-api");
    const patch = update.input.patchOperations![0];
    expect(patch).toMatchObject({ op: "replace", path: "/policy" });
    expect(JSON.parse(decodeURIComponent(patch.value!))).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Deny",
          Principal: "*",
          Action: "execute-api:Invoke",
          Resource: "arn:aws:execute-api:us-east-1:123456789012:webhook-api/*",
          Condition: {
            NotIpAddress: { "aws:SourceIp": ["140.82.112.0/20", "9.234.106.48/28"] },
          },
        },
        {
          Effect: "Allow",
          Principal: "*",
          Action: "execute-api:Invoke",
          Resource: "arn:aws:execute-api:us-east-1:123456789012:webhook-api/*",
        },
      ],
    });
    const deployment = send.mock.calls[1][0] as CreateDeploymentCommand;
    expect(deployment).toBeInstanceOf(CreateDeploymentCommand);
    expect(deployment.input).toMatchObject({
      restApiId: "webhook-api",
      stageName: "prod",
    });
  });

  test("fails without deploying when the policy update is denied", async () => {
    const error = new Error("AccessDeniedException");
    send.mockRejectedValueOnce(error);

    await expect(handler()).rejects.toThrow(error);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("surfaces deployment failures so Lambda records an error", async () => {
    const error = new Error("Deployment failed");
    send.mockResolvedValueOnce({}).mockRejectedValueOnce(error);

    await expect(handler()).rejects.toThrow(error);
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("does not change the API when GitHub metadata cannot be fetched", async () => {
    jest.mocked(fetch).mockResolvedValueOnce(new Response(null, {
      status: 503,
      statusText: "Service Unavailable",
    }));

    await expect(handler()).rejects.toThrow("GitHub /meta request failed: 503");
    expect(send).not.toHaveBeenCalled();
  });
});
