#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { GithubAwsRunnerStack } from "../lib/github-aws-runner-stack";

interface GitHubMetaResponse {
  hooks: string[];
}

async function fetchGitHubWebhookIps(): Promise<string[]> {
  const response = await fetch("https://api.github.com/meta", {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-aws-runner-cdk",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch GitHub /meta: ${response.status} ${response.statusText}`
    );
  }

  const meta = (await response.json()) as GitHubMetaResponse;
  if (!Array.isArray(meta.hooks) || meta.hooks.length === 0) {
    throw new Error("GitHub /meta response contained no webhook IP ranges");
  }

  console.log(
    `Fetched ${meta.hooks.length} GitHub webhook CIDR blocks for initial resource policy`
  );
  return meta.hooks;
}

async function main() {
  const initialWebhookIps = await fetchGitHubWebhookIps();

  const app = new cdk.App();

  new GithubAwsRunnerStack(app, "GithubAwsRunnerStack", {
    initialWebhookIps,
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
