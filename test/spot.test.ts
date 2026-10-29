import {
  isSpotCapacityError,
  parseMarket,
  parseSpotSettings,
  recheckMarket,
  resolveMarket,
  SpotCapacityError,
  TAG_MARKET,
} from "../lambda/shared/spot";

const S = { enabled: true, required: false };
const R = { enabled: true, required: true };
const D = { enabled: false, required: false };

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe("parseSpotSettings", () => {
  it("defaults to enabled, not required", () => {
    expect(parseSpotSettings(undefined, undefined)).toEqual(S);
  });

  it("parses booleans case-insensitively", () => {
    expect(parseSpotSettings("TRUE", "False")).toEqual(S);
    expect(parseSpotSettings("False", "false")).toEqual(D);
    expect(parseSpotSettings("true", "TRUE")).toEqual(R);
  });

  it("uses defaults and warns on unparseable values", () => {
    expect(parseSpotSettings("yes", "maybe")).toEqual(S);
    expect(warn).toHaveBeenCalled();
  });

  it("lets disabled win over required and warns naming both", () => {
    expect(parseSpotSettings("false", "true")).toEqual(D);
    const msg = warn.mock.calls.map((c) => String(c[0])).join(" ");
    expect(msg).toContain("spot-enabled");
    expect(msg).toContain("spot-required");
  });
});

describe("resolveMarket", () => {
  const none = ["self-hosted"];
  const yes = ["self-hosted", "spot:true"];
  const no = ["self-hosted", "spot:false"];
  const od = { market: "on-demand" };
  const spot = { market: "spot" };
  const reject = expect.objectContaining({ reject: expect.any(String) });

  it.each([
    ["enabled, optional, no label", S, none, od],
    ["enabled, optional, spot:true", S, yes, spot],
    ["enabled, optional, spot:false", S, no, od],
    ["required, no label", R, none, spot],
    ["required, spot:true", R, yes, spot],
    ["required, spot:false", R, no, reject],
    ["disabled, no label", D, none, od],
    ["disabled, spot:false", D, no, od],
    ["disabled, spot:true", D, yes, reject],
  ])("%s", (_name, settings, labels, expected) => {
    expect(resolveMarket(labels, settings)).toEqual(expected);
  });

  it("matches the label case-insensitively", () => {
    expect(resolveMarket(["self-hosted", "Spot:TRUE"], S)).toEqual(spot);
  });

  it("ignores an unrecognised spot value with a warning", () => {
    expect(resolveMarket(["self-hosted", "spot:maybe"], S)).toEqual(od);
    expect(warn).toHaveBeenCalled();
    expect(resolveMarket(["self-hosted", "spot:maybe"], R)).toEqual(spot);
  });

  it("rejects contradictory spot labels", () => {
    expect(
      resolveMarket(["self-hosted", "spot:true", "spot:false"], S),
    ).toEqual(reject);
  });
});

describe("recheckMarket", () => {
  it("flags stored choices that now conflict with settings", () => {
    expect(typeof recheckMarket("spot", D)).toBe("string");
    expect(typeof recheckMarket("on-demand", R)).toBe("string");
    expect(recheckMarket("on-demand", S)).toBeUndefined();
    expect(recheckMarket("spot", R)).toBeUndefined();
  });
});

describe("parseMarket", () => {
  it("treats anything but spot as on-demand", () => {
    expect(parseMarket(undefined)).toBe("on-demand");
    expect(parseMarket("bogus")).toBe("on-demand");
    expect(parseMarket("spot")).toBe("spot");
  });
});

describe("isSpotCapacityError", () => {
  it("recognises capacity codes by name or Code", () => {
    expect(isSpotCapacityError({ name: "InsufficientInstanceCapacity" })).toBe(
      true,
    );
    expect(isSpotCapacityError({ Code: "MaxSpotInstanceCountExceeded" })).toBe(
      true,
    );
    expect(isSpotCapacityError({ name: "UnauthorizedOperation" })).toBe(false);
    expect(isSpotCapacityError(new Error("x"))).toBe(false);
    expect(isSpotCapacityError(undefined)).toBe(false);
  });
});

describe("SpotCapacityError", () => {
  it("carries name and cause", () => {
    const cause = new Error("boom");
    const err = new SpotCapacityError("no capacity", cause);
    expect(err.name).toBe("SpotCapacityError");
    expect(err.message).toBe("no capacity");
    expect(err.cause).toBe(cause);
    expect(TAG_MARKET).toBe("github-aws-runner:market");
  });
});
