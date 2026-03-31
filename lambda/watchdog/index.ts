import {
  EC2Client,
  DescribeInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const ec2 = new EC2Client({});
const ssm = new SSMClient({});

export async function handler(): Promise<void> {
  // Fetch timeout from SSM
  const paramResult = await ssm.send(
    new GetParameterCommand({
      Name: process.env.RUNNER_TIMEOUT_PARAM!,
    })
  );
  const timeoutMinutes = parseInt(paramResult.Parameter!.Value!, 10);
  const timeoutMs = timeoutMinutes * 60 * 1000;
  const now = Date.now();

  console.log(`Watchdog checking for instances older than ${timeoutMinutes} minutes`);

  // Collect all running managed instances (paginated)
  const staleInstanceIds: string[] = [];
  let nextToken: string | undefined;
  let checkedCount = 0;

  do {
    const result = await ec2.send(
      new DescribeInstancesCommand({
        Filters: [
          { Name: "tag:github-aws-runner:managed", Values: ["true"] },
          { Name: "instance-state-name", Values: ["running"] },
        ],
        NextToken: nextToken,
      })
    );

    for (const reservation of result.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        checkedCount++;
        const launchTag = instance.Tags?.find(
          (t) => t.Key === "github-aws-runner:launch-time"
        );
        if (!launchTag?.Value) {
          console.warn(
            `Instance ${instance.InstanceId} has no launch-time tag — skipping`
          );
          continue;
        }
        const timeoutTag = instance.Tags?.find(
          (t) => t.Key === "github-aws-runner:timeout-minutes"
        );
        const instanceTimeoutMinutes = timeoutTag?.Value
          ? Math.min(parseInt(timeoutTag.Value, 10), timeoutMinutes)
          : timeoutMinutes;
        const instanceTimeoutMs = instanceTimeoutMinutes * 60 * 1000;
        const launchTime = new Date(launchTag.Value).getTime();
        const ageMs = now - launchTime;
        if (ageMs > instanceTimeoutMs) {
          const ageMinutes = Math.floor(ageMs / 60000);
          console.log(
            `Instance ${instance.InstanceId} is ${ageMinutes}m old (limit ${instanceTimeoutMinutes}m) — marking for termination`
          );
          staleInstanceIds.push(instance.InstanceId!);
        }
      }
    }

    nextToken = result.NextToken;
  } while (nextToken);

  if (staleInstanceIds.length > 0) {
    await ec2.send(
      new TerminateInstancesCommand({ InstanceIds: staleInstanceIds })
    );
    console.log(
      `Terminated ${staleInstanceIds.length} stale instance(s): ${staleInstanceIds.join(", ")}`
    );
  }

  console.log(
    `Watchdog complete: checked ${checkedCount} instance(s), terminated ${staleInstanceIds.length}`
  );
}
