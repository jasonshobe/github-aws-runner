# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build       # compile TypeScript
npm run watch       # compile in watch mode
npm test            # run all Jest tests
npm test -- --testNamePattern="creates a VPC"  # run a single test by name
npx cdk synth       # synthesize CloudFormation template
npx cdk deploy      # deploy the stack
npx cdk deploy --context ssmPrefix=/my-runner  # deploy with a custom SSM prefix
```

## Architecture

This is a CDK TypeScript project that provisions on-demand ephemeral GitHub Actions self-hosted runners on AWS EC2. A single CDK stack (`lib/github-aws-runner-stack.ts`) creates the entire system.

### Request Flow

1. GitHub sends a `workflow_job` webhook → API Gateway (POST /webhook) → **Webhook Lambda**
2. Webhook Lambda validates the HMAC signature, checks runner labels and concurrency limits, calls the GitHub API to generate a JIT runner config, and launches an EC2 instance
3. The EC2 instance runs the GitHub Actions runner via user data, then self-terminates on completion (`InstanceInitiatedShutdownBehavior: terminate`)
4. **Watchdog Lambda** runs every 15 minutes via EventBridge to terminate any instance that has exceeded its timeout
5. **IP Updater Lambda** runs on a configurable schedule (default: every 12 hours) to refresh the API Gateway resource policy with current GitHub webhook CIDR blocks from `https://api.github.com/meta`
6. A **Custom Resource Lambda** creates and deletes the GitHub webhook registration during CloudFormation stack create/delete

### Key Design Decisions

**SSM Parameters at synth time vs. runtime**: Most configuration is stored in SSM and read by Lambdas at runtime (no redeployment needed). Three parameters are resolved at CDK synth time because they affect CloudFormation resources: `max-concurrent-runners` (Lambda reserved concurrency), `api-throttle-rate-limit`/`api-throttle-burst-limit` (API Gateway stage throttling), and `ip-updater-interval-hours` (EventBridge schedule). Changing these requires `cdk deploy`.

**SSM parameter prefix**: All parameter names share a prefix, defaulting to `/github-aws-runner`. Override with `--context ssmPrefix=/my-prefix` at deploy time. This is resolved at synth time; the prefix is baked into Lambda environment variables as the parameter names.

**Webhook Lambda caching**: SSM values (webhook secret, all config params) are cached in module-level variables on warm Lambda starts to reduce SSM API calls.

**IP policy update failures are non-fatal**: The IP Updater Lambda catches errors from the API Gateway PATCH call and logs them without rethrowing, so the previous policy remains active if the update fails.

**EC2 instance tagging for concurrency and timeout**: The Webhook Lambda tags launched instances with `github-aws-runner:managed=true`, `github-aws-runner:launch-time`, and `github-aws-runner:timeout-minutes`. The Watchdog uses `DescribeInstances` filtered by those tags to find and time out stale runners. The Webhook Lambda counts running instances by the same tag to enforce `max-concurrent-runners`.

**Per-job instance/disk/timeout overrides**: Workflows can request a specific instance type, EBS volume size, or timeout via job labels (e.g., `c7a.large`, `disk:100`, `timeout:30`). The Webhook Lambda validates these against the optional SSM bounds parameters (`allowed-instance-types`, `max-ebs-volume-size-gb`, `runner-timeout-minutes`).

### Lambda Modules

| Lambda | Entry | Trigger | Purpose |
|--------|-------|---------|---------|
| Webhook | `lambda/webhook/index.ts` | API Gateway POST /webhook | Validate webhook, launch EC2 runner |
| IP Updater | `lambda/ip-updater/index.ts` | EventBridge (configurable interval) | Refresh API resource policy with GitHub CIDRs |
| Watchdog | `lambda/watchdog/index.ts` | EventBridge (every 15 min) | Terminate timed-out runner instances |
| Custom Resource | `lambda/custom-resource/index.ts` | CloudFormation lifecycle | Register/deregister GitHub webhook |
| Cache Bucket | `lambda/cache-bucket/index.ts` | CloudFormation lifecycle (conditional) | Create S3 cache bucket and apply lifecycle policy |
| OIDC | `lambda/oidc/index.ts` | CloudFormation lifecycle (conditional) | Set/delete `AWS_ROLE_ARN` GitHub Actions variable |

GitHub API calls (JIT config generation, webhook create/delete, Actions variable set/delete) are in `lambda/webhook/github-client.ts`.

### CDK Stack Structure

The stack constructor (`lib/github-aws-runner-stack.ts`) is organized into sections in this order:
1. SSM parameter name constants (all built from the configurable prefix)
2. Synth-time SSM lookups (`valueFromLookup`) for concurrency, throttling, IP updater interval, cache bucket, and OIDC
3. VPC and security group
4. EC2 IAM role and instance profile
5. Webhook Lambda + API Gateway (RestApi, resource policy, deployment stage, access logs, POST route)
6. IP Updater Lambda + EventBridge rule
7. Watchdog Lambda + EventBridge rule
8. Custom resource (webhook registration) + provider
9. Conditional: S3 cache bucket custom resource + provider (when `cache-bucket` SSM param is set)
10. Conditional: OIDC provider, IAM role, OIDC custom resource + provider (when both `oidc-role-policy-arn` and `oidc-subject-pattern` SSM params are set)
11. Stack outputs

### Tests

`test/github-aws-runner.test.ts` uses CDK assertions (`Template.fromStack`) to verify that the correct AWS resources are synthesized. The test constructs the stack with a known set of `initialWebhookIps`. When adding new CDK resources or changing existing ones, update the corresponding assertions.
