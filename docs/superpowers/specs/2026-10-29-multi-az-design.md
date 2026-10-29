# Multi-AZ Runner Subnets — Design

**Status:** draft · **Date:** 2026-10-29 · **Follows:** PR #15 (Spot instances). This branch (`multi-az`) is stacked on `spot-instances` and its PR targets `main` once #15 merges.

## Intent

The stack launches every runner into one public subnet in one Availability Zone. AWS manages Spot capacity per instance type *per zone*, so a Spot job that is refused in that zone waits, even when another zone in the region has capacity. On-Demand launches have the same problem with `InsufficientInstanceCapacity`. The goal is to let a launch use every AZ in the region, so a refusal in one zone falls through to the next. That cuts Spot waits and On-Demand capacity failures.

Cost is the driver behind Spot, and this change must not add any. Public subnets with no NAT gateway, and runners that talk only to the internet and regional S3, mean extra zones add no data-transfer or hourly charges. Anything zonal in the path would add cross-AZ charges.

## Decisions (the user's)

- **Default to all AZs, automatically.** No opt-in setting. A deployment that pulls this change and redeploys gets subnets in every AZ, and runners start launching in them.
- **Follow-up PR to #15**, not part of it.
- **Failed launches count toward `reconciler-max-top-ups`** (§2a). This is the existing retry-until-TTL bug, fixed in this PR.

## Goals

1. Runners can launch in any standard AZ of the deployment region.
2. A launch refused for a zone-specific reason tries the next zone before it fails or waits.
3. **Upgrading an existing deployment is purely additive.** The existing VPC, subnet, route table, security group and running instances are untouched. No drain is needed, and nothing is replaced.
4. Everything above the launcher behaves as it does in #15, except for one reconciler fix (§2a): the webhook/reconciler wait-and-retry, no On-Demand fallback, the same-type skip.
5. A job whose launch fails permanently stops being retried after `reconciler-max-top-ups` attempts, instead of being retried until the 24-hour TTL.

## Non-goals

- Choosing the zone by Spot price. Zones are tried in turn, not ranked.
- EC2 Fleet / `CreateFleet`, or several instance types per job.
- Local Zones, Wavelength Zones or Outposts.
- A setting to limit or choose AZs.
- Changing the existing VPC or subnet layout.

## Anti-goals

- **Any replacement of an existing resource on upgrade.** Replacing the subnet fails (see below), and replacing the VPC or security group strands running runners.
- Any new hourly or per-GB cost: NAT gateways, interface endpoints, or anything else zonal in the runner's network path.
- A Spot job waiting forever for an instance type no zone offers (see "All zones refuse").

## Why the obvious change doesn't work (verified)

Raising `maxAzs` on the existing `ec2.Vpc` is unsafe. Probing CDK's allocation (with the stack's `10.0.0.0/16` default):

| `maxAzs` | Subnet 1 CIDR |
|---|---|
| 1 (today) | `10.0.0.0/16`, the **entire** VPC range |
| 3 | `10.0.0.0/18` |
| 6 | `10.0.0.0/19` |

The existing subnet fills the whole VPC CIDR, so:
- no new subnet fits in the primary range, and
- any `maxAzs` > 1 changes subnet 1's CIDR. CloudFormation then tries to replace it, and the new subnet overlaps the old one, so the create fails. Even if it didn't, the old subnet can't be deleted while runners are in it.

Pinning `cidrMask: 16` errors at synth, because only one `/16` fits.

## Design

### 1. Stack (`lib/github-aws-runner-stack.ts`, VPC section)

**Leave the `ec2.Vpc` construct exactly as it is** (`maxAzs: 1`, one public subnet). Its logical IDs, CIDR and AZ must not change. Then add:

- **A secondary VPC CIDR block**, `10.1.0.0/16` (`ec2.CfnVPCCidrBlock` on `vpc.vpcId`). A primary in `10.0.0.0/8` allows secondaries only from `10.0.0.0/8`, and `10.1.0.0/16` doesn't overlap the primary.
- **One public subnet per additional AZ** in that block, for every region AZ other than `vpc.availabilityZones[0]`, which subnet 1 already covers.
  - AZ list: `this.availabilityZones`. The stack is environment-aware (`bin/` sets `env` from `CDK_DEFAULT_*`), so CDK looks the AZs up and caches them in `cdk.context.json` (git-ignored).
  - Keep only standard AZs: names matching `^<region>[a-z]$`. This drops any opted-in Local or Wavelength Zones (`us-east-1-bos-1a`).
  - *(My call:)* never fail synth when the filter leaves no extra AZs. Just add no subnets. On its first pass, before the lookup resolves, CDK synthesizes with dummy AZ names and then re-synthesizes with the real ones, so throwing would break every first deploy. Real regions always have at least two standard AZs.
  - *(My call:)* `10.1.0.0/16` is fixed, with no override. The README says it must not overlap anything the VPC is peered or routed to. If it does, the deploy fails cleanly when the CIDR block is created.
  - **CIDR from the AZ letter, not its position**: `/21`, with the block index set by the letter (`a`=0 … `z`=25). The `10.1.0.0/16` block holds 32 `/21`s, and each holds 2,043 usable addresses. Deriving the CIDR and the construct ID from the letter means a zone that AWS adds later, or a different deploy machine's AZ list, only adds subnets and never shifts existing ones.
  - Each subnet has `mapPublicIpOnLaunch: true`, a route table, and a default route (`0.0.0.0/0`) to the VPC's existing internet gateway (`vpc.internetGatewayId`; `ec2.PublicSubnet` + `addDefaultInternetRoute` fits). Each subnet depends on the CIDR-block resource.
- **Lambda environment**: replace `SUBNET_ID` with `SUBNET_IDS`, a comma-separated list on the webhook and reconciler. Subnet 1 comes first, then the new subnets in AZ-letter order.
- **No IAM change.** The `RunInstances` statements already allow `subnet/*`, and the security group applies to the whole VPC.

### 2. Launcher (`lambda/shared/launcher.ts`, `launchRunner`)

Mint the JIT config **once**, then try `RunInstances` across the subnets. A JIT config is not consumed until an instance boots, so the same one is reused for every attempt.

- **Order:** start at a random subnet, then go round-robin through the rest, each subnet tried at most once. A random start spreads load across zones without shared state.
- **Zonal refusals → try the next subnet:** `InsufficientInstanceCapacity`, `UnfulfillableCapacity`, `SpotMaxPriceTooLow`, `Unsupported` (the instance type isn't offered in that zone). These apply to both markets. *(My call:)* this is a new code set next to `CAPACITY_ERROR_CODES` in `spot.ts`. `isSpotCapacityError` and its codes stay as they are. `Unsupported` can also come from non-zonal causes, such as an AMI architecture mismatch. Trying every zone in that case wastes a few fast calls and then fails as it does today, which is acceptable.
- **Regional or other errors → stop now**, with no further subnets. This covers `MaxSpotInstanceCountExceeded` (a regional quota, so another zone won't help), `VcpuLimitExceeded`, auth errors, bad parameters, and anything else.
- **Log each refusal** with the subnet/AZ and the error code. Every attempt sends the same tags, user data and market options.

**What `launchRunner` throws:**

| Market | Outcome | Throws | JIT runner |
|---|---|---|---|
| Spot | Stopped on `MaxSpotInstanceCountExceeded` | `SpotCapacityError` | deleted (as in #15) |
| Spot | All zones refused, at least one with a capacity code | `SpotCapacityError` | deleted |
| Spot | All zones refused with `Unsupported` only | the last error, as-is | left for prune (as #15 does for non-capacity errors) |
| On-Demand | All zones refused | the last error, as-is | left for prune |
| Either | Stopped on any other error | that error | left for prune |

"The last error" means the last zonal refusal received. When codes are mixed, the table above decides: any capacity code makes a Spot launch throw `SpotCapacityError`.

**All zones refuse with `Unsupported`:** if no zone offers the type, waiting can never succeed, so the launcher does not report it as a Spot wait. It throws the raw error, which callers handle like any other failed launch. That ends it after `reconciler-max-top-ups` failed attempts (see §2a).

Webhook code doesn't change. The webhook and the reconciler each still see one `launchRunner` call that either returns an instance ID, throws `SpotCapacityError`, or throws something else.

### 2a. Reconciler: failed launches count as top-ups (`lambda/reconciler/index.ts`)

**The user's decision.** This fixes a bug that exists today. When a launch fails with anything other than `SpotCapacityError`, the reconciler logs it and `continue`s, skipping the `topUps` increment. A launch that always fails is therefore retried on every pass until the 24-hour TTL. Each retry mints a JIT registration that prune later removes. Multi-AZ makes this more visible: the all-`Unsupported` case lands here.

- After a non-`SpotCapacityError` failure, increment `topUps` the same way a successful launch does: the same conditional `UpdateItem`, with errors handled the same way. Then move on to the next job.
- A `SpotCapacityError` still does **not** count, as in #15. A Spot wait is not a failure.
- The `launched` counter still counts only successful launches.
- Once `topUps` reaches `reconciler-max-top-ups` (default 3), the planner stops selecting the job, exactly as it does for runners that never come online. The job stays queued in GitHub until it is cancelled or the row's TTL expires.
- Accepted cost: three transient failures in a row, such as API throttling, also exhaust the job's top-ups. The cap already accepts this risk for runners that never come online.
- Keep the increment out of the launch `try/catch`, as it is today, so a bookkeeping failure is never reported as a failed launch. A small helper shared by both paths fits.

**Call budget** *(my call: no new limits)*. A refused `RunInstances` returns quickly, so even a 6-AZ region adds a few seconds at most.
- The webhook's 30-second timeout covers this, though it does lengthen the webhook response.
- In the reconciler, an On-Demand launch that is refused in every zone still consumes its slot. A pass therefore makes at most `free capacity × zones` calls.
- On-Demand has no same-type skip, unlike Spot. Adding one is out of scope.

### 3. Tests

- **Stack** (`test/github-aws-runner.test.ts`): the test stack is environment-aware (`us-east-1`, account `123456789012`). Without context, CDK returns dummy AZ names, which the `^<region>[a-z]$` filter drops. `buildTemplate` must therefore set `availability-zones:account=123456789012:region=us-east-1` context to a list of real-looking names, for example `us-east-1a` through `us-east-1c`. It should include one non-standard name such as `us-east-1-bos-1a` to show the filter works.
  - Subnet count goes from 1 to the expected number.
  - The secondary CIDR block exists.
  - Subnet 1 keeps `10.0.0.0/16` and its logical ID. This guards the upgrade path.
  - Each new subnet has a default route to the internet gateway.
  - `SUBNET_IDS` is set on both Lambdas.
- **Launcher** (`test/launcher.test.ts`):
  - A zonal refusal tries the next subnet, and success there returns that instance.
  - `Unsupported` also moves on.
  - `MaxSpotInstanceCountExceeded` and a non-capacity error stop after one call.
  - Spot with every zone refused throws `SpotCapacityError` and deletes the JIT runner exactly once.
  - Spot with `Unsupported` everywhere throws the raw error.
  - On-Demand with every zone refused throws the raw error.
  - Each subnet is tried at most once.
  - The JIT config is minted once.
  - The random start is injectable or seeded so tests are deterministic.
- **Reconciler** (`test/reconciler.test.ts`):
  - A non-Spot launch failure increments `topUps` and doesn't count as launched.
  - A `SpotCapacityError` still doesn't increment `topUps`.
  - A row that has already been deleted (`ConditionalCheckFailedException`) after a failure is silent.
  - A failing increment after a failed launch is logged and doesn't stop the pass.

### 4. Docs

- **README:**
  - Replace the "Single Availability Zone" paragraph in the Spot section with a short explanation of trying each zone in turn.
  - Note the upgrade: a redeploy adds a `10.1.0.0/16` secondary CIDR and one subnet per extra AZ. Existing resources are unchanged, and no drain is needed.
  - Note the cost: no charges are added, as long as nothing zonal is put in the runner path.
- **README / CLAUDE.md:** wherever `reconciler-max-top-ups` is described, say that failed launches count too, and Spot capacity waits don't.
- **CLAUDE.md:** describe the VPC layout (primary subnet, plus secondary-CIDR subnets keyed by AZ letter), `SUBNET_IDS`, and the launcher's zone loop. Update stack-structure item 3.

## Upgrade / backward compatibility

A redeploy creates the CIDR block, subnets, route tables, routes and associations, and changes two Lambda environment variables. It replaces or deletes nothing, so runners in flight are unaffected. A rollback deletes only the new resources. That would fail for any subnet that still holds a runner, but the existing deployment keeps working, because CloudFormation retries the cleanup.

Runtime behaviour changes for upgraded deployments, by the user's decision:
- Runners can land in any AZ.
- An On-Demand capacity refusal now tries other zones before failing.
- A job whose launches keep failing stops being retried after `reconciler-max-top-ups` attempts.

## Left to the builder

- Exact construct IDs, as long as they come from the AZ letter.
- How to make the random start testable: an injectable `random` or a small helper.
- Log wording.
- Whether `SUBNET_IDS` parsing lives in the launcher or a tiny helper.
