import { generateJitConfig } from "../lambda/webhook/github-client";

describe("generateJitConfig", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("registers a JIT runner with the custom labels required by the queued job", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        runner: { id: 42 },
        encoded_jit_config: "encoded-config",
      }),
    });
    global.fetch = fetchMock as never;

    const result = await generateJitConfig(
      "aws-runner-123",
      "repo",
      "octo-org/octo-repo",
      "github-token",
      ["self-hosted", "instance-type:m5a.xlarge", "timeout:235", "disk:150"]
    );

    expect(result).toEqual({ runnerId: 42, encodedJitConfig: "encoded-config" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      name: "aws-runner-123",
      runner_group_id: 1,
      labels: [
        "self-hosted",
        "linux",
        "x64",
        "instance-type:m5a.xlarge",
        "timeout:235",
        "disk:150",
      ],
      work_folder: "_work",
    });
  });
});
