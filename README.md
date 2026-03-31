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

Scheduled: every N hours (configurable via SSM)
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

The `/github-aws-runner` prefix used in all parameter names is the default. It can be changed by setting the `ssmPrefix` CDK context variable (see [Deployment](#deployment)).

| Parameter | Type | Description |
|-----------|------|-------------|
| `/github-aws-runner/github-token` | SecureString | GitHub personal access token |
| `/github-aws-runner/webhook-secret` | SecureString | Shared secret for HMAC webhook signature validation |
| `/github-aws-runner/target-type` | String | `repo` or `org` |
| `/github-aws-runner/target-slug` | String | `owner/repo` (for repo) or `myorg` (for org) |
| `/github-aws-runner/runner-timeout-minutes` | String | Max runtime per runner in minutes (e.g. `60`) |
| `/github-aws-runner/instance-type` | String | EC2 instance type for runners (e.g. `c7a.large`) |
| `/github-aws-runner/ebs-volume-size-gb` | String | Root EBS volume size in GB (e.g. `80`) |
| `/github-aws-runner/max-concurrent-runners` | String | Max simultaneous runner EC2 instances (e.g. `10`) |
| `/github-aws-runner/api-throttle-rate-limit` | String | API Gateway steady-state requests per second (e.g. `10`) |
| `/github-aws-runner/api-throttle-burst-limit` | String | API Gateway burst request limit (e.g. `5`) |
| `/github-aws-runner/runner-label` | String | Additional label required on jobs beyond `self-hosted` (optional) |
| `/github-aws-runner/allowed-instance-types` | String | Comma-separated list of instance types workflows may request (optional) |
| `/github-aws-runner/max-ebs-volume-size-gb` | String | Upper bound on the EBS volume size workflows may request in GB (optional) |
| `/github-aws-runner/ip-updater-interval-hours` | String | How often the IP updater runs in hours (e.g. `12`); requires `cdk deploy` to take effect |
| `/github-aws-runner/ami-name` | String | AMI name pattern to search for (optional, default: `runs-on-v2.*-ubuntu22-full-x64-*`) |
| `/github-aws-runner/ami-owners` | String | Comma-separated list of AMI owner account IDs (optional, default: `135269210855`) |

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

# EBS volume size (GB)
aws ssm put-parameter \
  --name /github-aws-runner/ebs-volume-size-gb \
  --type String \
  --value "80"

# Max concurrent runners
aws ssm put-parameter \
  --name /github-aws-runner/max-concurrent-runners \
  --type String \
  --value "10"

# API Gateway throttling
aws ssm put-parameter \
  --name /github-aws-runner/api-throttle-rate-limit \
  --type String \
  --value "10"

aws ssm put-parameter \
  --name /github-aws-runner/api-throttle-burst-limit \
  --type String \
  --value "5"

# IP updater interval (hours)
aws ssm put-parameter \
  --name /github-aws-runner/ip-updater-interval-hours \
  --type String \
  --value "12"
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

   To use a custom SSM parameter prefix instead of `/github-aws-runner`, pass the `ssmPrefix` context variable. All SSM parameters must be created under the same prefix.

   ```bash
   cdk deploy --context ssmPrefix=/my-runner
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

If you have configured the optional `/github-aws-runner/runner-label` SSM parameter (e.g. `aws`), include it alongside `self-hosted`:

```yaml
jobs:
  build:
    runs-on: [self-hosted, aws]
    steps:
      - uses: actions/checkout@v4
      - run: echo "Running on an ephemeral AWS runner"
```

Jobs that do not include the required additional label are ignored and will not trigger a runner launch.

Workflows can also request a specific EC2 instance type, disk size, or timeout using labels. The instance type must be in the `/github-aws-runner/allowed-instance-types` list and the disk size may not exceed `/github-aws-runner/max-ebs-volume-size-gb`. The timeout may not exceed `/github-aws-runner/runner-timeout-minutes`. If the instance type or disk size SSM parameter is not configured, the corresponding label is ignored and the SSM default is used.

```yaml
jobs:
  build:
    # Request a larger instance and more disk space
    runs-on: [self-hosted, instance-type:m7a.2xlarge, disk:200]
    steps:
      - uses: actions/checkout@v4
      - run: echo "Running on a large ephemeral AWS runner"

  short-lived:
    # Request a shorter timeout (in minutes) than the SSM default
    runs-on: [self-hosted, timeout:15]
    steps:
      - uses: actions/checkout@v4
      - run: echo "Runner will be terminated if still running after 15 minutes"
```

The runner is provisioned automatically when the job is queued and terminated when it completes.

## Configuration

The EC2 instance type, EBS volume size, and runner timeout are read from SSM at runtime and can be changed without redeploying the stack. The following parameters require a `cdk deploy` to take effect because they are resolved at synth time:

- **max-concurrent-runners** — also controls Lambda reserved concurrency (the EC2 instance cap takes effect immediately without a deploy)
- **api-throttle-rate-limit** — controls API Gateway stage throttling
- **api-throttle-burst-limit** — controls API Gateway stage throttling
- **ip-updater-interval-hours** — controls the EventBridge schedule rate for the IP updater

### EC2 Instance Type

Update the `/github-aws-runner/instance-type` parameter:

```bash
aws ssm put-parameter \
  --name /github-aws-runner/instance-type \
  --type String \
  --value "m7a.xlarge" \
  --overwrite
```

### Max Concurrent Runners

Update the `/github-aws-runner/max-concurrent-runners` parameter:

```bash
aws ssm put-parameter \
  --name /github-aws-runner/max-concurrent-runners \
  --type String \
  --value "10" \
  --overwrite
```

Then run `cdk deploy` to update the Lambda reserved concurrency to match.

### Allowed Instance Types

Set the comma-separated list of instance types that workflows may request via the `instance-type:` label. If this parameter is not set, instance type labels in workflows are ignored and the default is always used.

```bash
aws ssm put-parameter \
  --name /github-aws-runner/allowed-instance-types \
  --type String \
  --value "c7a.large,c7a.xlarge,m7a.xlarge,m7a.2xlarge"
```

### Max EBS Volume Size

Set the upper bound on disk sizes that workflows may request via the `disk:` label. Requests that exceed this value are silently capped. If this parameter is not set, no upper bound is enforced.

```bash
aws ssm put-parameter \
  --name /github-aws-runner/max-ebs-volume-size-gb \
  --type String \
  --value "500"
```

### AMI

The webhook Lambda resolves the latest matching AMI at runtime on each cold start. By default it searches for the [RunsOn](https://runs-on.com) runner image:

- Name pattern: `runs-on-v2.*-ubuntu22-full-x64-*`
- Owner account: `135269210855`

To use a different image, set one or both optional SSM parameters:

```bash
# Use a custom AMI name pattern
aws ssm put-parameter \
  --name /github-aws-runner/ami-name \
  --type String \
  --value "my-runner-image-*"

# Use a different owner (your own account, or a share source account)
aws ssm put-parameter \
  --name /github-aws-runner/ami-owners \
  --type String \
  --value "self"
```

Changes take effect on the next Lambda cold start — no redeployment required.

#### Private AMIs

No additional configuration is needed for private AMIs shared with your account (unencrypted, or encrypted with an AWS-managed key). The Lambda role already has `ec2:DescribeImages` and `ec2:RunInstances`.

If the AMI's snapshots are encrypted with a **customer-managed KMS key (CMK)**, EC2 requires the launching principal to create a key grant. Add a policy statement to the webhook Lambda's role granting access to the CMK:

```bash
# Find the role name in the CloudFormation stack resources
aws cloudformation describe-stack-resources \
  --stack-name GithubAwsRunnerStack \
  --query 'StackResources[?ResourceType==`AWS::IAM::Role` && contains(LogicalResourceId, `WebhookFn`)].PhysicalResourceId' \
  --output text

# Attach an inline policy granting the required KMS permissions
aws iam put-role-policy \
  --role-name <webhook-role-name> \
  --policy-name AllowRunnerAmiKmsKey \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["kms:CreateGrant", "kms:Decrypt", "kms:DescribeKey"],
      "Resource": "arn:aws:kms:<region>:<account>:key/<key-id>"
    }]
  }'
```

### Runner Label

By default, any job with the `self-hosted` label triggers a runner. To require an additional label (e.g. `aws`), set the optional parameter:

```bash
aws ssm put-parameter \
  --name /github-aws-runner/runner-label \
  --type String \
  --value "aws"
```

Jobs must then include both labels:

```yaml
runs-on: [self-hosted, aws]
```

Delete the parameter to revert to `self-hosted`-only matching. No redeployment needed.

### API Gateway Throttling

Update the rate and burst parameters, then run `cdk deploy`:

```bash
aws ssm put-parameter \
  --name /github-aws-runner/api-throttle-rate-limit \
  --type String \
  --value "20" \
  --overwrite

aws ssm put-parameter \
  --name /github-aws-runner/api-throttle-burst-limit \
  --type String \
  --value "10" \
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

### IP Updater

The IP updater Lambda runs on a schedule to keep the API Gateway resource policy in sync with GitHub's current webhook IP ranges. If GitHub's IPs change mid-interval and webhooks start failing, you can trigger an immediate refresh without redeploying.

The Lambda function name is available as a CloudFormation stack output (`IpUpdaterFunctionName`). To invoke it immediately:

```bash
aws lambda invoke \
  --function-name $(aws cloudformation describe-stacks \
    --stack-name GithubAwsRunnerStack \
    --query 'Stacks[0].Outputs[?OutputKey==`IpUpdaterFunctionName`].OutputValue' \
    --output text) \
  /dev/null
```

To change the schedule interval, update the SSM parameter and redeploy:

```bash
aws ssm put-parameter \
  --name /github-aws-runner/ip-updater-interval-hours \
  --type String \
  --value "6" \
  --overwrite

cdk deploy
```

## Cost Protection

The following measures are recommended to prevent unexpected cost overruns but are not managed by the CDK stack.

### AWS Budgets

Set up a monthly budget to receive an alert when estimated charges exceed a threshold:

1. Open the [AWS Billing console](https://console.aws.amazon.com/billing/home#/budgets) and choose **Create budget**.
2. Select **Cost budget** and set a monthly amount appropriate for your expected usage.
3. Add an alert at 80% of the budgeted amount with an email or SNS notification.

### AWS Cost Anomaly Detection

Cost Anomaly Detection identifies unusual spending patterns beyond simple threshold alerts:

1. Open the [Cost Anomaly Detection console](https://console.aws.amazon.com/cost-management/home#/anomaly-detection).
2. Create a monitor scoped to the **EC2** service (the primary cost driver for this project).
3. Create an alert subscription with your preferred notification method.

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
