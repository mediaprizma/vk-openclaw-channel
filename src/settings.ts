import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/core";
import { readVkRuntimeConfig, tryGetVkRuntime } from "./runtime.js";

/**
 * Channel tunables, read from `channels.vk.*` with an environment override.
 *
 * These used to live in the environment only. That put roughly a dozen
 * user-facing settings outside everything the host provides for configuration —
 * schema validation, `openclaw doctor`, live reload — and made them invisible to
 * anyone reading the config. They are config now; the environment still wins
 * when set, because changing a variable on a running gateway is the fastest way
 * to answer "is this knob the problem?".
 *
 * Read per call, like the diagnostics level next door: the core keeps the config
 * snapshot in memory, so this is a field read rather than a disk read, and a
 * config edit takes effect without a restart.
 */
function readVkChannelSection(section: string): Record<string, unknown> | undefined {
  try {
    const runtime = tryGetVkRuntime();
    const channels = runtime
      ? (readVkRuntimeConfig(runtime) as { channels?: unknown } | undefined)?.channels as
          | { vk?: Record<string, unknown> }
          | undefined
      : undefined;
    const value = channels?.vk?.[section];
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    // A tunable must never break the path that reads it.
    return undefined;
  }
}

/** Positive integer setting: environment first, then config, then the default. */
export function vkPositiveSetting(params: {
  env: string;
  section: string;
  key: string;
  fallback: number;
}): number {
  const fromEnv = parseStrictPositiveInteger(process.env[params.env]);
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  const configured = readVkChannelSection(params.section)?.[params.key];
  return parseStrictPositiveInteger(configured) ?? params.fallback;
}
