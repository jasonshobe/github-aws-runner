import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DescribeImagesCommand, RunInstancesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { buildUserData, launchRunner, type LaunchRequest } from "../lambda/shared/launcher";
import { SpotCapacityError } from "../lambda/shared/spot";

// Execute the generated bootstrap with simulated devices and commands. A closed
// PATH keeps the test from invoking real disk, user, runner, or shutdown tools.
function runBootstrap(options: {
  device?: string;
  parent?: string;
  partition?: string;
  filesystem?: string;
  growStatus?: number;
  resizeStatus?: number;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "runner-bootstrap-"));
  const bin = join(directory, "bin");
  const runner = join(directory, "actions-runner");
  const trace = join(directory, "trace");
  mkdirSync(bin);
  mkdirSync(runner);
  writeFileSync(trace, "");
  writeFileSync(join(runner, "run.sh"), "#!/bin/bash\n", { mode: 0o755 });
  const device = options.device ?? "/dev/nvme0n1p1";
  const partition = options.partition ?? "1";
  const sysfs = join(directory, "sys", "class", "block", device.slice(device.lastIndexOf("/") + 1));
  mkdirSync(sysfs, { recursive: true });
  if (partition) writeFileSync(join(sysfs, "partition"), `${partition}\n`);

  const stub = join(bin, "stub");
  writeFileSync(stub, `#!/bin/bash
command_name=\${0##*/}
case "$command_name" in
  findmnt)
    case "$*" in
      "-n -o SOURCE /") printf '%s\\n' /dev/root ;;
      "-n -o MAJ:MIN /") printf '%s\\n' '259:1  ' ;;
      "-rn -o MAJ:MIN /") printf '%s\\n' 259:1 ;;
      "-n -o FSTYPE /"|"-rn -o FSTYPE /") printf '%s\\n' "$TEST_FILESYSTEM" ;;
      *) exit 99 ;;
    esac ;;
  readlink)
    # /dev/root can appear in mount metadata without an actual device node.
    [ "$*" = "-f /dev/block/259:1" ] || exit 99
    printf '%s\\n' "$TEST_DEVICE" ;;
  lsblk)
    case "$*" in
      "-dn -o PKNAME $TEST_DEVICE") printf '%s\\n' "$TEST_PARENT" ;;
      *) exit 99 ;;
    esac ;;
  growpart)
    printf 'growpart %s\\n' "$*" >> "$TEST_TRACE"
    exit "$TEST_GROW_STATUS" ;;
  resize2fs|xfs_growfs)
    printf '%s %s\\n' "$command_name" "$*" >> "$TEST_TRACE"
    exit "$TEST_RESIZE_STATUS" ;;
  sudo) printf 'runner\\n' >> "$TEST_TRACE" ;;
  shutdown) printf 'shutdown\\n' >> "$TEST_TRACE" ;;
  logger) while IFS= read -r line; do :; done ;;
  id|getent|useradd|usermod|install) : ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
  for (const command of [
    "findmnt", "readlink", "lsblk", "growpart", "resize2fs", "xfs_growfs",
    "sudo", "shutdown", "logger", "id", "getent", "useradd", "usermod", "install",
  ]) {
    symlinkSync(stub, join(bin, command));
  }
  symlinkSync("/usr/bin/tee", join(bin, "tee"));
  symlinkSync("/bin/cat", join(bin, "cat"));

  const script = Buffer.from(buildUserData("jit-config"), "base64").toString()
    .replaceAll("/home/runner/actions-runner", runner)
    .replaceAll("/var/log/github-aws-runner-user-data.log", join(directory, "bootstrap.log"))
    .replaceAll("/sys/class/block", join(directory, "sys", "class", "block"))
    .replaceAll("/dev/console", "/dev/null");
  try {
    const result = spawnSync("/bin/bash", ["-c", script], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        PATH: bin,
        TEST_TRACE: trace,
        TEST_DEVICE: device,
        TEST_PARENT: options.parent ?? "nvme0n1",
        TEST_FILESYSTEM: options.filesystem ?? "ext4",
        TEST_GROW_STATUS: String(options.growStatus ?? 0),
        TEST_RESIZE_STATUS: String(options.resizeStatus ?? 0),
      },
    });
    if (result.error) throw result.error;
    return { status: result.status, trace: readFileSync(trace, "utf8").trim().split("\n") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("runner bootstrap root filesystem growth", () => {
  const findmntError = spawnSync("findmnt", ["--version"]).error as NodeJS.ErrnoException | undefined;
  const testWithFindmnt = findmntError?.code === "ENOENT"
    ? it.skip
    : it;

  testWithFindmnt("reads mount metadata without surrounding whitespace using real findmnt", () => {
    const script = Buffer.from(buildUserData("jit-config"), "base64").toString();
    const commands = [...script.matchAll(/findmnt ([^)\n]+)/g)];
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      const result = spawnSync("findmnt", command[1].split(/\s+/), { encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      // Remove the line terminator, preserving any column padding.
      const output = result.stdout.replace(/\r?\n$/, "");
      expect(output).not.toBe("");
      expect(output).toBe(output.trim());
    }
  });

  it("grows the NVMe root before starting the runner even when /dev/root is absent", () => {
    expect(runBootstrap()).toEqual({
      status: 0,
      trace: ["growpart /dev/nvme0n1 1", "resize2fs /dev/nvme0n1p1", "runner", "shutdown"],
    });
  });

  it("discovers Xen device names and partition numbers", () => {
    expect(runBootstrap({ device: "/dev/xvda2", parent: "xvda", partition: "2" })).toEqual({
      status: 0,
      trace: ["growpart /dev/xvda 2", "resize2fs /dev/xvda2", "runner", "shutdown"],
    });
  });

  it("still resizes the filesystem when growpart reports NOCHANGE", () => {
    expect(runBootstrap({ growStatus: 1 })).toEqual({
      status: 0,
      trace: ["growpart /dev/nvme0n1 1", "resize2fs /dev/nvme0n1p1", "runner", "shutdown"],
    });
  });

  it("shuts down without starting the runner when partition growth fails", () => {
    expect(runBootstrap({ growStatus: 2 })).toEqual({
      status: 2,
      trace: ["growpart /dev/nvme0n1 1", "shutdown"],
    });
  });

  it("shuts down without starting the runner when filesystem resizing fails", () => {
    expect(runBootstrap({ resizeStatus: 1 })).toEqual({
      status: 1,
      trace: ["growpart /dev/nvme0n1 1", "resize2fs /dev/nvme0n1p1", "shutdown"],
    });
  });

  it("uses the mounted root directory to grow an XFS filesystem", () => {
    expect(runBootstrap({ filesystem: "xfs" })).toEqual({
      status: 0,
      trace: ["growpart /dev/nvme0n1 1", "xfs_growfs -d /", "runner", "shutdown"],
    });
  });

  it("resizes an unpartitioned root device without calling growpart", () => {
    expect(runBootstrap({ device: "/dev/xvda", parent: "", partition: "" })).toEqual({
      status: 0,
      trace: ["resize2fs /dev/xvda", "runner", "shutdown"],
    });
  });

  it("rejects unsupported filesystems before modifying the partition", () => {
    expect(runBootstrap({ filesystem: "btrfs" })).toEqual({
      status: 1,
      trace: ["shutdown"],
    });
  });

  it("rejects logical volumes instead of silently leaving the root undersized", () => {
    expect(runBootstrap({ device: "/dev/dm-0", parent: "nvme0n1p3", partition: "" })).toEqual({
      status: 1,
      trace: ["shutdown"],
    });
  });
});

describe("launchRunner", () => {
  const originalEnv = process.env;
  let runInstances: jest.Mock;
  let fetchMock: jest.SpyInstance;

  const request = (market: LaunchRequest["market"]): LaunchRequest => ({
    jobId: "100",
    runnerName: "aws-runner-100",
    labels: ["self-hosted"],
    instanceType: "c7a.large",
    ebsSizeGb: 50,
    timeoutMinutes: 60,
    targetType: "repo",
    targetSlug: "o/r",
    githubToken: "tok",
    market,
  });

  const runInput = () => runInstances.mock.calls[0][0].input;
  const tags = () => runInput().TagSpecifications[0].Tags;
  const err = (name: string) => Object.assign(new Error(name), { name });
  const subnetsTried = () =>
    runInstances.mock.calls.map((c) => c[0].input.SubnetId);
  const deleteCalls = () =>
    fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE");

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SUBNET_IDS: "subnet-a,subnet-b,subnet-c",
      SECURITY_GROUP_ID: "sg-1",
      INSTANCE_PROFILE_ARN: "arn:aws:iam::123456789012:instance-profile/p",
    };
    runInstances = jest.fn().mockResolvedValue({ Instances: [{ InstanceId: "i-1" }] });
    jest.spyOn(EC2Client.prototype, "send").mockImplementation(((command: unknown) => {
      if (command instanceof DescribeImagesCommand) {
        return Promise.resolve({ Images: [{ ImageId: "ami-1", CreationDate: "2026-01-01" }] });
      }
      if (command instanceof RunInstancesCommand) return runInstances(command);
      return Promise.reject(new Error("unexpected command"));
    }) as never);
    fetchMock = jest.spyOn(global, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) =>
      init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ runner: { id: 42 }, encoded_jit_config: "cfg" }), { status: 201 })) as never);
    jest.spyOn(Math, "random").mockReturnValue(0);
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it("launches On-Demand without InstanceMarketOptions", async () => {
    await launchRunner(request("on-demand"));

    expect(runInput()).not.toHaveProperty("InstanceMarketOptions");
    expect(tags()).toContainEqual({ Key: "github-aws-runner:market", Value: "on-demand" });
  });

  it("launches Spot as a one-time request with no price cap", async () => {
    await launchRunner(request("spot"));

    expect(runInput().InstanceMarketOptions).toEqual({
      MarketType: "spot",
      SpotOptions: { SpotInstanceType: "one-time", InstanceInterruptionBehavior: "terminate" },
    });
    expect(tags()).toContainEqual({ Key: "github-aws-runner:market", Value: "spot" });
  });

  it("turns a Spot capacity refusal into SpotCapacityError and deletes the JIT registration", async () => {
    runInstances.mockRejectedValue(Object.assign(new Error("no capacity"), { name: "InsufficientInstanceCapacity" }));

    await expect(launchRunner(request("spot"))).rejects.toBeInstanceOf(SpotCapacityError);

    const deletes = deleteCalls();
    expect(deletes).toHaveLength(1);
    expect(String(deletes[0][0])).toMatch(/\/42$/);
  });

  it("still throws SpotCapacityError when deleting the registration fails", async () => {
    runInstances.mockRejectedValue(Object.assign(new Error("no capacity"), { name: "InsufficientInstanceCapacity" }));
    fetchMock.mockImplementation((async (_url: unknown, init?: RequestInit) =>
      init?.method === "DELETE"
        ? new Response("boom", { status: 500 })
        : new Response(JSON.stringify({ runner: { id: 42 }, encoded_jit_config: "cfg" }), { status: 201 })) as never);

    await expect(launchRunner(request("spot"))).rejects.toBeInstanceOf(SpotCapacityError);
    expect(deleteCalls()).toHaveLength(1);
  });

  it("passes non-capacity errors through", async () => {
    const denied = err("UnauthorizedOperation");
    runInstances.mockRejectedValue(denied);

    await expect(launchRunner(request("spot"))).rejects.toBe(denied);
    expect(subnetsTried()).toEqual(["subnet-a"]);
    expect(deleteCalls()).toHaveLength(0);
  });

  it("tries the next subnet after a zonal refusal and returns that instance", async () => {
    runInstances.mockRejectedValueOnce(err("InsufficientInstanceCapacity"))
      .mockResolvedValueOnce({ Instances: [{ InstanceId: "i-b" }] });
    await expect(launchRunner(request("on-demand"))).resolves.toBe("i-b");
    expect(subnetsTried()).toEqual(["subnet-a", "subnet-b"]);
  });

  it("moves on from Unsupported", async () => {
    runInstances.mockRejectedValueOnce(err("Unsupported"))
      .mockResolvedValueOnce({ Instances: [{ InstanceId: "i-b" }] });
    await expect(launchRunner(request("spot"))).resolves.toBe("i-b");
  });

  it("starts at a random subnet and wraps around, trying each once", async () => {
    jest.mocked(Math.random).mockReturnValue(0.5); // floor(0.5 * 3) = 1
    runInstances.mockRejectedValue(err("InsufficientInstanceCapacity"));
    await expect(launchRunner(request("on-demand"))).rejects.toMatchObject({ name: "InsufficientInstanceCapacity" });
    expect(subnetsTried()).toEqual(["subnet-b", "subnet-c", "subnet-a"]);
  });

  it("mints the JIT config once across attempts", async () => {
    runInstances.mockRejectedValueOnce(err("InsufficientInstanceCapacity"))
      .mockResolvedValueOnce({ Instances: [{ InstanceId: "i-b" }] });
    await launchRunner(request("on-demand"));
    expect(fetchMock.mock.calls.filter(([, i]) => i?.method !== "DELETE")).toHaveLength(1);
  });

  it("stops at MaxSpotInstanceCountExceeded with SpotCapacityError", async () => {
    runInstances.mockRejectedValue(err("MaxSpotInstanceCountExceeded"));
    await expect(launchRunner(request("spot"))).rejects.toBeInstanceOf(SpotCapacityError);
    expect(subnetsTried()).toEqual(["subnet-a"]);
    expect(deleteCalls()).toHaveLength(1);
  });

  it("On-Demand stops at a regional error after a zonal refusal", async () => {
    runInstances.mockRejectedValueOnce(err("InsufficientInstanceCapacity"))
      .mockRejectedValueOnce(err("VcpuLimitExceeded"));
    await expect(launchRunner(request("on-demand"))).rejects.toMatchObject({ name: "VcpuLimitExceeded" });
    expect(subnetsTried()).toHaveLength(2);
    expect(deleteCalls()).toHaveLength(0);
  });

  it("Spot stops at a quota wait after a zonal refusal", async () => {
    runInstances.mockRejectedValueOnce(err("InsufficientInstanceCapacity"))
      .mockRejectedValueOnce(err("MaxSpotInstanceCountExceeded"));
    await expect(launchRunner(request("spot"))).rejects.toBeInstanceOf(SpotCapacityError);
    expect(subnetsTried()).toHaveLength(2);
    expect(deleteCalls()).toHaveLength(1);
  });

  it("Spot refused everywhere with a mix of Unsupported and capacity waits", async () => {
    runInstances.mockRejectedValueOnce(err("Unsupported"))
      .mockRejectedValueOnce(err("InsufficientInstanceCapacity"))
      .mockRejectedValueOnce(err("Unsupported"));
    await expect(launchRunner(request("spot"))).rejects.toBeInstanceOf(SpotCapacityError);
    expect(deleteCalls()).toHaveLength(1);
  });

  it("Spot with Unsupported in every zone throws the raw error", async () => {
    runInstances.mockRejectedValue(err("Unsupported"));
    await expect(launchRunner(request("spot"))).rejects.toMatchObject({ name: "Unsupported" });
    expect(subnetsTried()).toHaveLength(3);
    expect(deleteCalls()).toHaveLength(0);
  });

  it("On-Demand refused everywhere throws the last refusal", async () => {
    runInstances.mockRejectedValueOnce(err("Unsupported"))
      .mockRejectedValueOnce(err("Unsupported"))
      .mockRejectedValueOnce(err("InsufficientInstanceCapacity"));
    await expect(launchRunner(request("on-demand"))).rejects.toMatchObject({ name: "InsufficientInstanceCapacity" });
    expect(deleteCalls()).toHaveLength(0);
  });

  it("tolerates a single subnet and stray separators in SUBNET_IDS", async () => {
    process.env.SUBNET_IDS = " subnet-only , ,";
    await launchRunner(request("on-demand"));
    expect(subnetsTried()).toEqual(["subnet-only"]);
  });
});
