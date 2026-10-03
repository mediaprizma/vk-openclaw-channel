import type { VK } from "vk-io";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runVkConnectionSmoke,
  testLongPoll,
  testSendMessage,
} from "./test-vk-connection.js";

function successfulLongPollFetch() {
  return vi.fn(async () =>
    new Response(JSON.stringify({ ts: "next-ts", updates: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

function makeVkClient(options: {
  probe?: () => Promise<unknown>;
  longPollServer?: () => Promise<unknown>;
  send?: () => Promise<unknown>;
  start?: () => Promise<void>;
  stop?: () => Promise<void>;
} = {}) {
  return {
    api: {
      groups: {
        getById: vi.fn(
          options.probe ?? (async () => ({ groups: [{ id: 1, name: "Test" }] })),
        ),
        getLongPollServer: vi.fn(
          options.longPollServer ??
            (async () => ({ server: "https://lp.example.test", key: "lp-key", ts: "1" })),
        ),
      },
      messages: {
        send: vi.fn(
          options.send ??
            (async () => [{ peer_id: 42, message_id: 123, conversation_message_id: 7 }]),
        ),
      },
    },
    updates: {
      on: vi.fn(),
      start: vi.fn(options.start ?? (async () => undefined)),
      stop: vi.fn(options.stop ?? (async () => undefined)),
    },
  } as unknown as VK;
}

function silenceConsole() {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("manual VK connection smoke", () => {
  it("times out a never-settling groups probe before send or Long Poll", async () => {
    silenceConsole();
    const vk = makeVkClient({ probe: () => new Promise(() => undefined) });

    const exitCode = await runVkConnectionSmoke({
      token: "test-token",
      testPeerId: "42",
      client: vk,
      probeTimeoutMs: 5,
    });

    expect(exitCode).toBe(1);
    expect(vk.api.messages.send).not.toHaveBeenCalled();
    expect(vk.updates.start).not.toHaveBeenCalled();
  });

  it("times out a never-settling message send and returns a failure", async () => {
    silenceConsole();
    const vk = makeVkClient({ send: () => new Promise(() => undefined) });

    const exitCode = await runVkConnectionSmoke({
      token: "test-token",
      testPeerId: "42",
      client: vk,
      sendTimeoutMs: 5,
      longPoll: { fetchImpl: successfulLongPollFetch() as typeof fetch },
    });

    expect(exitCode).toBe(1);
    expect(vk.api.messages.send).toHaveBeenCalledOnce();
  });

  it("rejects an empty messages.send response instead of printing a false PASS", async () => {
    silenceConsole();
    const vk = makeVkClient({ send: async () => [] });

    const ok = await testSendMessage(vk, "42");

    expect(ok).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      "  FAIL: messages.send returned no confirmed message id",
    );
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("Message sent"));
  });

  it("rejects a malformed messages.send response without a positive message id", async () => {
    silenceConsole();
    const vk = makeVkClient({
      send: async () => [
        { peer_id: 42, message_id: 0, conversation_message_id: -1 },
        { peer_id: 42 },
      ],
    });

    const ok = await testSendMessage(vk, "42");

    expect(ok).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      "  FAIL: messages.send returned no confirmed message id",
    );
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("Message sent"));
  });

  it("accepts a positive conversation_message_id when message_id is zero", async () => {
    silenceConsole();
    const vk = makeVkClient({
      send: async () => [{ peer_id: 42, message_id: 0, conversation_message_id: 9 }],
    });

    const ok = await testSendMessage(vk, "42");

    expect(ok).toBe(true);
    expect(console.log).toHaveBeenCalledWith("  Message sent, ID: 9");
  });

  it("does not start the SDK when the real a_check request never settles", async () => {
    silenceConsole();
    const vk = makeVkClient();
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined));

    const ok = await testLongPoll(vk, {
      networkTimeoutMs: 5,
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(vk.updates.start).not.toHaveBeenCalled();
    expect(vk.updates.stop).toHaveBeenCalledOnce();
  });

  it("does not start the SDK when a_check returns a Long Poll failure", async () => {
    silenceConsole();
    const vk = makeVkClient();
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ failed: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const ok = await testLongPoll(vk, { fetchImpl: fetchImpl as typeof fetch });

    expect(ok).toBe(false);
    expect(vk.updates.start).not.toHaveBeenCalled();
    expect(vk.updates.stop).toHaveBeenCalledOnce();
  });

  it("returns a failure when SDK Long Poll start never settles", async () => {
    silenceConsole();
    const vk = makeVkClient({ start: () => new Promise<void>(() => undefined) });

    const ok = await testLongPoll(vk, {
      fetchImpl: successfulLongPollFetch() as typeof fetch,
      startTimeoutMs: 5,
      stopTimeoutMs: 5,
    });

    expect(ok).toBe(false);
    expect(vk.updates.stop).toHaveBeenCalledOnce();
  });

  it("returns a failure when SDK Long Poll stop fails", async () => {
    silenceConsole();
    const vk = makeVkClient({ stop: async () => Promise.reject(new Error("stop failed")) });

    const ok = await testLongPoll(vk, {
      fetchImpl: successfulLongPollFetch() as typeof fetch,
    });

    expect(ok).toBe(false);
  });

  it("rejects an invalid VK_TEST_PEER_ID without calling messages.send", async () => {
    silenceConsole();
    const vk = makeVkClient();

    const ok = await testSendMessage(vk, "not-a-number");

    expect(ok).toBe(false);
    expect(vk.api.messages.send).not.toHaveBeenCalled();
  });

  it("returns success only after a valid a_check and SDK start/stop", async () => {
    silenceConsole();
    const vk = makeVkClient();
    const fetchImpl = successfulLongPollFetch();

    const exitCode = await runVkConnectionSmoke({
      token: "test-token",
      testPeerId: "42",
      client: vk,
      longPoll: { fetchImpl: fetchImpl as typeof fetch },
    });

    expect(exitCode).toBe(0);
    expect(vk.api.groups.getLongPollServer).toHaveBeenCalledWith({ group_id: 1 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(vk.updates.start).toHaveBeenCalledOnce();
    expect(vk.updates.stop).toHaveBeenCalledOnce();
  });
});
