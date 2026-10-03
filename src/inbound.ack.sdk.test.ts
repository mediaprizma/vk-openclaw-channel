import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Whether a group message gets a status reaction, decided by the REAL core
 * gate (`shouldAckReaction` from `channel-feedback`). `inbound.test.ts` mocks
 * the gate and can only pin the arguments; a wrong meaning of an argument
 * passes there. Here the outcome is asserted: was the reaction controller
 * created for the message or not.
 *
 * The `openclaw` peer is optional, so this file skips itself where it is not
 * installed and runs in CI's runtime-compatibility job.
 */
const CHANNEL_FEEDBACK = "openclaw/plugin-sdk/channel-feedback";
const require = createRequire(import.meta.url);
const sdkInstalled = (() => {
  try {
    require.resolve(CHANNEL_FEEDBACK);
    return true;
  } catch {
    return false;
  }
})();

vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  sendMessageVk: vi.fn(async () => ({ messageId: "1", chatId: "1" })),
  sendPayloadVk: vi.fn(async () => ({ messageId: "1", chatId: "1" })),
  markMessageReadVk: vi.fn(async () => undefined),
  sendTypingVk: vi.fn(async () => undefined),
}));

const reactions = vi.hoisted(() => ({ created: [] as number[] }));

vi.mock("./reactions-controller.js", () => ({
  createVkStatusReactionController: vi.fn((params: { cmid: number }) => {
    reactions.created.push(params.cmid);
    return {
      setQueued: vi.fn(async () => undefined),
      setThinking: vi.fn(async () => undefined),
      setTool: vi.fn(async () => undefined),
      setCompacting: vi.fn(async () => undefined),
      setDone: vi.fn(async () => undefined),
      setError: vi.fn(async () => undefined),
      cancelPending: vi.fn(),
      clear: vi.fn(async () => undefined),
      restoreInitial: vi.fn(async () => undefined),
    };
  }),
}));

const feedback: typeof import("openclaw/plugin-sdk/channel-feedback") | null = sdkInstalled
  ? await import("openclaw/plugin-sdk/channel-feedback")
  : null;
const inbound: typeof import("./inbound.js") | null = sdkInstalled
  ? await import("./inbound.js")
  : null;
const runtimeModule: typeof import("./runtime.js") | null = sdkInstalled
  ? await import("./runtime.js")
  : null;
const helpers: typeof import("./test-helpers.js") | null = sdkInstalled
  ? await import("./test-helpers.js")
  : null;

const GROUP_PEER_ID = 2_000_000_001;
const SENDER_ID = 123456;

async function groupMessage(params: {
  text: string;
  requireMention?: boolean;
  scope?: string;
}): Promise<boolean> {
  const runtime = helpers!.makeVkRuntime({
    buildMentionRegexes: vi.fn().mockReturnValue([/@bot/i]),
    matchesMentionPatterns: vi.fn().mockImplementation((body: string) => body.includes("@bot")),
  });
  runtime.channel.text.hasControlCommand = vi.fn((body: string) =>
    body.startsWith("/"),
  ) as never;
  runtime.channel.reactions.shouldAckReaction = feedback!.shouldAckReaction as never;
  runtimeModule!.setVkRuntime(runtime);

  const groups =
    params.requireMention === undefined
      ? { "*": {} }
      : { "*": { requireMention: params.requireMention } };
  await inbound!.handleVkInbound({
    message: helpers!.makeMessage({
      peerId: GROUP_PEER_ID,
      senderId: SENDER_ID,
      isGroup: true,
      text: params.text,
      conversationMessageId: 42,
    }),
    account: helpers!.makeAccount({
      config: { dmPolicy: "open", groupPolicy: "open", groups },
    }),
    config: {
      channels: { "vk-openclaw-channel": { token: "tok", groupPolicy: "open", groups } },
      messages: {
        ...(params.scope ? { ackReactionScope: params.scope } : {}),
        statusReactions: { enabled: true, timing: { debounceMs: 0 } },
      },
    } as never,
    runtime: helpers!.createVkRuntimeEnv(),
  });
  // The dispatcher was reached either way, so a missing reaction is the gate's
  // answer and not a dropped message.
  expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledOnce();
  return reactions.created.length > 0;
}

describe.skipIf(!feedback || !inbound || !runtimeModule || !helpers)(
  "status reactions in a group through the real ack gate",
  () => {
    beforeEach(() => {
      reactions.created = [];
    });

    it("default scope: no reaction on an unmentioned message in a group without requireMention", async () => {
      expect(await groupMessage({ text: "всем привет" })).toBe(false);
    });

    it("default scope: a reaction when the bot is mentioned in a group without requireMention", async () => {
      expect(await groupMessage({ text: "@bot привет" })).toBe(true);
    });

    it("default scope: a reaction on a command that got in without a mention where requireMention is set", async () => {
      expect(await groupMessage({ text: "/status", requireMention: true })).toBe(true);
    });

    it("group-all: a reaction on every message the bot takes", async () => {
      expect(await groupMessage({ text: "всем привет", scope: "group-all" })).toBe(true);
    });
  },
);
