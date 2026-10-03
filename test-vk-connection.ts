/**
 * Quick smoke test for VK bot connection.
 * Usage: node test-vk-connection.ts
 *
 * Tests:
 * 1. Token validation via groups.getById
 * 2. Sending a message (if VK_TEST_PEER_ID is set)
 * 3. A real Bots Long Poll a_check round-trip plus SDK start/stop
 */

import { pathToFileURL } from "node:url";
import { VK, getRandomId } from "vk-io";

type LongPollTestOptions = {
  apiTimeoutMs?: number;
  networkTimeoutMs?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readConfirmedMessageId(response: unknown): number | null {
  if (!Array.isArray(response) || response.length === 0) {
    return null;
  }
  for (const item of response) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    for (const key of ["message_id", "conversation_message_id"] as const) {
      const value = record[key];
      if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
        return value;
      }
    }
  }
  return null;
}

export async function testProbe(vk: VK, timeoutMs = 5000): Promise<boolean> {
  console.log("--- Test 1: Probe (groups.getById) ---");
  try {
    const response = await withTimeout(
      vk.api.groups.getById({}),
      timeoutMs,
      "groups.getById probe",
    );
    const group = response.groups[0];
    if (!group) {
      throw new Error("groups.getById returned no community");
    }
    console.log(`  Group ID: ${group.id}`);
    console.log(`  Group name: ${group.name}`);
    console.log(`  Screen name: ${group.screen_name}`);
    console.log("  PASS");
    return true;
  } catch (error) {
    console.error(`  FAIL: ${errorMessage(error)}`);
    return false;
  }
}

export async function testSendMessage(
  vk: VK,
  testPeerId?: string,
  timeoutMs = 5000,
): Promise<boolean> {
  if (!testPeerId) {
    console.log("--- Test 2: Send message (SKIPPED - set VK_TEST_PEER_ID) ---");
    return true;
  }

  const normalizedPeerId = testPeerId.trim();
  if (!/^[1-9]\d*$/.test(normalizedPeerId)) {
    console.error("--- Test 2: Send message ---");
    console.error("  FAIL: VK_TEST_PEER_ID must be a positive numeric VK user or peer ID");
    return false;
  }

  console.log(`--- Test 2: Send message to peer ${normalizedPeerId} ---`);
  try {
    const response = await withTimeout(
      vk.api.messages.send({
        peer_id: Number(normalizedPeerId),
        message: "OpenClaw VK plugin test message",
        random_id: getRandomId(),
      }),
      timeoutMs,
      "messages.send",
    );
    const messageId = readConfirmedMessageId(response);
    if (messageId === null) {
      throw new Error("messages.send returned no confirmed message id");
    }
    console.log(`  Message sent, ID: ${messageId}`);
    console.log("  PASS");
    return true;
  } catch (error) {
    console.error(`  FAIL: ${errorMessage(error)}`);
    return false;
  }
}

async function runBotsLongPollRoundTrip(
  vk: VK,
  options: Required<Pick<LongPollTestOptions, "apiTimeoutMs" | "networkTimeoutMs">> & {
    fetchImpl: typeof fetch;
  },
): Promise<void> {
  const groups = await withTimeout(
    vk.api.groups.getById({}),
    options.apiTimeoutMs,
    "Long Poll groups.getById",
  );
  const groupId = groups.groups[0]?.id;
  if (!groupId) {
    throw new Error("Long Poll probe returned no community id");
  }

  const longPollServer = await withTimeout(
    vk.api.groups.getLongPollServer({ group_id: groupId }),
    options.apiTimeoutMs,
    "groups.getLongPollServer",
  );
  if (!longPollServer.server || !longPollServer.key || longPollServer.ts === undefined) {
    throw new Error("groups.getLongPollServer returned incomplete connection data");
  }

  // VK requires its short-lived LP key in the a_check query. Keep this URL in
  // memory only; never print it or include it in an error message.
  const requestUrl = new URL(longPollServer.server);
  requestUrl.search = new URLSearchParams({
    act: "a_check",
    key: String(longPollServer.key),
    ts: String(longPollServer.ts),
    wait: "1",
  }).toString();

  const controller = new AbortController();
  let response: Response;
  try {
    response = await withTimeout(
      Promise.resolve().then(() => options.fetchImpl(requestUrl, { signal: controller.signal })),
      options.networkTimeoutMs,
      "Bots Long Poll a_check request",
      () => controller.abort(),
    );
  } catch (error) {
    if (errorMessage(error).startsWith("Bots Long Poll a_check request timed out")) {
      throw error;
    }
    throw new Error("Bots Long Poll a_check request failed");
  }
  if (!response.ok) {
    throw new Error(`Bots Long Poll a_check returned HTTP ${response.status}`);
  }

  let payload: { failed?: unknown; ts?: unknown; updates?: unknown };
  try {
    payload = (await withTimeout(
      response.json() as Promise<unknown>,
      options.networkTimeoutMs,
      "Bots Long Poll a_check response body",
      () => controller.abort(),
    )) as { failed?: unknown; ts?: unknown; updates?: unknown };
  } catch (error) {
    if (errorMessage(error).startsWith("Bots Long Poll a_check response body timed out")) {
      throw error;
    }
    throw new Error("Bots Long Poll a_check returned an unreadable response body");
  }
  if (payload.failed !== undefined) {
    throw new Error(`Bots Long Poll a_check returned failed=${String(payload.failed)}`);
  }
  if (
    (typeof payload.ts !== "string" && typeof payload.ts !== "number") ||
    !Array.isArray(payload.updates)
  ) {
    throw new Error("Bots Long Poll a_check returned an invalid response");
  }
}

export async function testLongPoll(vk: VK, options: LongPollTestOptions = {}): Promise<boolean> {
  const apiTimeoutMs = options.apiTimeoutMs ?? 5000;
  const networkTimeoutMs = options.networkTimeoutMs ?? 5000;
  const startTimeoutMs = options.startTimeoutMs ?? 5000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 5000;
  const fetchImpl = options.fetchImpl ?? fetch;
  console.log("--- Test 3: Bots Long Poll a_check and SDK lifecycle ---");
  let ok = false;
  let sdkStarted = false;

  vk.updates.on("message_new", (ctx) => {
    console.log(`  Received a message from ${ctx.senderId}`);
  });

  try {
    await runBotsLongPollRoundTrip(vk, { apiTimeoutMs, networkTimeoutMs, fetchImpl });
    console.log("  Bots Long Poll a_check round-trip succeeded");

    await withTimeout(vk.updates.start(), startTimeoutMs, "VK SDK Long Poll start");
    sdkStarted = true;
    console.log("  VK SDK Long Poll started successfully");
    ok = true;
  } catch (error) {
    console.error(`  FAIL: ${errorMessage(error)}`);
  } finally {
    try {
      await withTimeout(vk.updates.stop(), stopTimeoutMs, "VK SDK Long Poll stop");
      if (sdkStarted) {
        console.log("  VK SDK Long Poll stopped successfully");
      }
    } catch (error) {
      console.error(`  FAIL: ${errorMessage(error)}`);
      ok = false;
    }
  }

  if (ok) {
    console.log("  PASS");
  }
  return ok;
}

export async function runVkConnectionSmoke(params: {
  token?: string;
  testPeerId?: string;
  client?: VK;
  probeTimeoutMs?: number;
  sendTimeoutMs?: number;
  longPoll?: LongPollTestOptions;
} = {}): Promise<number> {
  const token = (params.token ?? process.env.VK_TOKEN ?? "").trim();
  const testPeerId = params.testPeerId ?? process.env.VK_TEST_PEER_ID;

  if (!token) {
    console.error("Set a non-empty VK_TOKEN environment variable");
    return 1;
  }

  const vk = params.client ?? new VK({ token, apiLimit: 20 });
  console.log("VK Bot Connection Test\n");

  const probeOk = await testProbe(vk, params.probeTimeoutMs);
  if (!probeOk) {
    console.log("\nProbe failed - check your token or network. Aborting.");
    return 1;
  }

  const sendOk = await testSendMessage(vk, testPeerId, params.sendTimeoutMs);
  const longPollOk = await testLongPoll(vk, params.longPoll);

  if (!sendOk || !longPollOk) {
    console.error("\nSmoke test failed.");
    return 1;
  }

  console.log("\nAll executed tests passed.");
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (import.meta.url === invokedPath) {
  runVkConnectionSmoke()
    .then((exitCode) => process.exit(exitCode))
    .catch((error) => {
      console.error(`\nUnexpected smoke test failure: ${errorMessage(error)}`);
      process.exit(1);
    });
}
