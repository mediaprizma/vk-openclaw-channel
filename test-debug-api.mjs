import { VK } from "vk-io";

const TOKEN = process.env.VK_TOKEN?.trim();
const TIMEOUT_MS = 5000;

if (!TOKEN) {
  console.error("Set a non-empty VK_TOKEN environment variable");
  process.exit(1);
}

const vk = new VK({ token: TOKEN, apiLimit: 20 });

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout(promise, timeoutMs, label, onTimeout) {
  let timeout;
  const timeoutPromise = new Promise((_resolve, reject) => {
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

async function runRawProbeDiagnostic() {
  const body = new URLSearchParams({
    v: "5.199",
    access_token: TOKEN,
  });
  const controller = new AbortController();
  let response;
  try {
    response = await withTimeout(
      fetch("https://api.vk.com/method/groups.getById", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: controller.signal,
      }),
      TIMEOUT_MS,
      "Raw VK probe request",
      () => controller.abort(),
    );
  } catch (error) {
    if (errorMessage(error).startsWith("Raw VK probe request timed out")) {
      throw error;
    }
    throw new Error("Raw VK probe request failed");
  }

  if (!response.ok) {
    throw new Error(`Raw VK probe returned HTTP ${response.status}`);
  }

  let data;
  try {
    data = await withTimeout(
      response.json(),
      TIMEOUT_MS,
      "Raw VK probe response body",
      () => controller.abort(),
    );
  } catch (error) {
    if (errorMessage(error).startsWith("Raw VK probe response body timed out")) {
      throw error;
    }
    throw new Error("Raw VK probe returned an unreadable response body");
  }

  if (data?.error) {
    throw new Error(
      `Raw VK API error ${data.error.error_code ?? "unknown"}: ${data.error.error_msg ?? "unknown error"}`,
    );
  }
  if (!data?.response?.groups?.[0]) {
    throw new Error("Raw VK probe returned no community");
  }
}

async function runBotsLongPollRoundTrip(groupId) {
  const connection = await withTimeout(
    vk.api.groups.getLongPollServer({ group_id: groupId }),
    TIMEOUT_MS,
    "groups.getLongPollServer",
  );
  if (!connection?.server || !connection?.key || connection.ts === undefined) {
    throw new Error("groups.getLongPollServer returned incomplete connection data");
  }

  // VK requires the short-lived Long Poll key in this a_check query. Keep the
  // URL in memory only and never include it in logs or propagated errors.
  const requestUrl = new URL(connection.server);
  requestUrl.search = new URLSearchParams({
    act: "a_check",
    key: String(connection.key),
    ts: String(connection.ts),
    wait: "1",
  }).toString();

  const controller = new AbortController();
  let response;
  try {
    response = await withTimeout(
      fetch(requestUrl, { signal: controller.signal }),
      TIMEOUT_MS,
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

  let payload;
  try {
    payload = await withTimeout(
      response.json(),
      TIMEOUT_MS,
      "Bots Long Poll a_check response body",
      () => controller.abort(),
    );
  } catch (error) {
    if (errorMessage(error).startsWith("Bots Long Poll a_check response body timed out")) {
      throw error;
    }
    throw new Error("Bots Long Poll a_check returned an unreadable response body");
  }

  if (payload?.failed !== undefined) {
    throw new Error(`Bots Long Poll a_check returned failed=${String(payload.failed)}`);
  }
  if (
    (typeof payload?.ts !== "string" && typeof payload?.ts !== "number") ||
    !Array.isArray(payload?.updates)
  ) {
    throw new Error("Bots Long Poll a_check returned an invalid response");
  }
}

async function main() {
  let probeOk = false;
  let longPollOk = false;
  let groupId;

  console.log("=== Test 1: groups.getById ===");
  try {
    const response = await withTimeout(
      vk.api.groups.getById({}),
      TIMEOUT_MS,
      "groups.getById probe",
    );
    const group = response?.groups?.[0];
    if (!group) {
      throw new Error("groups.getById returned no community");
    }
    groupId = group.id;
    console.log(`Community: ${group.name ?? group.screen_name ?? group.id}`);
    console.log("PASS: groups.getById");
    probeOk = true;
  } catch (error) {
    console.error("FAIL: groups.getById:", errorMessage(error));
    console.log("\n=== Diagnostic fallback: raw fetch ===");
    try {
      await runRawProbeDiagnostic();
      console.log("Raw diagnostic succeeded; the SDK probe is still marked as failed.");
    } catch (fallbackError) {
      console.error("Raw diagnostic failed:", errorMessage(fallbackError));
    }
  }

  console.log("\n=== Test 2: Bots Long Poll a_check and SDK lifecycle ===");
  vk.updates.on("message_new", (ctx) => {
    console.log(`Received a message from ${ctx.senderId}`);
  });

  if (!groupId) {
    console.error("FAIL: Long Poll: no community id from the SDK probe");
  } else {
    try {
      await runBotsLongPollRoundTrip(groupId);
      console.log("Bots Long Poll a_check round-trip succeeded");

      await withTimeout(vk.updates.start(), TIMEOUT_MS, "VK SDK Long Poll start");
      console.log("VK SDK Long Poll started successfully");
      longPollOk = true;
    } catch (error) {
      console.error("FAIL: Long Poll:", errorMessage(error));
    } finally {
      try {
        await withTimeout(vk.updates.stop(), TIMEOUT_MS, "VK SDK Long Poll stop");
        console.log("VK SDK Long Poll stopped successfully");
      } catch (stopError) {
        console.error("FAIL: Long Poll stop:", errorMessage(stopError));
        longPollOk = false;
      }
    }
  }

  if (!probeOk || !longPollOk) {
    console.error("\nDebug API smoke test failed.");
    return 1;
  }

  console.log("PASS: Bots Long Poll a_check and SDK lifecycle");
  console.log("\nAll debug API checks passed.");
  return 0;
}

try {
  process.exit(await main());
} catch (error) {
  console.error("Unexpected debug API smoke failure:", errorMessage(error));
  process.exit(1);
}
