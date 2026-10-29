import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import { getParametersByName } from "../lambda/shared/ssm";

describe("getParametersByName", () => {
  afterEach(() => jest.restoreAllMocks());

  test("batches names in groups of at most 10 and merges results", async () => {
    const names = Array.from({ length: 12 }, (_, i) => `/p/${i}`);
    const send = jest
      .spyOn(SSMClient.prototype, "send")
      .mockImplementation(((cmd: GetParametersCommand) =>
        Promise.resolve({
          Parameters: (cmd.input.Names ?? [])
            .filter((n) => n !== "/p/3")
            .map((Name) => ({ Name, Value: `v${Name}` })),
        })) as never);

    const result = await getParametersByName(new SSMClient({}), names);

    expect(send).toHaveBeenCalledTimes(2);
    for (const [cmd] of send.mock.calls) {
      expect(cmd).toBeInstanceOf(GetParametersCommand);
      expect((cmd as GetParametersCommand).input.Names!.length).toBeLessThanOrEqual(10);
      expect((cmd as GetParametersCommand).input.WithDecryption).toBe(true);
    }
    expect(Object.keys(result)).toHaveLength(11);
    expect(result["/p/0"]).toBe("v/p/0");
    expect(result["/p/11"]).toBe("v/p/11");
    expect("/p/3" in result).toBe(false);
  });

  test("makes no call for an empty list", async () => {
    const send = jest.spyOn(SSMClient.prototype, "send");
    expect(await getParametersByName(new SSMClient({}), [])).toEqual({});
    expect(send).not.toHaveBeenCalled();
  });
});
