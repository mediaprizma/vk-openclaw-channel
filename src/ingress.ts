import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressMonitor,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { handleVkInbound } from "./inbound.js";
import { getVkRuntime, readVkRuntimeConfig } from "./runtime.js";
import type { ResolvedVkAccount, VkInboundMessage } from "./types.js";

const VK_INGRESS_VERSION = 1;
const VK_INGRESS_POLL_MS = 500;

type VkIngressEvent =
  | {
      version: typeof VK_INGRESS_VERSION;
      kind: "message";
      message: VkInboundMessage;
    }
  | {
      version: typeof VK_INGRESS_VERSION;
      kind: "wall_reply_new";
      object: Record<string, unknown>;
    }
  | {
      version: typeof VK_INGRESS_VERSION;
      kind: "video_comment_new";
      object: Record<string, unknown>;
    };

type VkIngressPayload = {
  version: typeof VK_INGRESS_VERSION;
  event: VkIngressEvent;
};

type VkIngressLifecycle = ReturnType<
  typeof bindIngressLifecycleToReplyOptions
>["turnAdoptionLifecycle"];

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveCommentEventIdentity(
  kind: "wall_reply_new" | "video_comment_new",
  object: Record<string, unknown>,
): { eventId: string; laneKey: string } | undefined {
  const commentId = positiveInt(object.id);
  const senderId =
    positiveInt(object.from_id) ??
    positiveInt(object.user_id) ??
    positiveInt(object.sender_id);
  if (commentId === undefined || senderId === undefined) {
    return undefined;
  }

  const contentId =
    positiveInt(object.post_id) ??
    positiveInt(object.video_id) ??
    positiveInt(object.object_id);

  return {
    eventId:
      contentId === undefined
        ? `comment:${kind}:${senderId}:${commentId}`
        : `comment:${kind}:${senderId}:${contentId}:${commentId}`,
    laneKey: `sender:${senderId}`,
  };
}

function resolveIngressFacts(event: VkIngressEvent): {
  eventId: string;
  laneKey: string;
} | undefined {
  if (event.version !== VK_INGRESS_VERSION) {
    return undefined;
  }

  if (event.kind === "message") {
    const messageId = stringValue(event.message.messageId);
    if (!messageId) {
      return undefined;
    }
    return {
      eventId: `message:${messageId}`,
      laneKey: `peer:${event.message.peerId}`,
    };
  }

  return resolveCommentEventIdentity(event.kind, event.object);
}

export type VkDurableIngress = {
  enqueue: (event: VkIngressEvent) => Promise<{
    kind: string;
    duplicate: boolean;
  }>;
  start: () => void;
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
};

export function createVkDurableIngress(params: {
  account: ResolvedVkAccount;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  queue?: ChannelIngressQueue<VkIngressPayload>;
  handleMessage?: (
    message: VkInboundMessage,
    lifecycle: VkIngressLifecycle,
    receivedAt: number,
  ) => Promise<void>;
  resolveWallComment?: (
    object: Record<string, unknown>,
  ) => Promise<VkInboundMessage | null>;
  resolveVideoComment?: (
    object: Record<string, unknown>,
  ) => Promise<VkInboundMessage | null>;
}) {
  const core = getVkRuntime();
  const queue =
    params.queue ??
    core.state.openChannelIngressQueue<VkIngressPayload>({
      accountId: params.account.accountId,
    });

  const handleMessage =
    params.handleMessage ??
    (async (message, lifecycle) => {
      const config = readVkRuntimeConfig(core);
      await handleVkInbound({
        message,
        account: params.account,
        config,
        runtime: params.runtime,
        turnAdoptionLifecycle: lifecycle,
      });
    });

  const monitor = createChannelIngressMonitor<
    VkIngressEvent,
    VkIngressEvent,
    VkIngressPayload
  >({
    queue,
    inspect: (event, context) => {
      const facts = resolveIngressFacts(event);
      if (!facts) {
        throw new Error(
          context.phase === "claim"
            ? "VK durable ingress payload is invalid."
            : "VK event cannot be durably identified.",
        );
      }
      return facts;
    },
    payload: {
      version: VK_INGRESS_VERSION,
      serialize: (event) => event,
      deserialize: (event) => event,
      encode: ({ body }) => ({ version: VK_INGRESS_VERSION, event: body }),
      decode: (payload) => ({ version: payload.version, body: payload.event }),
      createClaimError: () => new Error("VK durable ingress identity changed."),
    },
    deliver: async (event, lifecycle, record) => {
      const adoption = bindIngressLifecycleToReplyOptions(lifecycle).turnAdoptionLifecycle;
      if (event.kind === "message") {
        await handleMessage(event.message, adoption, record.receivedAt);
        return;
      }

      let message: VkInboundMessage | null = null;
      if (event.kind === "wall_reply_new") {
        message = params.resolveWallComment
          ? await params.resolveWallComment(event.object)
          : null;
      } else if (params.resolveVideoComment) {
        message = await params.resolveVideoComment(event.object);
      }

      if (!message) {
        params.runtime.log?.(
          `vk: durable ${event.kind} ignored: comment payload could not be resolved`,
        );
        return;
      }

      await handleMessage(message, adoption, record.receivedAt);
    },
    pollIntervalMs: VK_INGRESS_POLL_MS,
    retention: {
      completedTtlMs: 30 * 24 * 60 * 60 * 1_000,
      completedMaxEntries: 20_000,
      failedTtlMs: 30 * 24 * 60 * 60 * 1_000,
      failedMaxEntries: 5_000,
    },
    appendRetryDelaysMs: [0, 100, 300],
    waitForDeliveryIdleBeforeRepump: false,
    waitForDeliveryIdleOnStop: false,
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    createStoppedError: () => new Error("VK durable ingress stopped."),
    onError: (error) => {
      params.runtime.error?.(
        `vk: durable ingress error: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
    drain: {
      onLog: (message) => params.runtime.log?.(`vk: ${message}`),
      resolveNonRetryableFailure: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (/payload is invalid|cannot be durably identified|identity changed/i.test(message)) {
          return { reason: "invalid-payload", message };
        }
        return null;
      },
    },
  });

  return {
    enqueue: async (event: VkIngressEvent) => {
      const admitted = await monitor.admit(event);
      if (admitted.kind === "ignored") {
        throw new Error("VK durable ingress admission was unexpectedly ignored.");
      }
      return {
        kind: admitted.queueResult.kind,
        duplicate: admitted.queueResult.duplicate,
      };
    },
    start: monitor.start,
    stop: monitor.stop,
    waitForIdle: monitor.waitForIdle,
  } satisfies VkDurableIngress;
}

export type { VkIngressEvent };
