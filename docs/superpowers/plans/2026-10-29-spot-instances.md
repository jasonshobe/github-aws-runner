# Spot Instance Runners Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a job opt into EC2 Spot with a `spot:true` label (or opt out with `spot:false`). Two org-wide SSM settings, `spot-enabled` and `spot-required`, enforce policy. When Spot capacity is short, the job waits and retries Spot; it never falls back to On-Demand.

**Architecture:** A new pure module, `lambda/shared/spot.ts`, turns labels and settings into a Spot/On-Demand decision or a rejection, and classifies Spot capacity errors. `launchRunner` gains a `market` field. It requests Spot through `InstanceMarketOptions` and turns capacity refusals into a typed `SpotCapacityError`, deleting the JIT registration it already created. The webhook stores the decision on the queued-jobs row. The reconciler re-checks it against current settings and refills a slot whenever a Spot launch is refused.

**Tech Stack:** TypeScript, AWS SDK v3 (EC2, SSM, DynamoDB), AWS CDK v2, Jest (ts-jest).

**Spec:** `docs/superpowers/specs/2026-10-29-spot-instances-design.md`

## Global Constraints

- **Backward compatible:** with no new SSM parameters and no `spot:` labels, behavior must be identical to today: On-Demand, the same `RunInstances` input apart from the new tag, and the same reconciler slot accounting for On-Demand failures.
- Never fall back from Spot to On-Demand, and never convert a stored job from one market to the other.
- SSM names: `<prefix>/spot-enabled` (default `true`) and `<prefix>/spot-required` (default `false`). They are runtime parameters, never `valueFromLookup`.
- Environment variables: `SPOT_ENABLED_PARAM` and `SPOT_REQUIRED_PARAM` on the Webhook and Reconciler Lambdas.
- Labels: `spot:true` and `spot:false`. Both key and value match case-insensitively, because GitHub label matching is case-insensitive.
- Contradictory settings (`enabled=false`, `required=true`): disabled wins, and a warning is logged.
- Spot request: `MarketType: "spot"`, `SpotInstanceType: "one-time"`, `InstanceInterruptionBehavior: "terminate"`, no `MaxPrice`.
- Instance tag `github-aws-runner:market` = `spot` | `on-demand`. Queued-jobs row attribute `market` (`S`). A missing or unknown value means On-Demand.
- Capacity error codes: `InsufficientInstanceCapacity`, `MaxSpotInstanceCountExceeded`, `SpotMaxPriceTooLow`, `UnfulfillableCapacity`.
- A refused Spot launch never increments `topUps`.
- Rejected jobs (policy conflict): log the reason, write no row, return 200.
- Match the surrounding code's style: module-level SDK clients, `console.log`/`warn`/`error` with a `Reconciler:` prefix in the reconciler, comments that explain *why*.

## Review Focus

1. **Mixed-case labels** (`Spot:TRUE`): should resolve to Spot. Pinned in Task 1.
2. **SDK error shape:** EC2 SDK v3 errors carry the code in `name`; some paths use `Code`. Both must be classified. Pinned in Task 1.
3. **Cleanup failure:** if deleting the orphaned JIT registration fails, the caller must still see a `SpotCapacityError`, not the delete error, or the webhook returns 5xx. Pinned in Task 2.
4. **An upgraded deployment's old rows** (no `market` attribute) must top up On-Demand, not be rejected under default settings. Pinned in Task 4.
5. **No overflow to refill from:** a refused Spot launch with an empty overflow list must not crash or loop. Pinned in Task 4.

---

### Task 1: Spot policy module

**Files:**
- Create: `lambda/shared/spot.ts`
- Test: `test/spot.test.ts`

**Interfaces:**
- Produces:
  - `type Market = "spot" | "on-demand"`
  - `interface SpotSettings { enabled: boolean; required: boolean }`
  - `type MarketDecision = { market: Market } | { reject: string }`
  - `parseSpotSettings(enabledRaw: string | undefined, requiredRaw: string | undefined): SpotSettings`: missing means the default; an unparseable value logs a warning and uses the default; contradictory settings log a warning and return `{ enabled: false, required: false }`.
  - `resolveMarket(labels: string[], settings: SpotSettings): MarketDecision`: implements the spec's decision table.
  - `recheckMarket(market: Market, settings: SpotSettings): string | undefined`: returns a reason when a stored choice now conflicts (`spot` while disabled, `on-demand` while required), otherwise `undefined`.
  - `parseMarket(raw: string | undefined): Market`: `"spot"` gives `"spot"`; anything else gives `"on-demand"`.
  - `TAG_MARKET = "github-aws-runner:market"`
  - `isSpotCapacityError(err: unknown): boolean`: checks `err.name` or `err.Code` against the four codes.
  - `class SpotCapacityError extends Error`: its constructor takes `(message: string, cause: unknown)` and sets `name = "SpotCapacityError"`.

- [ ] **Step 1: Write the failing tests in `test/spot.test.ts`**

Silence `console.warn` with `jest.spyOn` in `beforeEach`. Tests:
- `parseSpotSettings` defaults: `(undefined, undefined)` → `{ enabled: true, required: false }`.
- Parses `"TRUE"` / `"False"` case-insensitively; `("yes", "maybe")` → defaults, and `console.warn` called.
- `("false", "true")` → `{ enabled: false, required: false }`, and a warning mentions both parameters.
- `it.each` over all nine rows of the spec decision table, using `S = { enabled: true, required: false }`, `R = { enabled: true, required: true }`, `D = { enabled: false, required: false }` and the labels `[]`, `["spot:true"]`, `["spot:false"]` (always plus `"self-hosted"`). Assert `{ market: "on-demand" }` / `{ market: "spot" }`, or `expect.objectContaining({ reject: expect.any(String) })` for the two rejection rows.
- `["self-hosted", "Spot:TRUE"]` under `S` → `{ market: "spot" }`.
- `["self-hosted", "spot:maybe"]` under `S` → `{ market: "on-demand" }`, and a warning is logged; under `R` → `{ market: "spot" }`.
- `["self-hosted", "spot:true", "spot:false"]` → a rejection.
- `recheckMarket("spot", D)` is a string; `recheckMarket("on-demand", R)` is a string; `recheckMarket("on-demand", S)` and `recheckMarket("spot", R)` are `undefined`.
- `parseMarket(undefined)`, `parseMarket("bogus")` → `"on-demand"`; `parseMarket("spot")` → `"spot"`.
- `isSpotCapacityError` is true for `{ name: "InsufficientInstanceCapacity" }` and `{ Code: "MaxSpotInstanceCountExceeded" }`; false for `{ name: "UnauthorizedOperation" }`, `new Error("x")`, and `undefined`.

- [ ] **Step 2: Run, expect FAIL (module not found)**

Run: `npm test -- test/spot.test.ts`

- [ ] **Step 3: Implement `lambda/shared/spot.ts`**

Write rejection reasons a person can act on, naming the job label and the setting, e.g. `job requests spot:true but <spot-enabled> is false`. The reason must not depend on the SSM prefix, because callers add the job ID.

- [ ] **Step 4: Run, expect PASS**

Run: `npm test -- test/spot.test.ts`

- [ ] **Step 5: Commit**

```bash
git add lambda/shared/spot.ts test/spot.test.ts
git commit -m "Add Spot market policy module"
```

---

### Task 2: Launch Spot instances

**Files:**
- Modify: `lambda/shared/launcher.ts` (`LaunchRequest`, `launchRunner`)
- Test: `test/launcher.test.ts` (new `describe("launchRunner")` block; the existing bootstrap tests stay as they are)

**Interfaces:**
- Consumes: `Market`, `TAG_MARKET`, `isSpotCapacityError`, `SpotCapacityError` from Task 1; `generateJitConfig` (returns `{ runnerId, encodedJitConfig }`) and `deleteRunner(targetType, targetSlug, runnerId, token)` from `lambda/webhook/github-client.ts`.
- Produces: `LaunchRequest.market: Market` (required). `launchRunner` throws `SpotCapacityError` when a Spot launch is refused for capacity; every other error passes through unchanged.

- [ ] **Step 1: Write the failing tests**

Spy on `EC2Client.prototype.send`: return `{ Images: [{ ImageId: "ami-1", CreationDate: "2026-01-01" }] }` for `DescribeImagesCommand` and `{ Instances: [{ InstanceId: "i-1" }] }` for `RunInstancesCommand`. Spy on `global.fetch` for the JIT call (`{ runner: { id: 42 }, encoded_jit_config: "cfg" }`) and the DELETE call. Tests:
- `"launches On-Demand without InstanceMarketOptions"`: `market: "on-demand"` → the `RunInstancesCommand` input has no `InstanceMarketOptions` key, and the tags include `{ Key: "github-aws-runner:market", Value: "on-demand" }`.
- `"launches Spot as a one-time request with no price cap"`: `InstanceMarketOptions` equals `{ MarketType: "spot", SpotOptions: { SpotInstanceType: "one-time", InstanceInterruptionBehavior: "terminate" } }`, and the market tag is `spot`.
- `"turns a Spot capacity refusal into SpotCapacityError and deletes the JIT registration"`: `RunInstances` rejects with `Object.assign(new Error("no capacity"), { name: "InsufficientInstanceCapacity" })` → rejects with an instance of `SpotCapacityError`, and `fetch` was called with `method: "DELETE"` on a URL ending in `/42`.
- `"still throws SpotCapacityError when deleting the registration fails"`: the DELETE responds 500 → still rejects with `SpotCapacityError`.
- `"passes non-capacity errors through"`: Spot plus an `UnauthorizedOperation` error → rejects with that same error, and no DELETE is sent.

- [ ] **Step 2: Run, expect FAIL**

Run: `npm test -- test/launcher.test.ts`

- [ ] **Step 3: Implement**

Add `InstanceMarketOptions` only when `market === "spot"` (spread it in conditionally, so the On-Demand input matches today's). Add the market tag. Wrap the `RunInstances` send: on `isSpotCapacityError(err) && req.market === "spot"`, try `deleteRunner` (log any failure with `console.error` and swallow it), then throw `new SpotCapacityError(...)` with the instance type and runner name in the message. Use the `runnerId` from `generateJitConfig`.

- [ ] **Step 4: Run, expect PASS; then `npm run build`, expect no type errors** (the build fails at the two `launchRunner` callers; adding `market: "on-demand"` there temporarily is fine, since Tasks 3–4 replace it).

- [ ] **Step 5: Commit**

```bash
git add lambda/shared/launcher.ts lambda/webhook/index.ts lambda/reconciler/index.ts test/launcher.test.ts
git commit -m "Launch Spot runners and clean up refused Spot registrations"
```

---

### Task 3: Webhook decides the market

**Files:**
- Modify: `lambda/webhook/index.ts` (`cachedParams`, `getParams`, `handler`)
- Test: create `test/webhook.test.ts`

**Interfaces:**
- Consumes: `parseSpotSettings`, `resolveMarket`, `SpotCapacityError` (Task 1); `launchRunner` with `market` (Task 2).
- Produces: queued-jobs rows carry `market: { S: "spot" | "on-demand" }`; the reconciler in Task 4 reads it.

- [ ] **Step 1: Write the failing tests**

`getParams` caches at module level, so each test needs a fresh module. In `beforeEach`: `jest.resetModules()`; `jest.doMock("../lambda/shared/launcher", () => ({ ...jest.requireActual("../lambda/shared/launcher"), launchRunner: jest.fn().mockResolvedValue("i-1") }))`. Then `require` the SDK clients and spy on `SSMClient.prototype.send`, `DynamoDBClient.prototype.send`, and `EC2Client.prototype.send` (a `DescribeInstances` result with zero instances). Finally `require("../lambda/webhook")`. Set the env vars the handler reads, including `SPOT_ENABLED_PARAM=/t/spot-enabled` and `SPOT_REQUIRED_PARAM=/t/spot-required`. Have a helper build a signed `workflow_job.queued` event from `labels`, and a helper return SSM parameters, optionally adding the spot ones. Tests:
- `"keeps today's behavior with no spot parameters or labels"`: `launchRunner` called with `expect.objectContaining({ market: "on-demand" })`, and the `PutItemCommand` item has `market: { S: "on-demand" }`.
- `"launches Spot for spot:true"`: `market: "spot"` passed through and stored.
- `"launches Spot for an unlabeled job when spot-required is true"`.
- `"rejects spot:true when spot-enabled is false without writing a row"`: status 200; `launchRunner` not called; no `PutItemCommand` sent; `console.warn` or `console.log` called with a message containing the job ID and `spot:true`.
- `"rejects spot:false when spot-required is true without writing a row"`: same assertions.
- `"returns 200 and keeps the row when Spot capacity is refused"`: `launchRunner` rejects with `new SpotCapacityError("x", null)` → status 200, `PutItemCommand` was sent, and nothing is thrown.

- [ ] **Step 2: Run, expect FAIL**

Run: `npm test -- test/webhook.test.ts`

- [ ] **Step 3: Implement**

Add the two parameter names to `GetParametersCommand` and store `spotSettings: SpotSettings` in `cachedParams` (via `parseSpotSettings`). In `handler`, right after the `runnerLabel` check: call `resolveMarket`; on rejection log `Job <id> not launched: <reason>` and return 200 before the `PutItemCommand`. Add `market=<m>` to the existing "Processing…" log line and the `market` attribute to the row. Wrap `launchRunner`: on `SpotCapacityError`, `console.warn` that the job is waiting for Spot capacity and the reconciler will retry, then return 200. Rethrow anything else, as today.

- [ ] **Step 4: Run, expect PASS** (`npm test -- test/webhook.test.ts`)

- [ ] **Step 5: Commit**

```bash
git add lambda/webhook/index.ts test/webhook.test.ts
git commit -m "Resolve Spot or On-Demand per job in the webhook"
```

---

### Task 4: Reconciler keeps the market and refills refused Spot slots

**Files:**
- Modify: `lambda/reconciler/planner.ts` (`QueuedJob`, `Plan`, `planLaunches`)
- Modify: `lambda/reconciler/index.ts` (`getParams`, `scanQueuedJobs`, the `handler` launch loop)
- Test: `test/reconciler-planner.test.ts`; create `test/reconciler.test.ts`

**Interfaces:**
- Consumes: `Market`, `parseMarket`, `parseSpotSettings`, `recheckMarket`, `SpotCapacityError` (Task 1); `launchRunner` with `market` (Task 2); the row `market` attribute (Task 3).
- Produces: `QueuedJob.market?: Market`; `Plan.overflow: QueuedJob[]`, the uncovered stale jobs beyond free capacity, oldest first. `launchFor` keeps its current meaning, so the existing planner tests stay valid.

- [ ] **Step 1: Write the failing planner test**

`"returns uncovered jobs beyond free capacity as overflow, oldest first"`: three stale jobs aged 30, 20 and 10 minutes, `maxConcurrentRunners: 1`, no instances → `launchFor` ids `["a"]` and `overflow` ids `["b", "c"]`. Also assert `overflow` is `[]` in the existing "launches a runner for a stale queued job…" test.

- [ ] **Step 2: Write the failing reconciler handler tests in `test/reconciler.test.ts`**

Same isolation pattern as Task 3. Use `jest.doMock` for `launchRunner` and for `../lambda/webhook/github-client` (`listRunners` → `[]`, `getJobStatus` → `"queued"`, `deleteRunner` → resolved). Spy on `send` for SSM (parameters including `max-concurrent-runners`), DynamoDB (`ScanCommand` returns the rows under test; capture `UpdateItemCommand` / `DeleteItemCommand`), and EC2 (no live instances). Rows are 10+ minutes old and include `repo`. Tests:
- `"tops up a row without a market attribute as On-Demand"`: `launchRunner` gets `market: "on-demand"` under default settings.
- `"tops up a Spot row as Spot"`.
- `"a refused Spot launch frees its slot for the next job and does not count as a top-up"`: cap 1; rows `spot-old` (market spot, older) and `od-new` (on-demand). The first call rejects with `SpotCapacityError` and the second resolves → `launchRunner` called for both, in that order. The only `UpdateItemCommand` is for `od-new`.
- `"an On-Demand launch failure still uses its slot"`: cap 1; two on-demand rows; the first launch rejects with a plain `Error` → `launchRunner` called once.
- `"a refused Spot launch with nothing in overflow just moves on"`: cap 5, one spot row, rejected → the handler resolves and no `UpdateItemCommand` is sent.
- `"drops a Spot row when Spot has since been disabled"`: spot-enabled `false` → `launchRunner` not called, and a `DeleteItemCommand` is sent for that job.
- `"drops an On-Demand row when Spot has since been required"`.

- [ ] **Step 3: Run both test files, expect FAIL**

Run: `npm test -- test/reconciler-planner.test.ts test/reconciler.test.ts`

- [ ] **Step 4: Implement**

- Planner: compute `uncovered` as today. `launchFor = uncovered.slice(0, limit)`, `overflow = uncovered.slice(limit)`.
- `scanQueuedJobs`: `market: parseMarket(item.market?.S)`.
- `getParams`: read the two Spot parameters → `spotSettings`.
- Loop: work through a queue that starts as `launchFor`, plus a `refill()` that moves `overflow.shift()` (if any) onto it. Run the existing status check unchanged first. Then `recheckMarket(job.market ?? "on-demand", settings)`: on a reason, log `Reconciler: job <id> not launched: <reason> — dropping its row`, delete the row, and `refill()`. Pass `market` to `launchRunner`. On `SpotCapacityError`: `console.warn` `Reconciler: job <id> is waiting for Spot capacity (<message>); will retry next run`, `refill()`, `continue` (no `topUps` update). Leave the other-error path exactly as today (no refill). Keep the runner-name suffix unique per launch attempt with a counter rather than the queue index.

- [ ] **Step 5: Run, expect PASS; then run the full suite** (`npm test`)

- [ ] **Step 6: Commit**

```bash
git add lambda/reconciler test/reconciler-planner.test.ts test/reconciler.test.ts
git commit -m "Retry Spot in the reconciler without blocking other jobs"
```

---

### Task 5: Stack parameters and IAM

**Files:**
- Modify: `lib/github-aws-runner-stack.ts` (SSM constants; Webhook and Reconciler `environment`; both Lambdas' `RunInstances` supporting-resources statements; a new statement on each)
- Test: `test/github-aws-runner.test.ts`

**Interfaces:**
- Produces: `SPOT_ENABLED_PARAM` / `SPOT_REQUIRED_PARAM` env vars consumed by Tasks 3–4.

- [ ] **Step 1: Write the failing assertions**

- `"webhook and reconciler Lambdas receive the Spot parameter names"`: `template.findResources("AWS::Lambda::Function")` has exactly 2 functions whose `Environment.Variables` include `SPOT_ENABLED_PARAM: "/github-aws-runner/spot-enabled"` and `SPOT_REQUIRED_PARAM: "/github-aws-runner/spot-required"`.
- Extend `"allows webhook Lambda to launch tagged instances…"`: the supporting-resources `Resource` array includes `"arn:aws:ec2:us-east-1:123456789012:spot-instances-request/*"`.
- `"launching Lambdas may create only the EC2 Spot service-linked role"`: an `AWS::IAM::Policy` statement with `Action: "iam:CreateServiceLinkedRole"` and `Condition: { StringEquals: { "iam:AWSServiceName": "spot.amazonaws.com" } }`, and exactly 2 policies containing it.

- [ ] **Step 2: Run, expect FAIL** (`npm test -- test/github-aws-runner.test.ts`)

- [ ] **Step 3: Implement**

Add `SSM_SPOT_ENABLED` / `SSM_SPOT_REQUIRED` next to the other constants. Add the env vars. Add the `spot-instances-request/*` ARN to both supporting-resources `RunInstances` statements. Add the `CreateServiceLinkedRole` statement to both Lambdas, with a comment saying why: the first Spot launch in an account creates `AWSServiceRoleForEC2Spot`. Before finishing, check the AWS Service Authorization Reference for EC2 `RunInstances` with Spot and adjust if it requires more. The existing `ssm:GetParameters` grants must cover the new names; check how they are scoped.

- [ ] **Step 4: Run, expect PASS; `npx cdk synth` succeeds**

- [ ] **Step 5: Commit**

```bash
git add lib/github-aws-runner-stack.ts test/github-aws-runner.test.ts
git commit -m "Grant Spot launch permissions and pass Spot settings to Lambdas"
```

---

### Task 6: Documentation

**Files:**
- Modify: `README.md` ("Usage in a Workflow", "Optional parameters" table, "Configuration" with a new "### Spot Instances" subsection after "Runner Capacity Reconciliation", "Cost Protection")
- Modify: `CLAUDE.md` (Key Design Decisions; per-job overrides line; Lambda Modules paragraph on `lambda/shared/spot.ts`)

- [ ] **Step 1: README**

- Usage: a `runs-on: [self-hosted, spot:true]` example plus a `spot:false` example. A short paragraph covers: Spot is for short, cost-sensitive jobs; an interruption fails the job and someone re-runs it by hand; GitHub matches by label subset, so an unlabeled job can occasionally land on a Spot runner queued alongside it, and `spot:false` prevents that.
- Optional parameters: rows for `spot-enabled` (default `true`) and `spot-required` (default `false`).
- Spot Instances subsection: the spec's policy table; the "not launched, logged" behavior for conflicts; no On-Demand fallback, with jobs waiting and retrying until Spot capacity returns; refused launches don't count toward `reconciler-max-top-ups`, but a Spot instance reclaimed before its runner takes a job does; settings changes take effect as Lambdas pick them up (the webhook caches parameters per warm instance, as with every other runtime parameter).
- Cost Protection: the Spot vCPU quota ("All Standard Spot Instance Requests" in Service Quotas). A low quota looks like a permanent capacity shortage.

- [ ] **Step 2: CLAUDE.md**

Add a "Spot is per-job and never falls back" Key Design Decision covering: the labels and settings, the decision living in `lambda/shared/spot.ts`, `SpotCapacityError` with reconciler refill, the market re-check, and the label-matching caveat. Mention `spot:true` / `spot:false` in the per-job overrides paragraph. Add `github-aws-runner:market` to the tagging list.

- [ ] **Step 3: Verify:** `npm run build && npm test`, all passing.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "Document per-job Spot runners"
```
