# Spot Instance Runners — Design

Date: 2026-10-29

## Intent

Let a workflow job choose to run on an EC2 Spot instance instead of On-Demand.
The only reason to do this is **cost**. Short jobs (roughly 30 minutes or less) can live with an occasional Spot interruption in exchange for the discount. Long jobs (an hour or more) usually can't afford the delay or restart, and stay On-Demand.

Spot is a **per-job choice made with a `runs-on` label**, like `instance-type:`, `disk:` and `timeout:` today. It is not a global switch. Two org-wide SSM settings exist only to enforce an organization's policy.

This is a public open-source project, so the settings must cover a range of org policies, not only the maintainer's:

| Policy | `spot-enabled` | `spot-required` |
|---|---|---|
| Per-job choice (the default, and the maintainer's own use) | `true` | `false` |
| Every runner must be Spot | `true` | `true` |
| Spot is forbidden | `false` | (ignored) |

## Goals

- `spot:true` on a job launches its runner as a Spot instance.
- `spot:false` on a job launches its runner On-Demand and guarantees that GitHub never hands the job to a Spot runner (see "Label matching" below).
- Org-wide `spot-enabled` / `spot-required` settings, read at runtime, so changing them needs no redeploy.
- Spot capacity shortages are handled by **waiting and retrying Spot**, using the existing reconciler.

## Anti-goals (a failure even if it technically works)

- **Never fall back from Spot to On-Demand.** If a job asked for Spot, or Spot is required, Spot is a *must*. Quietly launching On-Demand is an unexpected, unconfigured cost increase.
- **Never put a job on Spot if its label or the org policy forbids it.**
- Never let a long Spot capacity shortage silently stop the retries.

## Backward compatibility (required)

A deployment that upgrades and redeploys without setting any new parameter must behave exactly as before. That holds because Spot is enabled and not required by default, jobs without a `spot:` label run On-Demand, and a queued-jobs row without a stored Spot/On-Demand choice means On-Demand. Every new code path (capacity-refusal handling, deleting leftover runner registrations, letting a newer job take a refused Spot launch's slot) runs only for Spot launches. The new IAM permissions and instance tag add things without changing behavior. The one theoretical change: a workflow already using a custom runner label spelled `spot:true` or `spot:false` gains the new meaning. Call that out in the release notes.

## Non-goals

- Automatic re-runs after a Spot interruption. If AWS reclaims an instance mid-job, GitHub marks the job failed, and **it stays failed** for a person to re-run by hand. A manual re-run arrives as a new `queued` event and is handled normally.
- Handling the two-minute interruption notice (draining, checkpointing, notifying).
- Spot price caps, Spot Fleet / EC2 Fleet, capacity-optimized multi-type requests, or falling back to a different instance type.
- Any change to the watchdog.

## Behavior

### Labels

| Job label | Meaning |
|---|---|
| `spot:true` | Run on Spot. |
| `spot:false` | Run On-Demand, and never on a Spot runner. |
| neither | On-Demand, unless `spot-required` is on, in which case Spot. |
| `spot:<anything else>` | Log a warning and treat it as if neither label were present. This matches how an invalid `disk:` or `timeout:` value falls back to the default today. |

Value matching is case-insensitive (`spot:TRUE` works). That's my call. If a job somehow carries both `spot:true` and `spot:false`, treat it as a conflict: log it and don't launch. That's also my call.

### Org-wide settings (SSM, read at runtime)

- `<prefix>/spot-enabled`: optional, default `true`.
- `<prefix>/spot-required`: optional, default `false`.

Both accept `true`/`false` (case-insensitive). A missing parameter means the default. An unparseable value logs a warning and uses the default (my call). If `spot-enabled=false` and `spot-required=true`, **disabled wins** and a warning is logged, so a contradictory config never blocks every job.

### Decision table (webhook, on `workflow_job.queued`)

| `spot-enabled` | `spot-required` | Job label | Result |
|---|---|---|---|
| true | false | none | On-Demand |
| true | false | `spot:true` | Spot |
| true | false | `spot:false` | On-Demand |
| true | true | none | Spot |
| true | true | `spot:true` | Spot |
| true | true | `spot:false` | **Don't launch.** Log why. |
| false | any | none | On-Demand |
| false | any | `spot:false` | On-Demand |
| false | any | `spot:true` | **Don't launch.** Log why. |

**"Don't launch"** means: log a clear message naming the job, the label, and the setting it conflicts with; **don't write a queued-jobs row** (so the reconciler never retries it); and return 200. This is how a job missing the configured `runner-label` is handled today. The job sits in `queued` on GitHub until GitHub drops it.

This decision should be a **pure function** (labels + settings → `"spot" | "on-demand" | { reject: reason }`) so it can be unit-tested without mocks, the same way `planner.ts` is.

### Spot capacity unavailable: wait and retry

When a Spot `RunInstances` call is refused for a capacity or quota reason:

- **Webhook:** the queued-jobs row has already been written, so log a warning saying the job is waiting for Spot capacity, and return **200**. Don't rethrow. The reconciler picks the job up after `reconciler-grace-seconds`, the same path a job takes today when `max-concurrent-runners` is reached.
- **Reconciler:** log the same warning and move on to the next job. The next reconciler run tries again.
- A refused Spot launch **must not count against `reconciler-max-top-ups`**. The current code already increments `topUps` only after a successful launch; keep it that way and cover it with a test.
- Retries go on until the row leaves the table: GitHub sends `in_progress`/`completed` (including when GitHub itself drops the job), the reconciler's status check finds the job no longer queued, or the 24-hour row TTL expires.

Errors to treat as "Spot capacity unavailable" (starting list; the builder should check it against current EC2 error codes): `InsufficientInstanceCapacity`, `MaxSpotInstanceCountExceeded`, `SpotMaxPriceTooLow`, `UnfulfillableCapacity`. Any other `RunInstances` error behaves as it does today.

**Orphaned JIT registrations:** `launchRunner` mints the JIT runner config *before* `RunInstances`. A refused Spot launch therefore leaves an `offline` runner registration with no instance behind it. Reconciler top-up names get pruned by `planRunnerPrune` on the next run. The webhook's base name isn't pruned while its row exists, which matches today's behavior for any failed webhook launch. Repeated Spot retries make this more frequent, so the builder decides whether to delete the registration immediately when a Spot launch is refused (recommended) or rely on the pruner.

### Spot instance launch

- `RunInstances` with `InstanceMarketOptions: { MarketType: "spot", SpotOptions: { SpotInstanceType: "one-time", InstanceInterruptionBehavior: "terminate" } }`.
- No `MaxPrice`. AWS then caps the price at the On-Demand price, so Spot can never cost more than On-Demand.
- Everything else (AMI, user data, EBS, tags, `InstanceInitiatedShutdownBehavior: terminate`) is the same as On-Demand.
- Instance type, disk, and timeout labels work exactly as today. `allowed-instance-types` applies to Spot as well.
- Spot instances count toward `max-concurrent-runners` like any other runner.
- Add an instance tag `github-aws-runner:market` = `spot` | `on-demand` (my call) so logs, the console, and cost reports can tell them apart.

### Reconciler

- The webhook stores the resolved choice on the queued-jobs row (for example, a `market` attribute holding `spot` or `on-demand`), next to `instanceType`/`ebsSizeGb`/`timeoutMinutes`. The reconciler launches replacements with the same choice. A row without the attribute (written before this change) means On-Demand.
- **My call: re-check policy before every top-up.** The reconciler re-runs the decision against the *current* settings using the stored choice. If a stored Spot job now conflicts (Spot disabled), or a stored On-Demand job now conflicts (Spot required), it logs, doesn't launch, and **deletes the row**. This matches the webhook's "don't launch, no row" rule and keeps dead rows from taking reconciler slots. It never converts a job from one market to the other.
- **My call: a Spot job waiting for capacity must not block other jobs.** Today `planLaunches` cuts the oldest-first list down to the free slots under `max-concurrent-runners`. A refused Spot launch uses no slot, so after a refused Spot launch the reconciler should go on down the full oldest-first list of uncovered jobs. It stops once the free slots are used up. Only a refused *Spot* launch frees its slot for the next job; any other launch failure still uses its slot, exactly as today, so On-Demand behavior doesn't change. A long Spot shortage then can't stall On-Demand jobs queued behind it. This needs a small planner change: return the whole uncovered list along with the free-capacity count, and leave the cutting to the reconciler (or something equivalent). Cover it with planner and reconciler tests.
- **My call: a Spot instance reclaimed before its runner picks up a job still counts as a top-up.** AWS rarely reclaims within the first few minutes, and `reconciler-max-top-ups` exists to cap runaway launches. Detecting and exempting reclaims would add complexity for a rare case. Document it next to the max-top-ups setting.
- **No planner change is needed for label matching.** `hasAllLabels` already models GitHub's subset matching, and `spot:true`/`spot:false` are ordinary labels on the job and its runner.

### Label matching (the reason `spot:false` exists)

GitHub gives a job to any online runner whose labels **include all** of the job's `runs-on` labels; the runner may have extra labels. Runners here register with `self-hosted, linux, x64` plus the job's labels (`buildJitLabels` in `lambda/webhook/github-client.ts`). So a Spot runner launched for a `[self-hosted, spot:true]` job can be handed an older `[self-hosted]` job that is queued at the same time. The same thing already happens with `instance-type:` runners today, where it only costs money. With Spot it can put a long job at interruption risk.

This can only happen in per-job mode (enabled, not required) and only when jobs with overlapping labels are queued at once. The design accepts it, documents it, and offers `spot:false` as the guarantee: no Spot runner ever carries `spot:false`, so GitHub can never match such a job to a Spot runner. The reverse can't happen at all (an On-Demand runner lacks `spot:true`).

## Infrastructure (CDK stack)

- Two new SSM name constants, `spot-enabled` and `spot-required`, built from the prefix. Pass them as environment variables to the Webhook and Reconciler Lambdas (`SPOT_ENABLED_PARAM`, `SPOT_REQUIRED_PARAM`). They're runtime parameters, **not** synth-time lookups.
- IAM for both launching Lambdas: Spot through `RunInstances` needs additional resource ARNs (`spot-instances-request/*`, for `RunInstances` and for `CreateTags` if the request gets tagged). It also needs the EC2 Spot service-linked role (`AWSServiceRoleForEC2Spot`) to exist. The builder must check the exact requirements. Preferred approach: grant `iam:CreateServiceLinkedRole` scoped with `iam:AWSServiceName = spot.amazonaws.com`, so the first Spot launch in a fresh account works without manual setup.
- Update the CDK assertion tests for the new environment variables and policy statements.

## Documentation

- **README → Usage in a Workflow:** a Spot example (`runs-on: [self-hosted, spot:true]`), when to use it (short jobs, cost), what an interruption looks like (the job fails; re-run it by hand), and the label-matching caveat with `spot:false` as the fix.
- **README → Optional parameters / Configuration:** `spot-enabled` and `spot-required`, their defaults, the policy table above, and the "don't launch" behavior on conflicts.
- **README → Cost Protection:** Spot never falls back to On-Demand; jobs wait for Spot capacity instead. Mention the account's Spot vCPU quota (Service Quotas, "All Standard Spot Instance Requests"), since a low quota looks like a permanent capacity shortage.
- **CLAUDE.md:** a Key Design Decisions entry covering the label/settings model, no-fallback, the reconciler retry, and the label-matching caveat.

## Testing

- Pure unit tests for the Spot decision function covering every row of the decision table, invalid values, case-insensitivity, both labels present, and contradictory settings.
- Launcher test: Spot launches set `InstanceMarketOptions` with no `MaxPrice`; On-Demand launches don't set it; the `market` tag is set.
- Planner/reconciler: a refused Spot launch does not increment `topUps` and does not use a free slot (a newer On-Demand job still launches in the same pass); a top-up keeps the stored market choice; a missing `market` attribute means On-Demand; a stored choice that conflicts with the current settings is not launched and its row is deleted.
- CDK assertions for the new environment variables and IAM statements.

## Left to the builder

- Exact SSM/env/attribute/tag names (the ones above are suggestions).
- Whether to delete an orphaned JIT registration immediately after a refused Spot launch (recommended).
- The final list of capacity error codes.
- Where the pure decision function lives (for example `lambda/shared/`) and how the webhook's existing `resolve*` helpers are arranged around it.
- Log wording, as long as conflicts and capacity waits are clearly worded and searchable.
