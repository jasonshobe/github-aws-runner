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
  ├── Records the queued job in DynamoDB (cleared when the job starts/finishes)
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

Scheduled: every N minutes (configurable via SSM, default 2)
  Reconciler Lambda
  ├── Launches runners for queued jobs left without capacity
  └── Deregisters runners whose instance never came online

CDK deploy/destroy
  Webhook Registration Lambda
  └── Registers / deregisters the GitHub webhook

CDK deploy/destroy (when cache-bucket SSM param is set)
  Cache Bucket Lambda
  └── Creates S3 cache bucket and applies lifecycle policy

CDK deploy/destroy (when oidc-role-policy-arn and oidc-subject-pattern are set)
  OIDC Lambda
  └── Sets / deletes AWS_ROLE_ARN Actions variable in GitHub
```

## Prerequisites

- [Node.js](https://nodejs.org/) 22.x or later
- [AWS CLI](https://aws.amazon.com/cli/) configured with credentials for your target account
- A GitHub personal access token with the required scopes (see below)

## SSM Parameters

All configuration is stored in AWS Systems Manager Parameter Store. You must create the required parameters before deploying.

The `/github-aws-runner` prefix used in all parameter names is the default. It can be changed by setting the `ssmPrefix` CDK context variable (see [Deployment](#deployment)).

### Required parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `/github-aws-runner/github-token` | SecureString | GitHub personal access token (see [GitHub Token Permissions](#github-token-permissions)) |
| `/github-aws-runner/webhook-secret` | SecureString | Shared secret for HMAC webhook signature validation |
| `/github-aws-runner/target-type` | String | `repo` or `org` |
| `/github-aws-runner/target-slug` | String | `owner/repo` (for repo) or `myorg` (for org) |
| `/github-aws-runner/runner-timeout-minutes` | String | Max runtime per runner in minutes (e.g. `60`) |
| `/github-aws-runner/instance-type` | String | EC2 instance type for runners (e.g. `c7a.large`) |
| `/github-aws-runner/ebs-volume-size-gb` | String | Root EBS volume size in GB (e.g. `80`) |
| `/github-aws-runner/max-concurrent-runners` | String | Max simultaneous runner EC2 instances (e.g. `10`) |
| `/github-aws-runner/api-throttle-rate-limit` | String | API Gateway steady-state requests per second (e.g. `10`) |
| `/github-aws-runner/api-throttle-burst-limit` | String | API Gateway burst request limit (e.g. `5`) |

### Optional parameters

These parameters do not need to exist in SSM unless you want to override the documented default behavior.

| Parameter | Type | Description |
|-----------|------|-------------|
| `/github-aws-runner/runner-label` | String | Additional label required on jobs beyond `self-hosted` |
| `/github-aws-runner/allowed-instance-types` | String | Comma-separated list of instance types workflows may request via label |
| `/github-aws-runner/max-ebs-volume-size-gb` | String | Upper bound on the EBS volume size workflows may request in GB |
| `/github-aws-runner/ip-updater-interval-hours` | String | IP updater schedule in hours (default: `12`); if omitted, deploy uses `12`; requires `npx cdk deploy` to take effect |
| `/github-aws-runner/reconciler-interval-minutes` | String | Reconciler schedule in minutes (default: `2`); requires `npx cdk deploy` to take effect |
| `/github-aws-runner/reconciler-grace-seconds` | String | How long a job may sit queued before the reconciler launches extra capacity for it (default: `180`) |
| `/github-aws-runner/reconciler-boot-grace-seconds` | String | How long an instance may run before its runner must be `online` with GitHub for it to still count as capacity (default: `300`) |
| `/github-aws-runner/reconciler-max-top-ups` | String | Maximum replacement runners the reconciler will launch for a single job (default: `3`) |
| `/github-aws-runner/spot-enabled` | String | Whether jobs may run on Spot instances (default: `true`); `false` forbids Spot. See [Spot Instances](#spot-instances) |
| `/github-aws-runner/spot-required` | String | Whether every job must run on Spot (default: `false`); ignored when `spot-enabled` is `false`. See [Spot Instances](#spot-instances) |
| `/github-aws-runner/ami-name` | String | AMI name pattern (default: `runs-on-v2.*-ubuntu22-full-x64-*`) |
| `/github-aws-runner/ami-owners` | String | Comma-separated AMI owner account IDs (default: `135269210855`) |
| `/github-aws-runner/cache-bucket` | String | Name of the S3 bucket to create for runner caching; if set, the bucket is created and managed by the stack |
| `/github-aws-runner/cache-expiration-days` | String | Days after which cached objects are deleted (default: `10`; only used when `cache-bucket` is set) |
| `/github-aws-runner/oidc-role-policy-arn` | String | ARN of an existing managed IAM policy to attach to the OIDC role; setting this (along with `oidc-subject-pattern`) enables OIDC |
| `/github-aws-runner/oidc-subject-pattern` | String | IAM trust policy subject claim pattern or JSON array of patterns; required when `oidc-role-policy-arn` is set. Legacy example: `repo:myorg/*:*`; immutable example: `repo:myorg@123456/*:*`. See [OIDC Authentication](#oidc-authentication) for mixed-format and exact-subject examples |

### GitHub Token Permissions

The personal access token stored in `/github-aws-runner/github-token` must have:

| Target | Required scopes |
|--------|----------------|
| Repository runners | `administration: write` (fine-grained) or `repo` (classic) |
| Organization runners | `organization_self_hosted_runners: write` (fine-grained) or `admin:org` (classic) |

These scopes cover generating JIT runner configs as well as listing and deleting runner registrations, which the reconciler needs.
| Webhook management | `admin:repo_hook` (repo) or `admin:org_hook` (org) |
| OIDC variable management | `Variables` read/write (fine-grained) or `repo` / `admin:org` (classic, already required above) |

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
```

## Deployment

1. Install dependencies:

   ```bash
   npm install
   ```

2. Bootstrap CDK (first-time only per account/region):

   ```bash
   npx cdk bootstrap
   ```

3. Deploy:

   ```bash
   npx cdk deploy
   ```

   To use a custom SSM parameter prefix instead of `/github-aws-runner`, pass the `ssmPrefix` context variable. All SSM parameters must be created under the same prefix.

   ```bash
   npx cdk deploy --context ssmPrefix=/my-runner
   ```

   The stack will:
   - Fetch current GitHub webhook IP ranges and apply them to the API resource policy
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

### Spot Runners

Add a `spot:true` label to run a job on an EC2 Spot instance, which costs less than On-Demand. Add `spot:false` to guarantee a job runs On-Demand:

```yaml
jobs:
  quick-test:
    # Short, cost-sensitive job: run on Spot
    runs-on: [self-hosted, spot:true]
    steps:
      - uses: actions/checkout@v4
      - run: npm test

  release:
    # Long or must-not-be-interrupted job: never on Spot
    runs-on: [self-hosted, spot:false]
    steps:
      - uses: actions/checkout@v4
      - run: ./release.sh
```

Spot is meant for short, cost-sensitive jobs (roughly 30 minutes or less). AWS can reclaim a Spot instance at any time; when that happens mid-job, GitHub marks the job failed and it stays failed until someone re-runs it by hand. There is no automatic re-run. Jobs that are long, or that cannot tolerate an interruption, should stay On-Demand.

GitHub gives a job to any online runner whose labels include all of the job's `runs-on` labels, and a runner may carry extra labels. A Spot runner registers with `self-hosted`, `linux`, `x64` plus its job's labels, including `spot:true`. So a Spot runner launched for a `[self-hosted, spot:true]` job can be handed an older `[self-hosted]` job that happens to be queued at the same time, and that job then runs at interruption risk. The same thing already happens with `instance-type:` runners, where it only costs money. Putting `spot:false` on a job prevents it: no Spot runner ever carries `spot:false`, so GitHub can never match that job to one. The reverse cannot happen, because an On-Demand runner never carries `spot:true`. This only arises when `spot-required` is off and jobs with overlapping labels are queued at once.

### Caching

Because each runner is a fresh EC2 instance, `actions/cache` will not have access to GitHub's hosted cache. Replace it with [`runs-on/cache`](https://github.com/marketplace/actions/fast-actions-cache-for-s3), which stores cache entries in an S3 bucket. It is a drop-in replacement that accepts the same inputs as `actions/cache`.

No explicit AWS credential setup is required in your workflow. Each runner is an EC2 instance with an IAM instance profile, so the AWS SDK credential provider chain automatically uses the instance role — the same role that is granted access to the cache bucket.

If you set the `/github-aws-runner/cache-bucket` SSM parameter, the stack creates the S3 bucket, grants the runner instances access, and automatically injects `RUNS_ON_S3_BUCKET_CACHE` into every runner's environment. The only change needed in a workflow is replacing `actions/cache` with `runs-on/cache`:

```yaml
jobs:
  build:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v4

      - uses: runs-on/cache@v4
        with:
          path: ~/.npm
          key: ${{ runner.os }}-npm-${{ hashFiles('**/package-lock.json') }}
          restore-keys: |
            ${{ runner.os }}-npm-
```

If you prefer to manage the bucket yourself, omit the SSM parameter and set `RUNS_ON_S3_BUCKET_CACHE` in your workflow or as a repository/organization Actions variable instead. In that case you will need to grant the EC2 instance role `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` (on `bucket/*`), and `s3:ListBucket` (on `bucket`) separately.

## Configuration

Most SSM parameters take effect immediately without redeploying the stack. The following require an `npx cdk deploy` because they are resolved at synth time:

- **max-concurrent-runners** — also controls Lambda reserved concurrency
- **api-throttle-rate-limit** and **api-throttle-burst-limit** — control API Gateway stage throttling
- **ip-updater-interval-hours** — controls the EventBridge schedule rate for the IP updater
- **reconciler-interval-minutes** — controls the EventBridge schedule rate for the reconciler

### Runner Capacity Reconciliation

Every runner this stack creates is registered with `self-hosted`, `linux`, `x64` plus the labels of the job that triggered it, and GitHub hands a job to any online runner whose labels include all of the job's `runs-on` labels. In practice the runners are interchangeable: when a runner comes online GitHub gives it the **oldest** matching queued job in your org or repo — not necessarily the job whose webhook launched it. The `aws-runner-<job id>` name is only a label for humans.

That means launching one instance per `workflow_job.queued` webhook is not enough on its own. If an instance ever fails to bring its runner online, or is reaped while idle, the queue is left permanently one runner short: from then on each new runner picks up an older backlog job and the newest job sits in `queued` until someone cancels it. Busy repositories hide this as "jobs are just slow to start"; a repository that queues jobs infrequently sees them never start at all.

The reconciler closes that gap. The webhook records each queued job in a DynamoDB table and removes it when GitHub reports the job started or finished. Every `reconciler-interval-minutes` the reconciler compares jobs that have waited longer than `reconciler-grace-seconds` against the runner capacity actually in flight, launches whatever is missing (never exceeding `max-concurrent-runners`), and deregisters runners whose instance no longer exists and which therefore can never come online.

An instance only counts as capacity while it can still plausibly take a job. Once it has been running longer than `reconciler-boot-grace-seconds`, its runner must actually be `online` with GitHub — an instance whose runner never registered can never be handed work, and counting it would stall the backlog until the watchdog timed the instance out an hour later. Such instances are left for the watchdog to retire rather than terminated outright, so a transient GitHub API blip can never kill a runner that is midway through a job.

`reconciler-max-top-ups` bounds how many replacements a single job can consume. If every replacement also fails to come online — which is what a GitHub-side outage looks like from here — the reconciler stops after that many and logs a warning rather than filling your concurrency budget with useless instances. A launch that fails (other than a Spot capacity wait, which is not counted) also uses up one of the job's top-ups.

To see what it is doing:

```bash
aws logs tail /aws/lambda/<stack>-ReconcilerFn<suffix> --follow
```

A healthy idle log line reads `Reconciler: runner supply covers the backlog, nothing to launch`.

### Spot Instances

Whether a job runs on Spot is decided per job by its `spot:true` / `spot:false` label (see [Spot Runners](#spot-runners)). Two optional SSM parameters let an organization enforce a policy. Both accept `true` or `false` (case-insensitive); a missing parameter uses the default, and an unparseable value logs a warning and uses the default.

| Policy | `spot-enabled` | `spot-required` |
|---|---|---|
| Per-job choice (the default) | `true` | `false` |
| Every runner must be Spot | `true` | `true` |
| Spot is forbidden | `false` | (ignored) |

```bash
# Require Spot for every job
aws ssm put-parameter \
  --name /github-aws-runner/spot-required \
  --type String \
  --value "true"

# Or forbid Spot entirely
aws ssm put-parameter \
  --name /github-aws-runner/spot-enabled \
  --type String \
  --value "false"
```

If `spot-enabled` is `false` and `spot-required` is `true`, disabled wins and a warning is logged. Label matching is case-insensitive, so `spot:TRUE` works. Any other `spot:` value logs a warning and is treated as if the label were absent.

What happens to a job, as decided by the webhook when it is queued:

| `spot-enabled` | `spot-required` | Job label | Result |
|---|---|---|---|
| true | false | none | On-Demand |
| true | false | `spot:true` | Spot |
| true | false | `spot:false` | On-Demand |
| true | true | none | Spot |
| true | true | `spot:true` | Spot |
| true | true | `spot:false` | Not launched |
| false | any | none | On-Demand |
| false | any | `spot:false` | On-Demand |
| false | any | `spot:true` | Not launched |

A job carrying both `spot:true` and `spot:false` is also not launched. **Not launched** means the webhook logs a message naming the job and the conflict, records nothing in the queued-jobs table, and returns 200, so the reconciler never retries it. The job stays `queued` on GitHub until GitHub drops it, the same as a job missing the configured `runner-label`.

**No On-Demand fallback.** A job that asks for Spot, or runs where Spot is required, only ever runs on Spot. If AWS refuses a Spot launch for capacity or quota reasons (`InsufficientInstanceCapacity`, `MaxSpotInstanceCountExceeded`, `SpotMaxPriceTooLow` or `UnfulfillableCapacity`), the job waits: the webhook logs a warning and returns 200, and the reconciler retries on every run until Spot capacity returns, the job starts, GitHub drops it, or its queued-jobs row expires 24 hours after the job was queued (`ROW_TTL_SECONDS` in `lambda/webhook/index.ts`). Nothing is silently launched On-Demand. The runner registration minted for the refused launch is deleted straight away. A refused Spot launch uses no capacity, so it does not take a slot under `max-concurrent-runners` for that reconciler run and does not stall other jobs queued behind it. It also does not count toward `reconciler-max-top-ups`. A Spot instance that is reclaimed before its runner takes a job does count, because it was a successful launch.

The reconciler re-checks policy before every top-up using the market stored on the job's row. If the settings have changed so the stored choice now conflicts (a Spot job after Spot is disabled, or an On-Demand job after Spot becomes required), it logs the reason, does not launch, and deletes the row. It never converts a job from one market to the other. Rows written before Spot support carry no market and are treated as On-Demand.

Spot launches are one-time requests with no maximum price, so AWS caps the price at the On-Demand price. Instance type, disk and timeout labels work as usual, and `allowed-instance-types` applies to Spot too. Spot instances count toward `max-concurrent-runners`, and each instance is tagged `github-aws-runner:market` as `spot` or `on-demand`.

**Multiple Availability Zones.** The stack has a public runner subnet in every standard Availability Zone of the region (Local Zones and Wavelength Zones are excluded). AWS manages Spot capacity per instance type *per zone*, so each launch starts at a random zone's subnet and tries every zone in turn until one accepts. A zonal refusal (`InsufficientInstanceCapacity`, `UnfulfillableCapacity`, `SpotMaxPriceTooLow` or `Unsupported`) moves on to the next zone. `MaxSpotInstanceCountExceeded` is an account-wide quota, so it, and any other error, stops the attempt immediately. Only when every zone refuses a Spot launch, with at least one refusal being a capacity code, does the job wait as described above. When jobs still often wait for Spot capacity, try listing several comparable types in `allowed-instance-types` and spreading Spot workflows across them.

**Network upgrade note:** the original subnet keeps the VPC's `10.0.0.0/16` range. A redeploy adds a `10.1.0.0/16` secondary CIDR to the VPC and one `/21` public subnet per extra standard Availability Zone. Existing resources are unchanged and running instances are unaffected, so no drain is needed. `10.1.0.0/16` must not overlap any network the VPC is peered or routed to. The extra subnets cost nothing, provided you do not put anything zonal (a NAT gateway or an interface endpoint) in the runner path.

Both parameters are read at runtime, so no redeploy is needed. The webhook caches parameters on each warm Lambda instance, as it does every other runtime parameter, so a change takes effect as each Lambda picks it up. The stack grants the launching Lambdas permission to create the EC2 Spot service-linked role, so the first Spot launch in a fresh account works without manual setup.

**Upgrade note:** a workflow that already uses a custom runner label spelled `spot:true` or `spot:false` gains the meaning described here.

### Runner Timeout

Update the `/github-aws-runner/runner-timeout-minutes` parameter:

```bash
aws ssm put-parameter \
  --name /github-aws-runner/runner-timeout-minutes \
  --type String \
  --value "120" \
  --overwrite
```

### EC2 Instance Type

Update the `/github-aws-runner/instance-type` parameter:

```bash
aws ssm put-parameter \
  --name /github-aws-runner/instance-type \
  --type String \
  --value "m7a.xlarge" \
  --overwrite
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

Before starting the runner, instance user data grows the root partition and filesystem to use the requested EBS volume size (`disk:` label or `ebs-volume-size-gb` default). This works even when the AMI disables cloud-init's automatic resizing, and is safe when the root partition or filesystem is already expanded.

Custom AMIs must use an ext4 or XFS root filesystem on a disk or standard partition, with `findmnt`, `lsblk`, `readlink`, `growpart` (for partitioned roots), and the matching filesystem tool (`resize2fs` or `xfs_growfs`) installed. Bootstrap logs errors to `/var/log/github-aws-runner-user-data.log` and shuts down the instance if resizing fails or the root layout is unsupported (for example, LVM).

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

If the AMI's snapshots are encrypted with a **customer-managed KMS key (CMK)**, EC2 requires the launching principal to create a key grant. Add a policy statement to the webhook Lambda's role granting access to the CMK. The Reconciler Lambda also launches instances, so its role needs the same permissions (repeat the command below for its role, whose logical ID contains `ReconcilerFn`):

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

For **Spot** runners, the `AWSServiceRoleForEC2Spot` service-linked role also needs a grant on the CMK when the AMI or its EBS snapshots are encrypted with it. Without one the Spot launch fails with an error that is not a capacity error, so it is not retried as one.

The service-linked role normally appears on the first Spot launch, but that launch fails without the grant, so create the role yourself first. If it already exists, the command reports an error and you can skip it:

```bash
aws iam create-service-linked-role --aws-service-name spot.amazonaws.com
```

Then create the grant once per key:

```bash
aws kms create-grant \
  --key-id <key-id> \
  --grantee-principal arn:aws:iam::<account>:role/aws-service-role/spot.amazonaws.com/AWSServiceRoleForEC2Spot \
  --operations Decrypt GenerateDataKeyWithoutPlaintext ReEncryptFrom ReEncryptTo CreateGrant DescribeKey
```

### Cache Bucket

Set the `/github-aws-runner/cache-bucket` parameter to have the stack create and manage an S3 bucket for use with [`runs-on/cache`](https://github.com/marketplace/actions/fast-actions-cache-for-s3):

```bash
aws ssm put-parameter \
  --name /github-aws-runner/cache-bucket \
  --type String \
  --value "my-runner-cache-bucket"
```

Then run `npx cdk deploy`. The stack will create the bucket if it does not already exist, apply a lifecycle policy, grant the runner EC2 instances access, and automatically inject the bucket name into every runner's environment. If the bucket already exists in your account it will be adopted and the lifecycle policy applied to it.

The default expiration is 10 days. To use a different value:

```bash
aws ssm put-parameter \
  --name /github-aws-runner/cache-expiration-days \
  --type String \
  --value "7"
```

Both parameters require `npx cdk deploy` to take effect. Removing the `cache-bucket` parameter and redeploying will remove the stack's management of the bucket but the bucket itself is retained.

### OIDC Authentication

When both `oidc-role-policy-arn` and `oidc-subject-pattern` are set, the stack creates the AWS resources for GitHub Actions OIDC authentication and configures an `AWS_ROLE_ARN` Actions variable in your repository or organization so workflows can assume the role without long-lived credentials.

**Step 1 — Create the IAM policy** with the permissions your workflows need (e.g. CodeArtifact, ECR, additional S3 buckets). The stack attaches this policy to the OIDC role; cache bucket access is already granted separately to the EC2 runner role.

**Step 2 — Set the SSM parameters** and deploy:

```bash
# ARN of the managed policy to attach to the OIDC role
aws ssm put-parameter \
  --name /github-aws-runner/oidc-role-policy-arn \
  --type String \
  --value "arn:aws:iam::123456789012:policy/MyWorkflowPolicy"

# Subject claim pattern — restricts which repos/branches can assume the role.
# For all repos in an org using legacy subject claims:
aws ssm put-parameter \
  --name /github-aws-runner/oidc-subject-pattern \
  --type String \
  --value "repo:myorg/*:*"

# Or restrict to a specific repository:
aws ssm put-parameter \
  --name /github-aws-runner/oidc-subject-pattern \
  --type String \
  --value "repo:myorg/myrepo:*"

npx cdk deploy
```

After deployment, the `OidcRoleArn` stack output shows the role ARN and an `AWS_ROLE_ARN` Actions variable is set in your repository or organization.

**Immutable subject claims and mixed repositories.** GitHub's [immutable subject format](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims) includes numeric owner and repository IDs, for example `repo:myorg@123456/myrepo@456789:ref:refs/heads/main`. The legacy pattern `repo:myorg/*:*` does not match this format. Check the repository's configuration to find its `use_immutable_subject` setting and `sub_claim_prefix`:

```bash
gh api /repos/myorg/myrepo/actions/oidc/customization/sub
```

To trust both formats, store a JSON array in the existing **String** parameter. IAM allows a subject matching any entry; each entry retains its own repository, branch, or environment restrictions. Use the actual numeric owner ID from GitHub:

```bash
aws ssm put-parameter \
  --name /github-aws-runner/oidc-subject-pattern \
  --type String \
  --overwrite \
  --value '["repo:myorg/*:*","repo:myorg@123456/*:*"]'
```

Existing single values are used verbatim, including exact subjects with immutable IDs. No migration is needed for deployments already using a specific subject to work around this issue. For example, to allow only the `main` branch in one repository, without wildcards:

```bash
aws ssm put-parameter \
  --name /github-aws-runner/oidc-subject-pattern \
  --type String \
  --overwrite \
  --value 'repo:myorg@123456/myrepo@456789:ref:refs/heads/main'
```

The stack does not expand patterns or discover GitHub subjects automatically. Arrays must be valid JSON with at least one non-empty string; malformed arrays fail synthesis. After changing this parameter, refresh its cached SSM lookup with `npx cdk context --reset '<lookup-key>'` (find the matching key with `npx cdk context`), then run `npx cdk diff` and `npx cdk deploy`.

**Step 3 — Update workflows** to request an OIDC token and call `aws-actions/configure-aws-credentials`:

```yaml
permissions:
  id-token: write   # required to request an OIDC token
  contents: read

steps:
  - uses: actions/checkout@v4

  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: ${{ vars.AWS_ROLE_ARN }}
      aws-region: <region>

  # subsequent steps can now call AWS APIs using the assumed role
  - uses: aws-actions/amazon-ecr-login@v2
```

The `id-token: write` permission must be declared in the workflow — it cannot be set programmatically.

> **Note:** AWS IAM allows only one OIDC provider per URL per account. If another CloudFormation stack in the same account already manages the `https://token.actions.githubusercontent.com` provider, importing it is required. Replace the `new iam.OpenIdConnectProvider(...)` call in `lib/github-aws-runner-stack.ts` with `iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, "GithubOidcProvider", "<existing-arn>")`.

### Max Concurrent Runners

Update the `/github-aws-runner/max-concurrent-runners` parameter, then run `npx cdk deploy`:

```bash
aws ssm put-parameter \
  --name /github-aws-runner/max-concurrent-runners \
  --type String \
  --value "10" \
  --overwrite

npx cdk deploy
```

### API Gateway Throttling

Update the rate and burst parameters, then run `npx cdk deploy`:

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

npx cdk deploy
```

### IP Updater

The IP updater Lambda runs on a schedule to keep the API Gateway resource policy in sync with GitHub's current webhook IP ranges. If GitHub's IPs change mid-interval and webhooks start failing, you can trigger an immediate refresh without redeploying.

Each refresh updates the resource policy and creates an API Gateway deployment for the webhook stage so the new ranges take effect. Update or deployment failures fail the invocation and appear in the Lambda `Errors` metric; check the function's CloudWatch logs for details.

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

npx cdk deploy
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

### Spot Instances

Spot never falls back to On-Demand, so a Spot shortage cannot raise your bill unexpectedly: jobs wait for Spot capacity instead. Check your account's Spot vCPU quota in Service Quotas ("All Standard Spot Instance Requests"). A low quota is reported by AWS as `MaxSpotInstanceCountExceeded`, which looks the same as a permanent capacity shortage, and Spot jobs will wait until you raise it, up to 24 hours after the job was queued (the queued-jobs row expires then, `ROW_TTL_SECONDS` in `lambda/webhook/index.ts`) or until GitHub drops the job.

## Teardown

```bash
npx cdk destroy
```

This will delete all AWS resources and deregister the GitHub webhook.

## Development

```bash
# Type-check
npx tsc --noEmit

# Run tests
npm test

# Synthesize CloudFormation template (requires AWS credentials for context lookups)
npx cdk synth
```

## License

[MIT](LICENSE)
