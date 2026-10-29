import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";

/** SSM rejects a GetParameters request that names more than this many parameters. */
const MAX_NAMES_PER_REQUEST = 10;

/**
 * Fetches parameters by name, splitting the request to respect SSM's 10-name
 * limit. Parameters that do not exist are simply absent from the result.
 */
export async function getParametersByName(
  client: SSMClient,
  names: string[]
): Promise<Record<string, string>> {
  const byName: Record<string, string> = {};
  for (let i = 0; i < names.length; i += MAX_NAMES_PER_REQUEST) {
    const result = await client.send(
      new GetParametersCommand({
        Names: names.slice(i, i + MAX_NAMES_PER_REQUEST),
        WithDecryption: true,
      })
    );
    for (const p of result.Parameters ?? []) {
      byName[p.Name!] = p.Value!;
    }
  }
  return byName;
}
