import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";

/**
 * Watchdog that fires when a transport stops reporting activity.
 *
 * The core ships an equivalent helper, but only from
 * `openclaw/plugin-sdk/channel-lifecycle`, which its own compatibility registry
 * marks for removal (`plugin-sdk-channel-lifecycle-subpath`, replacement
 * `channel-outbound`). The replacement does not export the helper, so importing
 * it would keep this plugin tied to a deprecated subpath for a single symbol.
 * It is a plain interval timer, so we keep a local copy instead.
 *
 * Why a watchdog at all: the gateway already restarts a channel whose
 * `lastTransportActivityAt` goes stale, but its own threshold is half an hour.
 * A VK long poll returns within ~25 seconds even when nothing happens, so a
 * couple of silent minutes is already an anomaly rather than a quiet chat.
 * Detecting it here turns a half-hour outage into a short one.
 */
export type StallWatchdog = {
  /** Start watching. Until armed, silence is expected (transport still starting). */
  arm: (atMs?: number) => void;
  /** Report activity. */
  touch: (atMs?: number) => void;
  /** Stop watching without tearing the timer down. */
  disarm: () => void;
  /** Tear down for good. */
  stop: () => void;
};

export function createStallWatchdog(params: {
  label: string;
  timeoutMs: number;
  checkIntervalMs?: number;
  abortSignal?: AbortSignal;
  runtime?: Pick<RuntimeEnv, "error">;
  onTimeout: (meta: { idleMs: number }) => void;
}): StallWatchdog {
  const timeoutMs = Math.max(1, Math.floor(params.timeoutMs));
  const checkIntervalMs = Math.max(
    100,
    Math.floor(params.checkIntervalMs ?? Math.min(5_000, Math.max(250, timeoutMs / 6))),
  );

  let armed = false;
  let stopped = false;
  let lastActivityAt = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;

  const clearTimer = (): void => {
    if (!timer) {
      return;
    }
    clearInterval(timer);
    timer = null;
  };

  const disarm = (): void => {
    armed = false;
  };

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    disarm();
    clearTimer();
    params.abortSignal?.removeEventListener("abort", stop);
  };

  const check = (): void => {
    if (!armed || stopped) {
      return;
    }
    const idleMs = Date.now() - lastActivityAt;
    if (idleMs < timeoutMs) {
      return;
    }
    // One shot: the handler ends the account task, and a repeat would only
    // stack duplicate work on the way out.
    disarm();
    try {
      params.onTimeout({ idleMs });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A failing handler must not take the transport down with it.
      void Promise.resolve(
        params.runtime?.error?.(`[${params.label}] stall watchdog handler failed: ${message}`),
      ).catch(() => {});
    }
  };

  timer = setInterval(check, checkIntervalMs);
  // Never hold the process open on our account.
  (timer as { unref?: () => void }).unref?.();

  if (params.abortSignal?.aborted) {
    stop();
  } else {
    params.abortSignal?.addEventListener("abort", stop, { once: true });
  }

  return {
    arm: (atMs) => {
      if (stopped) {
        return;
      }
      lastActivityAt = atMs ?? Date.now();
      armed = true;
    },
    touch: (atMs) => {
      if (stopped) {
        return;
      }
      lastActivityAt = atMs ?? Date.now();
    },
    disarm,
    stop,
  };
}
