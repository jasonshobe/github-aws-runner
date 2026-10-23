import {
  APIGatewayClient,
  CreateDeploymentCommand,
  UpdateRestApiCommand,
} from "@aws-sdk/client-api-gateway";

const apigateway = new APIGatewayClient({});

interface GitHubMetaResponse {
  hooks: string[];
}

function buildResourcePolicy(
  cidrBlocks: string[],
  region: string,
  accountId: string,
  apiId: string
): string {
  const resourceArn = `arn:aws:execute-api:${region}:${accountId}:${apiId}/*`;
  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Deny",
        Principal: { AWS: "*" },
        Action: "execute-api:Invoke",
        Resource: resourceArn,
        Condition: {
          NotIpAddress: {
            "aws:SourceIp": cidrBlocks,
          },
        },
      },
      {
        Effect: "Allow",
        Principal: { AWS: "*" },
        Action: "execute-api:Invoke",
        Resource: resourceArn,
      },
    ],
  };
  return JSON.stringify(policy);
}

export async function handler(): Promise<void> {
  const restApiId = process.env.REST_API_ID!;
  const stageName = process.env.REST_API_STAGE_NAME!;
  const region = process.env.AWS_REGION!;
  const accountId = process.env.ACCOUNT_ID!;

  // Fetch current GitHub webhook IP ranges
  const response = await fetch("https://api.github.com/meta", {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-aws-runner",
    },
  });

  if (!response.ok) {
    throw new Error(
      `GitHub /meta request failed: ${response.status} ${response.statusText}`
    );
  }

  const meta = (await response.json()) as GitHubMetaResponse;
  const cidrBlocks = meta.hooks;
  console.log(`Fetched ${cidrBlocks.length} GitHub webhook CIDR blocks`);

  // Update the REST API resource policy
  const policy = buildResourcePolicy(cidrBlocks, region, accountId, restApiId);

  try {
    await apigateway.send(
      new UpdateRestApiCommand({
        restApiId,
        patchOperations: [
          {
            op: "replace",
            path: "/policy",
            value: policy,
          },
        ],
      })
    );
    console.log(`Updated API Gateway resource policy with ${cidrBlocks.length} CIDR blocks`);
  } catch (err) {
    console.error("Failed to update API Gateway resource policy:", err);
    throw err;
  }

  // Resource policy changes take effect only after the API is redeployed.
  try {
    await apigateway.send(
      new CreateDeploymentCommand({
        restApiId,
        stageName,
      })
    );
    console.log(`Deployed API Gateway resource policy to stage ${stageName}`);
  } catch (err) {
    console.error("Failed to deploy API Gateway resource policy:", err);
    throw err;
  }
}
