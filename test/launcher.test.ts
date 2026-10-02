import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUserData } from "../lambda/shared/launcher";

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
      "-n -o MAJ:MIN /") printf '%s\\n' 259:1 ;;
      "-n -o FSTYPE /") printf '%s\\n' "$TEST_FILESYSTEM" ;;
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
