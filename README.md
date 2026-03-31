# github-aws-runner

On-demand, ephemeral GitHub Actions runners hosted on AWS EC2. When a GitHub Actions job is queued, a webhook triggers an AWS Lambda function that spins up an EC2 instance using the [RunsOn](https://github.com/runs-on/runner-images-for-aws) runner AMI. The instance registers with GitHub as a JIT (Just-In-Time) runner, executes the job, and self-terminates.

## Architecture

```
GitHub Actions job queued
        │
        ▼
  GitHub Webhook
        │
        ▼
  API Gateway (REST API)
  └── Resource policy: allow only GitHub webhook IPs
        │
        ▼
  Webhook Lambda
  ├── Validates HMAC-SHA256 webhook signature
  ├── Calls GitHub API to generate JIT runner config
  └── Launches EC2 instance (RunsOn AMI)
              │
              ▼
        EC2 Runner Instance
        ├── Runs GitHub Actions job
        └── Self-terminates on completion

Scheduled: every 12 hours
  IP Updater Lambda
  └── Fetches GitHub webhook CIDRs → updates API resource policy

Scheduled: every 15 minutes
  Watchdog Lambda
  └── Terminates any runner instances that exceed the timeout

CDK deploy/destroy
  Custom Resource Lambda
  └── Registers / deregisters the GitHub webhook
```

## Prerequisites

- [Node.js](https://nodejs.org/) 22.x or later
- [AWS CLI](https://aws.amazon.com/cli/) configured with credentials for your target account
- [AWS CDK](https://docs.aws.amazon.com/cdk/latest/guide/cli.html) v2 (`npm install -g aws-cdk`)
- A GitHub personal access token with the required scopes (see below)

## GitHub Token Permissions

The personal access token stored in SSM must have:

| Target | Required scopes |
|--------|----------------|
| Repository runners | `administration: write` (fine-grained) or `repo` (classic) |
| Organization runners | `organization_self_hosted_runners: write` (fine-grained) or `admin:org` (classic) |
| Webhook management | `admin:repo_hook` (repo) or `admin:org_hook` (org) |

## SSM Parameters

All configuration is stored in AWS Systems Manager Parameter Store. You must create these parameters in your target account and region before deploying.

| Parameter | Type | Description |
|-----------|------|-------------|
| `/github-aws-runner/github-token` | SecureString | GitHub personal access token |
| `/github-aws-runner/webhook-secret` | SecureString | Shared secret for HMAC webhook signature validation |
| `/github-aws-runner/target-type` | String | `repo` or `org` |
| `/github-aws-runner/target-slug` | String | `owner/repo` (for repo) or `myorg` (for org) |
| `/github-aws-runner/runner-timeout-minutes` | String | Max runtime per runner in minutes (e.g. `60`) |
| `/github-aws-runner/instance-type` | String | EC2 instance type for runners (e.g. `c7a.large`) |

### Creating the parameters

```bash
# GitHub access token
aws ssm put-parameter \
  --name /github-aws-runner/github-token \
  --type SecureString \
  --value "ghp_..."

# Webhook shared secret (generate a strong random value)
aws ssm put-parameter \
  --name /github-aws-runner/webhook-secret \
  --type SecureString \
  --value "$(openssl rand -hex 32)"

# Target: repository
aws ssm put-parameter \
  --name /github-aws-runner/target-type \
  --type String \
  --value "repo"

aws ssm put-parameter \
  --name /github-aws-runner/target-slug \
  --type String \
  --value "myorg/myrepo"

# Or target: organization
aws ssm put-parameter \
  --name /github-aws-runner/target-type \
  --type String \
  --value "org"

aws ssm put-parameter \
  --name /github-aws-runner/target-slug \
  --type String \
  --value "myorg"

# Runner timeout
aws ssm put-parameter \
  --name /github-aws-runner/runner-timeout-minutes \
  --type String \
  --value "60"

# EC2 instance type
aws ssm put-parameter \
  --name /github-aws-runner/instance-type \
  --type String \
  --value "c7a.large"
```

## Deployment

1. Install dependencies:

   ```bash
   npm install
   ```

2. Bootstrap CDK (first-time only per account/region):

   ```bash
   cdk bootstrap
   ```

3. Deploy:

   ```bash
   cdk deploy
   ```

   The stack will:
   - Fetch current GitHub webhook IP ranges and apply them to the API resource policy
   - Resolve the RunsOn AMI ID
   - Deploy all AWS resources
   - Register the webhook with GitHub via a custom resource

4. Note the output URL:

   ```
   Outputs:
   GithubAwsRunnerStack.WebhookApiUrl = https://<id>.execute-api.<region>.amazonaws.com/prod/webhook
   ```

   The webhook is registered automatically. You can verify it in your repository or organization settings under **Webhooks**.

## Usage in a Workflow

Add `self-hosted` to your job's `runs-on` label to use an on-demand runner:

```yaml
jobs:
  build:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4
      - run: echo "Running on an ephemeral AWS runner"
```

The runner is provisioned automatically when the job is queued and terminated when it completes.

## Configuration

Both the EC2 instance type and the runner timeout are read from SSM at runtime, so they can be changed without redeploying the stack.

### EC2 Instance Type

Update the `/github-aws-runner/instance-type` parameter:

```bash
aws ssm put-parameter \
  --name /github-aws-runner/instance-type \
  --type String \
  --value "m7a.xlarge" \
  --overwrite
```

### Runner Timeout

Update the `/github-aws-runner/runner-timeout-minutes` parameter:

```bash
aws ssm put-parameter \
  --name /github-aws-runner/runner-timeout-minutes \
  --type String \
  --value "120" \
  --overwrite
```

## Teardown

```bash
cdk destroy
```

This will delete all AWS resources and deregister the GitHub webhook.

## License

[MIT](LICENSE)

## Development

```bash
# Type-check
npx tsc --noEmit

# Run tests
npm test

# Synthesize CloudFormation template (requires AWS credentials for AMI lookup)
cdk synth
```
