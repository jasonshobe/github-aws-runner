import {
  EC2Client,
  RunInstancesCommand,
  DescribeImagesCommand,
  ResourceType,
} from "@aws-sdk/client-ec2";
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import { generateJitConfig } from "../webhook/github-client";
import { RUNNER_NAME_PREFIX } from "../reconciler/planner";

const ec2 = new EC2Client({});
const ssm = new SSMClient({});

const DEFAULT_AMI_NAME = "runs-on-v2.*-ubuntu22-full-x64-*";
const DEFAULT_AMI_OWNERS = ["135269210855"];

// Cached across warm starts — the AMI lookup is the same for every launch.
let cachedAmiId: string | undefined;

export const TAG_MANAGED = "github-aws-runner:managed";
export const TAG_LAUNCH_TIME = "github-aws-runner:launch-time";
export const TAG_JOB_ID = "github-aws-runner:job-id";
export const TAG_TIMEOUT_MINUTES = "github-aws-runner:timeout-minutes";
export const TAG_RUNNER_NAME = "github-aws-runner:runner-name";

/**
 * Builds the JIT runner name for a job.
 *
 * GitHub rejects a duplicate runner name with 409, so a reconciler top-up for a
 * job whose original runner was already minted must pass a `suffix` to get a
 * distinct name.
 */
export function buildRunnerName(jobId: string, suffix?: string): string {
  return suffix
    ? `${RUNNER_NAME_PREFIX}${jobId}-${suffix}`
    : `${RUNNER_NAME_PREFIX}${jobId}`;
}

export async function resolveAmiId(): Promise<string> {
  if (cachedAmiId) return cachedAmiId;

  let amiName = DEFAULT_AMI_NAME;
  let amiOwners = DEFAULT_AMI_OWNERS;

  const paramNames = [
    process.env.AMI_NAME_PARAM!,
    process.env.AMI_OWNERS_PARAM!,
  ].filter(Boolean);

  if (paramNames.length > 0) {
    const paramResult = await ssm.send(
      new GetParametersCommand({ Names: paramNames })
    );
    const byName = Object.fromEntries(
      (paramResult.Parameters ?? []).map((p: { Name?: string; Value?: string }) => [
        p.Name!,
        p.Value!,
      ])
    );
    if (byName[process.env.AMI_NAME_PARAM!]) {
      amiName = byName[process.env.AMI_NAME_PARAM!];
    }
    if (byName[process.env.AMI_OWNERS_PARAM!]) {
      amiOwners = byName[process.env.AMI_OWNERS_PARAM!]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  const imageResult = await ec2.send(
    new DescribeImagesCommand({
      Filters: [
        { Name: "name", Values: [amiName] },
        { Name: "state", Values: ["available"] },
      ],
      Owners: amiOwners,
    })
  );

  const images = (imageResult.Images ?? []).sort((a, b) =>
    (b.CreationDate ?? "").localeCompare(a.CreationDate ?? "")
  );

  if (images.length === 0) {
    throw new Error(
      `No AMI found matching name pattern "${amiName}" owned by ${amiOwners.join(", ")}`
    );
  }

  cachedAmiId = images[0].ImageId!;
  console.log(`Resolved AMI: ${cachedAmiId} (${images[0].Name})`);
  return cachedAmiId;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildUserData(
  encodedJitConfig: string,
  cacheBucket?: string
): string {
  const cacheEnv = cacheBucket
    ? `export RUNS_ON_S3_BUCKET_CACHE=${shellQuote(cacheBucket)}\n`
    : "";
  const script = `#!/bin/bash
set -euo pipefail

exec > >(tee -a /var/log/github-aws-runner-user-data.log | logger -t github-aws-runner-user-data -s 2>/dev/console) 2>&1

shutdown_on_exit() {
  local status=$?
  echo "Runner bootstrap exiting with status \${status}"
  shutdown -h now
}
trap shutdown_on_exit EXIT

JIT_CONFIG=${shellQuote(encodedJitConfig)}
${cacheEnv}
if ! id -u runner >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash runner
fi

if getent group docker >/dev/null 2>&1; then
  usermod -aG docker runner
else
  echo "Docker group does not exist; workflows that use Docker may need an AMI with Docker installed"
fi

install -d -o runner -g runner /home/runner/actions-runner
cd /home/runner/actions-runner

if [ ! -x ./run.sh ]; then
  RUNNER_VERSION="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | sed -n 's/.*"tag_name": "v\\([^"]*\\)".*/\\1/p' | head -n 1)"
  if [ -z "\${RUNNER_VERSION}" ]; then
    echo "Unable to determine latest GitHub Actions runner version"
    exit 1
  fi

  curl -fsSL \
    -o actions-runner.tar.gz \
    "https://github.com/actions/runner/releases/download/v\${RUNNER_VERSION}/actions-runner-linux-x64-\${RUNNER_VERSION}.tar.gz"
  tar xzf actions-runner.tar.gz
  rm actions-runner.tar.gz
  chown -R runner:runner /home/runner/actions-runner
fi

sudo -E -u runner ./run.sh --jitconfig "\${JIT_CONFIG}"
`;
  return Buffer.from(script).toString("base64");
}

export interface LaunchRequest {
  jobId: string;
  runnerName: string;
  instanceType: string;
  ebsSizeGb: number;
  timeoutMinutes: number;
  targetType: string;
  targetSlug: string;
  githubToken: string;
}

/**
 * Mints a JIT runner config and launches the EC2 instance that will consume it.
 * Returns the instance ID.
 */
export async function launchRunner(req: LaunchRequest): Promise<string> {
  const { encodedJitConfig } = await generateJitConfig(
    req.runnerName,
    req.targetType,
    req.targetSlug,
    req.githubToken
  );
  console.log(`Generated JIT config ${req.runnerName} for job ${req.jobId}`);

  const result = await ec2.send(
    new RunInstancesCommand({
      ImageId: await resolveAmiId(),
      InstanceType: req.instanceType as never,
      MinCount: 1,
      MaxCount: 1,
      SubnetId: process.env.SUBNET_ID!,
      SecurityGroupIds: [process.env.SECURITY_GROUP_ID!],
      IamInstanceProfile: { Arn: process.env.INSTANCE_PROFILE_ARN! },
      UserData: buildUserData(encodedJitConfig, process.env.CACHE_BUCKET_NAME),
      InstanceInitiatedShutdownBehavior: "terminate",
      BlockDeviceMappings: [
        {
          DeviceName: "/dev/sda1",
          Ebs: {
            VolumeSize: req.ebsSizeGb,
            VolumeType: "gp3",
            DeleteOnTermination: true,
          },
        },
      ],
      TagSpecifications: [
        {
          ResourceType: ResourceType.instance,
          Tags: [
            { Key: "Name", Value: `github-runner-${req.jobId}` },
            { Key: TAG_MANAGED, Value: "true" },
            { Key: TAG_LAUNCH_TIME, Value: new Date().toISOString() },
            { Key: TAG_JOB_ID, Value: req.jobId },
            { Key: TAG_TIMEOUT_MINUTES, Value: String(req.timeoutMinutes) },
            { Key: TAG_RUNNER_NAME, Value: req.runnerName },
          ],
        },
      ],
    })
  );

  const instanceId = result.Instances?.[0]?.InstanceId ?? "unknown";
  console.log(
    `Launched EC2 instance ${instanceId} for job ${req.jobId} as ${req.runnerName}`
  );
  return instanceId;
}
