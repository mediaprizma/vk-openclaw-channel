import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { channelReadyPatch, channelStoppedPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/core";
import { PollingTransport, VK } from "vk-io";
import { createStallWatchdog, type StallWatchdog } from "./stall-watchdog.js";
import { resolveVkAccount } from "./accounts.js";
import { redactVkId } from "./diagnostics.js";
import { handleVkInbound } from "./inbound.js";
import { resolveVkVideoComment, resolveVkWallComment } from "./comments.js";
import {
  extractVkInboundAttachments,
  extractVkInboundForwards,
  resolveVkInboundReplyContext,
} from "./media.js";
import { getVkRuntime, readVkRuntimeConfig } from "./runtime.js";
import { handleVkQuestionEvent } from "./question-events.js";
import { primeVkGroupId, resolveVkOwnGroup } from "./send.js";
import type { CoreConfig, VkAccountConfig, VkInboundMessage } from "./types.js";

const FIRST_LONG_POLL_CHECK_TIMEOUT_MS = 35_000;
const FIRST_LONG_POLL_CHECK_ERROR = "VK Long Poll transport check failed";

/**
 * Uses the first real poll as the readiness check, then hands control back to
 * vk-io's normal retrying fetch loop. This avoids a second preflight consumer
 * and ensures updates returned by the readiness poll enter the normal
 * middleware pipeline.
 */
/**
 * How long the transport may stay silent before we treat it as stalled.
 *
 * A long poll waits up to ~25 seconds for an event and then returns, so no
 * completed request for minutes is an anomaly rather than a quiet chat. The
 * gateway watches `lastTransportActivityAt` too, but with a half-hour default;
 * this only makes the same check faster.
 */
const DEFAULT_TRANSPORT_SILENCE_MS = 150_000;

/**
 * Resolved per account start, from the config the gateway hands in, never at
 * import time: the module is evaluated before the plugin runtime exists, so a
 * module-level read would only ever see the default, and a later config change
 * would not reach a constant. The environment still wins when set, because
 * changing a variable on a running gateway is the fastest way to answer
 * "is this knob the problem?".
 */
function resolveTransportSilenceMs(config: VkAccountConfig): number {
  const fromEnv = parseStrictPositiveInteger(process.env.VK_TRANSPORT_SILENCE_MS);
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  return parseStrictPositiveInteger(config.transport?.silenceMs) ?? DEFAULT_TRANSPORT_SILENCE_MS;
}

class BotsLongPollTransport {
  private started = false;
  private ts = "";
  private serverUrl: URL | undefined;
  private key = "";
  private loopPromise: Promise<void> | undefined;
  private firstSuccessfulPoll: Promise<void>;
  private resolveFirstSuccessfulPoll!: () => void;
  private rejectFirstSuccessfulPoll!: (error: Error) => void;
  private readinessSettled = false;
  private readonly api: VK["api"];
  private readonly groupId: number;
  private readonly onPollCompleted: () => void;
  private readonly onUpdate: (update: Record<string, unknown>) => Promise<unknown> | unknown;

  constructor(params: {
    api: VK["api"];
    groupId: number;
    onPollCompleted: () => void;
    onUpdate: (update: Record<string, unknown>) => Promise<unknown> | unknown;
  }) {
    this.api = params.api;
    this.groupId = params.groupId;
    this.onPollCompleted = params.onPollCompleted;
    this.onUpdate = params.onUpdate;
    this.firstSuccessfulPoll = new Promise<void>((resolve, reject) => {
      this.resolveFirstSuccessfulPoll = resolve;
      this.rejectFirstSuccessfulPoll = reject;
    });
    void this.firstSuccessfulPoll.catch(() => {});
  }

  private settleReadinessSuccess(): void {
    if (this.readinessSettled) return;
    this.readinessSettled = true;
    this.resolveFirstSuccessfulPoll();
  }

  private settleReadinessFailure(error = new Error(FIRST_LONG_POLL_CHECK_ERROR)): void {
    if (this.readinessSettled) return;
    this.readinessSettled = true;
    this.rejectFirstSuccessfulPoll(error);
  }

  waitForFirstSuccessfulPoll(timeoutMs = FIRST_LONG_POLL_CHECK_TIMEOUT_MS): Promise<void> {
    const timeout = setTimeout(() => this.settleReadinessFailure(), timeoutMs);
    return this.firstSuccessfulPoll.finally(() => clearTimeout(timeout));
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("VK Bots Long Poll already started");

    const response = await this.api.groups.getLongPollServer({
      group_id: this.groupId,
    });
    const data = response as { server?: string; key?: string; ts?: string | number };
    if (!data.server || !data.key || data.ts === undefined) {
      throw new Error("VK groups.getLongPollServer returned an incomplete response");
    }

    this.serverUrl = new URL(data.server);
    this.key = data.key;
    this.ts = String(data.ts);
    this.started = true;
    this.loopPromise = this.runLoop();
  }

  async stopAndDrain(): Promise<void> {
    this.started = false;
    this.settleReadinessFailure(new Error("VK Bots Long Poll stopped"));
    await this.loopPromise?.catch(() => {});
  }

  private async runLoop(): Promise<void> {
    while (this.started) {
      try {
        await this.fetchOnce();
      } catch (error) {
        if (!this.started) break;
        const message = error instanceof Error ? error.message : String(error);
        // A Long Poll server error requires a fresh server/key/ts.
        try {
          const response = await this.api.groups.getLongPollServer({
            group_id: this.groupId,
          });
          const data = response as { server?: string; key?: string; ts?: string | number };
          if (!data.server || !data.key || data.ts === undefined) {
            throw new Error("VK groups.getLongPollServer returned an incomplete response");
          }
          this.serverUrl = new URL(data.server);
          this.key = data.key;
          this.ts = String(data.ts);
        } catch (refreshError) {
          const refreshMessage =
            refreshError instanceof Error ? refreshError.message : String(refreshError);
          throw new Error(`VK Bots Long Poll restart failed: ${refreshMessage}; original: ${message}`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async fetchOnce(): Promise<void> {
    if (!this.serverUrl) throw new Error("VK Bots Long Poll server is not initialized");

    const url = new URL(this.serverUrl);
    url.search = new URLSearchParams({
      act: "a_check",
      key: this.key,
      ts: this.ts,
      wait: "25",
      mode: "202",
      version: "19",
    }).toString();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    let result:
      | { ts: string | number; updates?: unknown[] }
      | { failed: 1; ts: string | number }
      | { failed: 2; error?: string }
      | { failed: 3; ts?: string | number; failed?: number }
      | { failed: 4; min_version?: number; max_version?: number };

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: { connection: "keep-alive" },
      });
      if (!response.ok) {
        throw new Error(`VK Long Poll HTTP ${response.status}`);
      }
      result = (await response.json()) as typeof result;
    } finally {
      clearTimeout(timeout);
    }

    if ("failed" in result) {
      if (result.failed === 1 && "ts" in result) {
        this.ts = String(result.ts);
        this.onPollCompleted();
        return;
      }
      throw new Error(`VK Long Poll failed=${result.failed}${"error" in result && result.error ? ` ${result.error}` : ""}`);
    }

    this.ts = String(result.ts);
    this.settleReadinessSuccess();
    this.onPollCompleted();

    for (const update of result.updates ?? []) {
      if (!update || typeof update !== "object" || Array.isArray(update)) continue;
      await this.onUpdate(update as Record<string, unknown>);
    }
  }
}

export type VkMonitorOptions = {
  token: string;
  accountId: string;
  config: CoreConfig;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  setStatus?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;
};

/**
 * Check whether the Bots Long Poll API is accessible for this token.
 * Requires the `manage` scope; tokens with only `messages` scope will fail.
 */
async function canUseBotsLongPoll(
  vk: VK,
): Promise<{ ok: boolean; groupId?: number; groupName?: string }> {
  try {
    const { groups } = await vk.api.groups.getById({});
    const groupId = groups[0]?.id;
    if (!groupId) {
      return { ok: false };
    }
    const groupName = groups[0]?.name;
    try {
      // Verify the token can actually start Bots LP
      await vk.api.groups.getLongPollServer({ group_id: groupId });
      return { ok: true, groupId, groupName };
    } catch {
      return { ok: false, groupId, groupName };
    }
  } catch {
    return { ok: false };
  }
}

async function ensureVkCommentLongPollEvents(
  vk: VK,
  groupId: number,
  account: VkAccountConfig,
): Promise<void> {
  const comments = account.comments;
  const postComments = comments?.enabled !== false && comments?.postComments !== false;
  const clipComments = comments?.enabled !== false && comments?.clipComments !== false;
  const videoComments = comments?.enabled === true && comments?.videoComments === true;

  if (!postComments && !clipComments && !videoComments) {
    return;
  }

  try {
    await vk.api.groups.setLongPollSettings({
      group_id: groupId,
      enabled: 1,
      api_version: "5.199",
      ...(postComments ? { wall_reply_new: 1 } : {}),
      ...(clipComments || videoComments ? { video_comment_new: 1 } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to enable VK Long Poll comment events: ${message}`);
  }
}

function isVkCommentEnabled(account: VkAccountConfig, kind: "post" | "clip" | "video"): boolean {
  const comments = account.comments;
  if (comments?.enabled === false) return false;
  if (kind === "post") return comments?.postComments !== false;
  if (kind === "clip") return comments?.clipComments !== false;
  return comments?.videoComments === true;
}

function commentMessageFromContext(
  comment:
    | Awaited<ReturnType<typeof resolveVkWallComment>>
    | Awaited<ReturnType<typeof resolveVkVideoComment>>,
): VkInboundMessage | null {
  if (!comment) return null;
  const contentId = comment.postId ?? comment.videoId;
  if (contentId === undefined) return null;
  return {
    eventType: "message",
    messageId: `comment:${comment.eventType}:${comment.ownerId}:${contentId}:${comment.commentId}`,
    peerId: comment.senderId,
    senderId: comment.senderId,
    text: comment.text,
    timestamp: comment.timestamp,
    isGroup: false,
    comment,
    replyRoute: {
      type:
        comment.eventType === "post_comment"
          ? "post_comment"
          : comment.eventType === "clip_comment"
            ? "clip_comment"
            : "video_comment",
      ownerId: comment.ownerId,
      contentId,
      commentId: comment.commentId,
      ...(comment.replyToComment !== undefined ? { parentCommentId: comment.replyToComment } : {}),
    },
    attachments: comment.origin.media,
    ...(comment.replyToComment !== undefined
      ? { replyToMessageId: String(comment.replyToComment) }
      : {}),
  };
}

async function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise<void>(() => {});
    return;
  }
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Start monitoring VK community messages via Long Poll API.
 * Prefers Bots Long Poll when the token has the `manage` scope;
 * falls back to User Long Poll (messages.getLongPollServer) when only
 * the `messages` scope is available.
 */
export async function monitorVkProvider(opts: VkMonitorOptions): Promise<void> {
  const core = getVkRuntime();
  const account = resolveVkAccount({
    cfg: opts.config,
    accountId: opts.accountId,
  });

  const vk = new VK({ token: opts.token, apiLimit: 20 });
  // Our own stop signal: when the watchdog sees a stalled transport it ends the
  // account task, and the gateway brings the channel back with its own backoff.
  const localStop = new AbortController();
  const stopSignal = opts.abortSignal
    ? AbortSignal.any([opts.abortSignal, localStop.signal])
    : localStop.signal;
  let stopRequested = false;
  let updatesStarted = false;
  let stopPromise: Promise<void> | undefined;
  let pollingTransport: { stopAndDrain(): Promise<void>; waitForFirstSuccessfulPoll(): Promise<void> } | undefined;
  let publishPollActivity = false;
  // Declared here so `finally` can reach it: the watchdog owns a timer, and a
  // start that fails before the watchdog is armed must still release it.
  let stallWatchdog: StallWatchdog | undefined;

  const stopUpdates = async (): Promise<void> => {
    stopRequested = true;
    if (!updatesStarted || !pollingTransport) {
      return;
    }
    if (!stopPromise) {
      stopPromise = pollingTransport.stopAndDrain().catch(() => {
        // ignore stop race/errors on shutdown
      });
    }
    await stopPromise;
  };

  // Ensure gateway stop triggers VK polling shutdown.
  opts.abortSignal?.addEventListener("abort", () => {
    void stopUpdates();
  }, { once: true });

  // Register message handler
  vk.updates.on("message_new", async (context) => {
    if (stopRequested) {
      return;
    }

    // Skip outgoing messages
    if (context.isOutbox) {
      return;
    }

    const peerId = context.peerId;
    const senderId = context.senderId;
    const text = context.text ?? "";
    const isGroup = peerId >= 2_000_000_000;
    const attachments = extractVkInboundAttachments(context.attachments);
    const replyContext = resolveVkInboundReplyContext(context.replyMessage);
    const forwards = extractVkInboundForwards(context.forwards);
    const createdAtSeconds =
      typeof context.createdAt === "number" && Number.isFinite(context.createdAt)
        ? context.createdAt
        : undefined;

    const message: VkInboundMessage = {
      messageId: String(context.id),
      conversationMessageId:
        typeof context.conversationMessageId === "number" && Number.isFinite(context.conversationMessageId)
          ? context.conversationMessageId
          : undefined,
      peerId,
      senderId,
      text,
      timestamp: createdAtSeconds ? createdAtSeconds * 1000 : Date.now(),
      isGroup,
      messagePayload: context.messagePayload,
      attachments,
      replyToMessageId: replyContext.replyToMessageId,
      replyToText: replyContext.replyToText,
      ...(replyContext.replyToTimestamp !== undefined ? { replyToTimestamp: replyContext.replyToTimestamp } : {}),
      replyToSenderId: replyContext.replyToSenderId,
      ...(forwards.length > 0 ? { forwards } : {}),
      replyToForwards: replyContext.replyToForwards,
    };

    core.channel.activity.record({
      channel: "vk-openclaw-channel",
      accountId: account.accountId,
      direction: "inbound",
      at: message.timestamp,
    });
    opts.setStatus?.({ lastEventAt: Date.now() });

    try {
      const currentCfg = readVkRuntimeConfig(core);
      const currentAccount = resolveVkAccount({
        cfg: currentCfg,
        accountId: account.accountId,
      });

      await handleVkInbound({
        message,
        account: currentAccount,
        config: currentCfg,
        runtime: opts.runtime,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      opts.runtime.error?.(`vk: message handler error for peerId=${redactVkId(peerId)}: ${errorMessage}`);
    }
  });

  // Public wall comments. VK Bots Long Poll exposes these as wall_reply_new.
  // The sender id is the canonical customer peer; the comment itself carries
  // the public delivery route and the source post/media context.
  vk.updates.on("wall_reply_new", async (context) => {
    if (stopRequested) return;
    try {
      const comment = await resolveVkWallComment(vk, context);
      if (!comment) return;
      const kind = comment.eventType === "clip_comment" ? "clip" : "post";
      if (!isVkCommentEnabled(account.config, kind)) return;
      const ownGroup = await resolveVkOwnGroup(opts.token);
      if (ownGroup && comment.senderId === -ownGroup.id) return;
      const message = commentMessageFromContext(comment);
      if (!message) return;

      opts.setStatus?.({ lastEventAt: Date.now() });
      core.channel.activity.record({
        channel: "vk-openclaw-channel",
        accountId: account.accountId,
        direction: "inbound",
        at: message.timestamp,
      });
      opts.runtime.log?.(
        `[${opts.accountId}] VK ${comment.eventType}: comment=${comment.commentId} content=${comment.ownerId}_${comment.postId}`,
      );
      const currentCfg = readVkRuntimeConfig(core);
      const currentAccount = resolveVkAccount({ cfg: currentCfg, accountId: account.accountId });
      await handleVkInbound({ message, account: currentAccount, config: currentCfg, runtime: opts.runtime });
    } catch (err) {
      opts.runtime.error?.(`vk: wall_reply_new handler error: ${String(err)}`);
    }
  });

  // VK sends video comments as video_comment_new. The video object has
  // type=short_video for Clips, so the plugin normalizes those to clip_comment.
  vk.updates.on("video_comment_new", async (context) => {
    if (stopRequested) return;
    try {
      const comment = await resolveVkVideoComment(vk, context);
      if (!comment) return;
      const kind = comment.eventType === "clip_comment" ? "clip" : "video";
      if (!isVkCommentEnabled(account.config, kind)) return;
      const ownGroup = await resolveVkOwnGroup(opts.token);
      if (ownGroup && comment.senderId === -ownGroup.id) return;
      const message = commentMessageFromContext(comment);
      if (!message) return;

      opts.setStatus?.({ lastEventAt: Date.now() });
      core.channel.activity.record({
        channel: "vk-openclaw-channel",
        accountId: account.accountId,
        direction: "inbound",
        at: message.timestamp,
      });
      opts.runtime.log?.(
        `[${opts.accountId}] VK ${comment.eventType}: comment=${comment.commentId} content=${comment.ownerId}_${comment.videoId}`,
      );
      const currentCfg = readVkRuntimeConfig(core);
      const currentAccount = resolveVkAccount({ cfg: currentCfg, accountId: account.accountId });
      await handleVkInbound({ message, account: currentAccount, config: currentCfg, runtime: opts.runtime });
    } catch (err) {
      opts.runtime.error?.(`vk: video_comment_new handler error: ${String(err)}`);
    }
  });

  // A pressed inline callback button. Only question buttons exist today (see
  // question.ts); the community must have the `message_event` Long Poll event
  // enabled, or presses never arrive and the button keeps spinning.
  vk.updates.on("message_event", async (context) => {
    if (stopRequested) {
      return;
    }
    opts.setStatus?.({ lastEventAt: Date.now() });
    try {
      await handleVkQuestionEvent({
        event: context,
        accountId: account.accountId,
        runtime: opts.runtime,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      opts.runtime.error?.(`vk: message_event handler error: ${errorMessage}`);
    }
  });

  try {
    // Detect whether Bots LP is available; fall back to User LP otherwise
    const botsLp = await canUseBotsLongPoll(vk);
    if (stopRequested || opts.abortSignal?.aborted) {
      return;
    }
    if (botsLp.groupId !== undefined) {
      primeVkGroupId(opts.token, botsLp.groupId, botsLp.groupName);
    }
    const useBotsLongPoll = botsLp.ok && botsLp.groupId !== undefined;

    if (useBotsLongPoll) {
      await ensureVkCommentLongPollEvents(vk, botsLp.groupId, account);
      opts.runtime.log?.(
        `[${opts.accountId}] VK Long Poll comment events enabled: wall_reply_new, video_comment_new`,
      );
    }
    // The only honest liveness signal is "a poll request came back". The cursor
    // is not one: it moves on EVENTS, so it sits still for hours on a quiet
    // channel; and `isStarted` stays true on a wedged transport.
    stallWatchdog = createStallWatchdog({
      label: `vk:${opts.accountId} long-poll`,
      timeoutMs: resolveTransportSilenceMs(account.config),
      abortSignal: stopSignal,
      runtime: opts.runtime,
      onTimeout: ({ idleMs }) => {
        const silentSec = Math.round(idleMs / 1000);
        opts.setStatus?.(
          channelStoppedPatch({
            lastError: `no completed long-poll request for ${silentSec}s`,
            lastDisconnect: {
              at: Date.now(),
              error: `long poll silent for ${silentSec}s`,
            },
          }),
        );
        localStop.abort();
      },
    });

    if (useBotsLongPoll) {
      pollingTransport = new BotsLongPollTransport({
        api: vk.api,
        groupId: botsLp.groupId,
        onPollCompleted: () => {
          stallWatchdog?.touch();
          if (publishPollActivity) {
            opts.setStatus?.({ lastTransportActivityAt: Date.now() });
          }
        },
        onUpdate: async (update) => {
          const eventType = typeof update.type === "string" ? update.type : "unknown";
          opts.runtime.log?.(`[${opts.accountId}] VK Long Poll update: ${eventType}`);
          await vk.updates.handleWebhookUpdate(update);
        },
      });
      opts.runtime.log?.(`[${opts.accountId}] using native VK Bots Long Poll fetch loop (group ${botsLp.groupId})`);
      await pollingTransport.start();
    } else {
      const userPolling = new PollingTransport({
        api: vk.api,
        pollingWait: 3_000,
        pollingRetryLimit: 3,
      });
      userPolling.subscribe((update) => vk.updates.handlePollingUpdate(update));
      pollingTransport = userPolling as typeof pollingTransport;
      opts.runtime.log?.(
        `[${opts.accountId}] Bots Long Poll unavailable, falling back to User Long Poll`,
      );
      await userPolling.start();
    }
    updatesStarted = true;

    // An abort may arrive while vk-io is awaiting its Long Poll server. Stop
    // the newly started transport before publishing a false-ready snapshot.
    if (stopRequested || opts.abortSignal?.aborted) {
      await stopUpdates();
      return;
    }

    try {
      await pollingTransport.waitForFirstSuccessfulPoll();
    } catch (error) {
      if (stopRequested || opts.abortSignal?.aborted) {
        return;
      }
      throw error;
    }

    if (stopRequested || opts.abortSignal?.aborted) {
      await stopUpdates();
      return;
    }

    const connectedAt = Date.now();
    publishPollActivity = true;
    opts.setStatus?.(
      channelReadyPatch({
        mode: "longpoll",
        lastConnectedAt: connectedAt,
        lastTransportActivityAt: connectedAt,
      }),
    );

    // Armed only after the first successful poll: the connect handshake has no
    // completed poll behind it and would trip the watchdog on every start.
    stallWatchdog.arm(connectedAt);

    // Keep lifecycle alive until the gateway requests stop, or the watchdog
    // ends it because the transport went silent.
    await waitForAbort(stopSignal);
  } finally {
    try {
      await stopUpdates();
    } finally {
      // Unconditional: a failed start never armed the watchdog, so nothing else
      // would ever stop it, and each retry would leave another interval behind.
      stallWatchdog?.stop();
      localStop.abort();
    }
  }
}
