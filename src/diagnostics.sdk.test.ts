import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The same redaction contract as `diagnostics.test.ts`, but through the real
 * `openclaw/plugin-sdk/logging-core` instead of a test double: a double can only
 * promise what the author remembered to write into it. The `openclaw` peer is
 * optional, so this file skips itself where it is not installed and runs in
 * CI's runtime-compatibility job, which installs the host.
 */
// Resolved through Node first and imported only when present: Vite treats a
// missing optional peer as a stub that throws on import, and that failure is
// not a rejection this file could catch — it failed the whole suite in the CI
// job that runs without the host. The specifier is a variable so that Vite's
// import analysis leaves the import to Node.
const LOGGING_CORE = "openclaw/plugin-sdk/logging-core";
const require = createRequire(import.meta.url);
const sdkInstalled = (() => {
  try {
    require.resolve(LOGGING_CORE);
    return true;
  } catch {
    return false;
  }
})();
const sdk: typeof import("openclaw/plugin-sdk/logging-core") | null = sdkInstalled
  ? await import(/* @vite-ignore */ LOGGING_CORE)
  : null;
// The module under test imports the SDK statically, so it is loaded only once
// the SDK is known to be there — otherwise its own import is what fails.
const diag: typeof import("./diagnostics.js") | null = sdkInstalled
  ? await import("./diagnostics.js")
  : null;

const mockLogger = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
const mockRuntime = vi.hoisted(() => ({
  config: { current: vi.fn().mockReturnValue({}) },
  logging: { getChildLogger: vi.fn().mockReturnValue(mockLogger) },
}));

vi.mock("./runtime.js", () => ({
  getVkRuntime: () => mockRuntime,
  setVkRuntime: vi.fn(),
  tryGetVkRuntime: () => mockRuntime,
}));

function lastFields(spy: typeof mockLogger.info): Record<string, unknown> {
  const [, fields] = spy.mock.calls.at(-1) ?? [];
  return (fields ?? {}) as Record<string, unknown>;
}

describe.skipIf(!sdk || !diag)("VK diagnostics through the real SDK redactor", () => {
  beforeEach(() => {
    mockLogger.info.mockReset();
    mockLogger.error.mockReset();
    delete process.env.VK_DIAG_LEVEL;
  });

  it("hashes identifiers with the core's sha256 prefix", () => {
    process.env.VK_DIAG_LEVEL = "redacted";
    diag!.vkDiag("send text", { to: "12324712", peerId: 12324712 });
    const fields = lastFields(mockLogger.info);
    expect(fields.to).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(fields.peerId).toBe(fields.to);
    expect(fields.to).toBe(sdk!.redactIdentifier("12324712"));
  });

  it("keeps the review's two inputs out of a failure logged at off", () => {
    diag!.vkDiagFailure(
      "tts failed",
      Object.assign(new Error("ENOENT: open '/данные/клиент/запись.wav'"), { code: "ENOENT" }),
    );
    diag!.vkDiagFailure("tts failed", new Error("failed to read data:audio/wav;base64,SGVsbG8="));
    const out = JSON.stringify(mockLogger.error.mock.calls.map((call) => call[1]));
    expect(out).not.toContain("данные");
    expect(out).not.toContain("SGVsbG8");
    expect(out).toContain('"errno":"ENOENT"');
  });

  it("strips what the core covers and what it does not from a failure at full", () => {
    // `api_key=…` is the core's; the access token in the query string, the bare
    // VK token and the data URI payload are the plugin's own — the real core
    // leaves all three untouched, which is why the double cannot stand in for it.
    process.env.VK_DIAG_LEVEL = "full";
    diag!.vkDiagFailure(
      "vk upload failed",
      new Error(
        "GET https://api.vk.com/method/photos.save?access_token=vk1.a.SECRET-TOKEN-VALUE&v=5.199 " +
          "with api_key=sk-abcdefghijklmnopqrstuvwxyz0123456789 " +
          "for vk1.a.AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 " +
          "after data:image/jpeg;base64,/9j/4AAQSkZJRg==",
      ),
    );
    const reason = String(lastFields(mockLogger.error).reason);
    expect(reason).toContain("https://api.vk.com/method/photos.save?access_token=<redacted>&v=5.199");
    expect(reason).not.toContain("SECRET-TOKEN-VALUE");
    expect(reason).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(reason).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
    expect(reason).not.toContain("/9j/4AAQ");
    expect(reason).toMatch(/ after <data URI cut, \d+ chars>$/);
  });

  it("strips VK's one-time keys from a failed upload's address at full, and leaves plain text alone", () => {
    // The review's input: node-fetch repeats the request address in its error,
    // and an upload server address carries `hash` and `rhash`.
    process.env.VK_DIAG_LEVEL = "full";
    diag!.vkDiagFailure(
      "vk upload failed",
      Object.assign(
        new Error(
          "request to https://pu.vk.com/c1/upload.php?act=do_add&mid=1&gid=2&hash=SYNTHETIC_HASH&rhash=SYNTHETIC_RHASH&api=1 failed, reason: socket hang up",
        ),
        { name: "FetchError", code: "ECONNRESET" },
      ),
    );
    const reason = String(lastFields(mockLogger.error).reason);
    expect(reason).toContain("hash=<redacted>&rhash=<redacted>&api=1 failed, reason: socket hang up");
    expect(reason).not.toContain("SYNTHETIC");

    diag!.vkDiagFailure("vk upload failed", new Error("socket hang up after 3 attempts"));
    expect(lastFields(mockLogger.error).reason).toBe("socket hang up after 3 attempts");

    // A document link's download key and a signed link's signature, on the
    // oldest core too, whose redactor leaves `sig` alone.
    diag!.vkDiagFailure(
      "vk upload failed",
      new Error("GET https://vk.com/doc1_2?hash=SYNTHETIC_H&dl=SYNTHETIC_DL and https://cdn.example/a?sig=SYNTHETIC_SIG"),
    );
    expect(String(lastFields(mockLogger.error).reason)).not.toContain("SYNTHETIC");
  });

  it("strips the same keys from an error for a plain log line, at every level", () => {
    // `vk final reply failed: …` goes to runtime.error whatever the level, and a
    // failed upload's error repeats the upload server address.
    const error = Object.assign(
      new Error("request to https://pu.vk.com/c1/upload.php?act=do_add&hash=SYNTHETIC_HASH&rhash=SYNTHETIC_RHASH failed"),
      { name: "FetchError" },
    );
    for (const level of ["off", "full"]) {
      process.env.VK_DIAG_LEVEL = level;
      const text = diag!.redactVkErrorText(error);
      expect(text).toContain("FetchError: request to https://pu.vk.com/c1/upload.php?act=do_add&hash=<redacted>");
      expect(text).not.toContain("SYNTHETIC");
    }
    expect(diag!.redactVkErrorText(new Error("delivery failed"))).toBe("Error: delivery failed");
  });

  it("keeps a failed upload's answer to its keys, code and flags at off", () => {
    // Failures are logged at every level; the upload server's answer text may
    // carry a path or a file token and is kept for `full` only.
    diag!.vkDiagFailure("vk upload failed", Object.assign(new Error("file is undefined"), { code: 100 }), {
      elapsedMs: 2100,
      uploadPost: "answered",
      uploadKeys: ["error", "error_descr"],
      uploadHasPayload: false,
      uploadError: "ERR_UPLOAD_FILE",
      uploadAnswer: '{"error":"ERR_UPLOAD_FILE","error_descr":"refused for /данные/клиент"}',
    });
    const fields = lastFields(mockLogger.error);
    expect(fields).toMatchObject({
      vkCode: 100,
      elapsedMs: 2100,
      uploadPost: "answered",
      uploadKeys: ["error", "error_descr"],
      uploadHasPayload: false,
      uploadError: "ERR_UPLOAD_FILE",
      uploadAnswer: "<text>",
    });
    expect(JSON.stringify(fields)).not.toContain("данные");
  });

  it("keeps a data URI with a percent-encoded parameter out of the log at full", () => {
    // The review's input: the old pattern did not match this header, and the
    // real redactor let the whole URI through.
    process.env.VK_DIAG_LEVEL = "full";
    const uri = "data:audio/wav;name=voice%20note.wav;base64,SGVsbG8=";
    diag!.vkDiag("send media", { source: uri, note: `failed to read ${uri}` });
    diag!.vkDiagFailure("tts failed", new Error(`failed to read ${uri}`), { inline: uri });
    const calls = [...mockLogger.info.mock.calls, ...mockLogger.error.mock.calls];
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls.map((call) => call[1]))).not.toContain("SGVsbG8");
    expect(lastFields(mockLogger.info).source).toBe("data (audio/wav, name=voice%20note.wav, 8 chars)");
    expect(lastFields(mockLogger.error).reason).toBe(
      `failed to read <data URI cut, ${uri.length} chars>`,
    );
  });

  it("keeps a download failure's response body and escaped addresses out at full", () => {
    // The review's input: the core's media fetcher appends the response body to
    // an HTTP error, a JSON body escapes the slashes, and the real redactor let
    // both keys through.
    process.env.VK_DIAG_LEVEL = "full";
    const body = '{"url":"https:\\/\\/vk.com\\/doc123_456?hash=SYNTHETIC_KEY&dl=SYNTHETIC_DL"}';
    const failure = (message: string) =>
      Object.assign(new Error(message), { name: "MediaFetchError", code: "http_error" });
    const withBody = diag!.describeVkDownloadFailure(
      "https://vk.com/doc123_456?hash=A",
      failure(`Failed to fetch media from https://vk.com/doc123_456?hash=A: HTTP 403; body: ${body}`),
    );
    const escaped = diag!.describeVkDownloadFailure(
      "https://vk.com/doc123_456?hash=A",
      failure("fetch failed for https:\\/\\/vk.com\\/doc123_456?hash=SYNTHETIC_KEY&dl=SYNTHETIC_DL"),
    );
    expect(withBody).toContain(`HTTP 403; body: <${body.length} chars>`);
    expect(escaped).toContain("https:\\/\\/vk.com\\/doc123_456?…");
    for (const line of [withBody, escaped]) {
      expect(line).not.toContain("SYNTHETIC");
      expect(line).not.toContain("hash=A");
    }
  });
});
