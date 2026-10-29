/**
 * Spot market policy: pure decisions about whether a job runs on Spot or
 * On-Demand. No AWS or GitHub calls, so it is unit-testable without mocks.
 *
 * Rejection reasons deliberately omit the SSM prefix and job ID; callers add
 * the job ID, and the setting names below are the unprefixed parameter names.
 */

export type Market = "spot" | "on-demand";

export interface SpotSettings {
  enabled: boolean;
  required: boolean;
}

export type MarketDecision = { market: Market } | { reject: string };

/** Instance tag recording which market an instance was launched on. */
export const TAG_MARKET = "github-aws-runner:market";

const CAPACITY_ERROR_CODES = new Set([
  "InsufficientInstanceCapacity",
  "MaxSpotInstanceCountExceeded",
  "SpotMaxPriceTooLow",
  "UnfulfillableCapacity",
]);

// Refusals specific to one Availability Zone: another subnet may still succeed.
const ZONAL_REFUSAL_CODES = new Set([
  "InsufficientInstanceCapacity",
  "UnfulfillableCapacity",
  "SpotMaxPriceTooLow",
  "Unsupported",
]);

function hasErrorCode(err: unknown, codes: Set<string>): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; Code?: unknown };
  return (
    (typeof e.name === "string" && codes.has(e.name)) ||
    (typeof e.Code === "string" && codes.has(e.Code))
  );
}

function parseBool(
  raw: string | undefined,
  name: string,
  fallback: boolean,
): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  console.warn(
    `Invalid value "${raw}" for ${name}; expected true or false. Using default ${fallback}.`,
  );
  return fallback;
}

export function parseSpotSettings(
  enabledRaw: string | undefined,
  requiredRaw: string | undefined,
): SpotSettings {
  const enabled = parseBool(enabledRaw, "spot-enabled", true);
  const required = parseBool(requiredRaw, "spot-required", false);
  if (!enabled && required) {
    // Disabled wins: requiring a market that is switched off would make every
    // job unlaunchable, which is a worse failure than running On-Demand.
    console.warn(
      "spot-enabled is false but spot-required is true; Spot is disabled, so spot-required is ignored.",
    );
    return { enabled: false, required: false };
  }
  return { enabled, required };
}

/** Reads the job's `spot:` label. GitHub label matching is case-insensitive. */
function labelPreference(labels: string[]): boolean | "conflict" | undefined {
  let wantsSpot = false;
  let wantsOnDemand = false;
  for (const label of labels) {
    const match = /^spot:(.*)$/i.exec(label.trim());
    if (!match) continue;
    const value = match[1].trim().toLowerCase();
    if (value === "true") wantsSpot = true;
    else if (value === "false") wantsOnDemand = true;
    else
      console.warn(
        `Ignoring unrecognised label "${label}"; expected spot:true or spot:false.`,
      );
  }
  if (wantsSpot && wantsOnDemand) return "conflict";
  if (wantsSpot) return true;
  if (wantsOnDemand) return false;
  return undefined;
}

export function resolveMarket(
  labels: string[],
  settings: SpotSettings,
): MarketDecision {
  const pref = labelPreference(labels);
  if (pref === "conflict") {
    return { reject: "job has both spot:true and spot:false labels" };
  }
  if (pref === true) {
    return settings.enabled
      ? { market: "spot" }
      : { reject: "job requests spot:true but spot-enabled is false" };
  }
  if (pref === false) {
    return settings.required
      ? { reject: "job requests spot:false but spot-required is true" }
      : { market: "on-demand" };
  }
  return { market: settings.required ? "spot" : "on-demand" };
}

/**
 * Checks a stored market choice against current settings. Settings may have
 * changed since the job was queued; we never convert a job between markets, so
 * a conflict means the job should not launch.
 */
export function recheckMarket(
  market: Market,
  settings: SpotSettings,
): string | undefined {
  if (market === "spot" && !settings.enabled) {
    return "job was queued for Spot but spot-enabled is now false";
  }
  if (market === "on-demand" && settings.required) {
    return "job was queued for On-Demand but spot-required is now true";
  }
  return undefined;
}

export function parseMarket(raw: string | undefined): Market {
  return raw === "spot" ? "spot" : "on-demand";
}

export function isSpotCapacityError(err: unknown): boolean {
  return hasErrorCode(err, CAPACITY_ERROR_CODES);
}

/** A launch refused by one zone; the launcher tries the next subnet. */
export function isZonalRefusal(err: unknown): boolean {
  return hasErrorCode(err, ZONAL_REFUSAL_CODES);
}

/** A Spot launch refused for capacity or quota reasons; retry later. */
export class SpotCapacityError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "SpotCapacityError";
    this.cause = cause;
  }
}
