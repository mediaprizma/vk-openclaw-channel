/**
 * VK channel diagnostics: three levels instead of on/off.
 *
 * The old `VK_VOICE_DEBUG_LOG` was all-or-nothing and wrote whole paths, URLs
 * and peer identifiers to a file, so it could not be turned on for a live
 * channel. Dropping the switch would be wrong too: it is what revealed why
 * pictures arrived as grey file cards. So the switch stayed and became a level:
 *
 * | level      | what is visible |
 * |------------|-----------------|
 * | `off`      | nothing (default); failures are still logged — see below |
 * | `redacted` | progress without names: attachment kind, size, MIME, attempt, code |
 * | `full`     | the same plus paths, URLs, file names and identifiers |
 *
 * **Redaction is a property of this channel, not caller discipline.** Callers
 * pass one field map and never split it into allowed and forbidden: `redactField`
 * below decides, from the name of the field and the type of the value.
 *
 * **Below `full`, nothing free-form survives.** The previous version tried to
 * recognise paths and addresses inside text and strip them, and that is a losing
 * game: a Unicode path, a relative one, a data URI in the middle of an error
 * message — each escaped one pattern or another. So the rule is an allowlist:
 * identifiers are hashed (by name, numbers and strings alike), counters and
 * booleans pass, any other number becomes `<number>`, a handful of named fields
 * may carry a short token (`kind=photo`, `mime=image/jpeg`), a source field is
 * replaced by its kind (`local` / `remote` / `data`), and any other string —
 * an error message included — becomes the constant `<text>`. An error is
 * reported by its class, its numeric code and its `errno`-style code, which is
 * enough to tell an `ENOENT` from an `APIError 100` without carrying the path
 * or the request parameters along.
 *
 * At `full`, text is kept but not attachment contents: a data URI under a
 * source field is replaced by its type, name and size, and any other text is
 * cut at its first data URI — the payload is not picked out, it goes with the
 * rest of the text. The core's secret redactor runs over what is left, plus
 * our own pass for what it does not cover — a VK access token, bare or in a
 * URL's query string.
 *
 * Failures are always logged, even at `off`: they are redacted as at
 * `redacted`, and a channel that stays silent about an error is the very trap
 * that once turned a VK breakage into half a day of searching.
 *
 * Where it goes: the core logger (`runtime.logging.getChildLogger`) — it knows
 * levels, rotation and file permissions, and needs no sink of its own.
 */
import { redactIdentifier, redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import type { RuntimeLogger } from "openclaw/plugin-sdk/core";
import { tryGetVkRuntime } from "./runtime.js";
import { VK_DIAG_LEVELS, type VkDiagLevel } from "./types.js";
import { readVkErrorCode } from "./vk-errors.js";

export type { VkDiagLevel };

const VK_DIAG_LOG_BINDINGS = { module: "vk-diag" } as const;

/** Even at `full`, a text field is capped: the log is for reading, not for carrying a payload away. */
const MAX_FULL_TEXT = 2_000;

/**
 * Fields whose value names a peer or a message. Below `full` they are hashed
 * rather than dropped: two failed sends to different people stay distinguishable
 * in the feed, while the log never says who they are.
 */
const IDENTIFIER_FIELDS = new Set([
  "to",
  "peerId",
  "chatId",
  "senderId",
  "messageId",
  "conversationMessageId",
  "cmid",
  "accountId",
]);

/**
 * A name that says "this is an id", whatever the casing: VK hands ids out in
 * snake_case (`peer_id`, `from_id`), callers write `userId` or `groupId`. Such a
 * number is hashed like the listed identifiers — the list alone let them through.
 */
const IDENTIFIER_KEY_RE = /(?:^id|_id|[a-z0-9]Id|ID)$/;

/**
 * Numbers that are measurements, not names: sizes, counts, positions, durations,
 * codes. Below `full` only these pass as they are; any other number is replaced,
 * the same allowlist rule strings follow.
 */
const COUNTER_FIELDS = new Set([
  "vkCode",
  "attempt",
  "attempts",
  "index",
  "total",
  "count",
  "media",
  "bytes",
  "size",
  "length",
  "limit",
  "segments",
  "chunks",
  "items",
]);
const COUNTER_KEY_RE = /(?:Len|Length|Count|Bytes|Size|Ms|Index|Total|Attempts?)$/;
const NUMBER_PLACEHOLDER = "<number>";

/**
 * Fields that may carry a short token below `full`: an attachment kind, a MIME
 * type, a stage name, an error class. The value still has to look like a token;
 * a path or a sentence under one of these names is replaced like any other text.
 */
const TOKEN_FIELDS = new Set([
  "kind",
  "mime",
  "stage",
  "phase",
  "mode",
  "outcome",
  "status",
  "errorName",
  "errno",
  // The upload server's answer (send.ts): how far the POST got
  // (`not-started` / `failed` / `answered`), its keys (field names), its error a
  // code such as `ERR_UPLOAD_FILE`, its type `object` / `string`. The answer's
  // text itself (`uploadAnswer`) is not here and stays `full`-only.
  "uploadPost",
  "uploadKeys",
  "uploadError",
  "uploadAnswerType",
]);
const TOKEN_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MIME_RE = /^[a-z]+\/[a-z0-9.+-]{1,63}$/i;

/** Fields whose value is where an attachment comes from; only the kind of source is kept. */
const SOURCE_FIELDS = new Set([
  "source",
  "uploadSource",
  "mediaUrl",
  "url",
  "path",
  "file",
  "dir",
  "remote",
  "inline",
]);

/** What replaces a string that is neither an identifier, a token nor a source. */
const TEXT_PLACEHOLDER = "<text>";

/** A slash as a URI writes it, or escaped: PHP's JSON, an HTML entity, a percent escape. */
const SLASH = String.raw`(?:\x5c?\/|&#x0*2f;|&#0*47;|%2f)`;

/**
 * Where a data URI begins in a text. Everything from there on is cut, not
 * carved: picking the payload out with patterns kept missing forms —
 * percent-encoded base64, the tail of a wrapped payload, an SVG with spaces —
 * while the text before the URI is the part that says what went wrong.
 *
 * Each form is told by its first few characters, so the search is linear and
 * there is no header to scan:
 * - `data:` and a MIME type (`x-custom/y` included), whatever follows. The
 *   slash may come escaped: PHP's JSON — and so VK's API — writes it as a
 *   backslash and a slash, and HTML and URLs escape it too.
 * - `data:`, whitespace and a registered top-level type, where `data` starts a
 *   word: a decoder trims the whitespace, while `Failed to read data: I/O
 *   error` or `metadata: image/jpeg` is prose.
 * - `data:` and `;` or `,` — a URI with no type, with parameters or without.
 * - A `;base64,` marker, whatever precedes it.
 * - `data` with its colon escaped: percent-encoded once or more (`%3A`,
 *   `%253A`), as an HTML entity (`&#58;`, `&#x3a;`), or as a JSON/JS escape
 *   (a backslash and `u003a` or `x3a`).
 * Prose such as `Invalid data: expected number` or `state={data:1}` matches
 * none of these.
 */
const DATA_URI_START_RE = new RegExp(
  [
    String.raw`(?:data:[a-z][a-z0-9.+-]*|(?<![a-z0-9])data:\s{1,16}(?:application|audio|font|image|message|model|multipart|text|video|x-[a-z0-9.+-]+))${SLASH}[a-z0-9.+-]`,
    String.raw`data:\s{0,16}[;,]`,
    ";base64,",
    String.raw`data(?:%(?:25)*3a|&#0*58;|&#x0*3a;|\x5c(?:u003a|x3a))`,
  ].join("|"),
  "i",
);

/**
 * What the core's redactor does not cover, checked against the real
 * `plugin-sdk/logging-core` rather than assumed: it targets `KEY=value`
 * assignments, JSON secret fields and CLI flags, and leaves a credential in a
 * URL's query string (`?access_token=…`) and a bare VK token (`vk1.a.…`) as they
 * are. Both can appear in an error thrown by vk-io, so they are stripped here.
 * VK's one-time keys count too: an upload server address carries `hash` and
 * `rhash`, and node-fetch repeats the address in a failed request's message;
 * a document link carries `hash` and `dl`. `sig` is cut by the core's redactor
 * from 2026.9 on but not by 2026.8, the oldest core this plugin supports.
 */
const VK_TOKEN_RE = /\bvk1\.a\.[A-Za-z0-9_-]{8,}/g;
const CREDENTIAL_QUERY_RE =
  /([?&](?:access_token|token|secret|client_secret|api_key|apikey|key|password|passwd|hash|rhash|dl|sig)=)[^&\s'"<>]+/gi;

function isVkDiagLevel(value: unknown): value is VkDiagLevel {
  return VK_DIAG_LEVELS.includes(value as VkDiagLevel);
}

/**
 * The level is read on every call rather than once at startup: the core picks
 * up config edits live, and it must be possible to turn diagnostics on without
 * restarting the gateway. The core keeps the config snapshot in memory, so this
 * is a field read, not a disk read.
 *
 * The environment variable overrides the config — it is what you use to switch
 * diagnostics on for a couple of minutes without touching `openclaw.json`. It
 * fails closed: a set but unrecognised value resolves to `off` and does not
 * fall through to whatever the config says, so a typo in the override can never
 * widen what is logged.
 *
 * Only `channels.vk.diagnostics` is read: the level is channel-wide, and the
 * config schema accepts it at channel level only, so an account cannot ask for a
 * level it would not get.
 */
export function resolveVkDiagLevel(): VkDiagLevel {
  const rawEnv = process.env.VK_DIAG_LEVEL;
  if (rawEnv !== undefined && rawEnv.trim() !== "") {
    const fromEnv = rawEnv.trim().toLowerCase();
    return isVkDiagLevel(fromEnv) ? fromEnv : "off";
  }
  try {
    const channels = tryGetVkRuntime()?.config.current()?.channels as
      | { vk?: { diagnostics?: { level?: unknown } } }
      | undefined;
    const fromConfig = channels?.vk?.diagnostics?.level;
    if (isVkDiagLevel(fromConfig)) {
      return fromConfig;
    }
  } catch {
    /* diagnostics must never break a send */
  }
  return "off";
}

/**
 * The kind of source instead of the source itself: it shows where an attachment
 * came from, but not which one or whose. `file://` is a local file too, so it
 * maps to `local`: the set of kinds deliberately matches the review's list
 * (`local` / `remote` / `data`).
 */
export function describeVkSourceKind(
  source: unknown,
): "local" | "remote" | "data" | "buffer" | "none" {
  if (source === undefined || source === null) {
    return "none";
  }
  if (typeof source !== "string") {
    return "buffer";
  }
  if (/^\s*data:/i.test(source)) {
    return "data";
  }
  if (/^\s*https?:\/\//i.test(source)) {
    return "remote";
  }
  return "local";
}

/** A parameter value that is plainly a file name. */
const FILE_NAME_RE = /^[\w.%@+ -]{1,128}$/;

/**
 * A data URI under a source field, at `full`: what it is, not the URI. A source
 * field names an attachment, and for a data URI the attachment is the value
 * itself — so it is described like a buffer would be, by type, name and size.
 */
function describeDataSource(value: string): string {
  // The caller has checked that the value opens with `data:`, after any whitespace.
  const from = value.search(/data:/i) + "data:".length;
  const comma = value.indexOf(",", from);
  if (comma === -1) {
    return "data";
  }
  // The header is read no further than a header sensibly goes: the value may be
  // megabytes of audio, and only its length is needed from the rest.
  const header = value.slice(from, Math.min(comma, from + 1_024));
  const type = (header.split(";")[0] ?? "").trim();
  const mime = MIME_RE.test(type) ? type : "";
  // A parameter is written by whoever built the URI: only a plain file name is
  // shown, and it goes through the same redactors as any text at `full`.
  const rawName = /;name=([^;]{1,128})(?=;|$)/i.exec(header)?.[1];
  const name =
    rawName && FILE_NAME_RE.test(rawName) ? redactSecrets(rawName) : "";
  const size = `${value.length - comma - 1} chars`;
  return `data (${[mime, name ? `name=${name}` : "", size].filter(Boolean).join(", ")})`;
}

/** A name as code writes one: what a key or an event name may be below `full`. */
const LABEL_RE = /^[A-Za-z][A-Za-z0-9 _.,:-]{0,79}$/;
const KEY_PLACEHOLDER = "<key>";
const EVENT_PLACEHOLDER = "<event>";

/**
 * A key of a nested field or an event name. Both come from code today, but reach
 * the log as text all the same: at `full` they get what any text gets; below
 * it, one that does not look like a name in code is replaced — a path or a peer
 * id as a map key is exactly the free text the lower levels keep out.
 */
function labelFor(text: string, level: VkDiagLevel, placeholder: string): string {
  if (level === "full") {
    return fullText(text);
  }
  return LABEL_RE.test(text) ? text : placeholder;
}

/** Credentials the core's patterns leave alone; see `VK_TOKEN_RE`. */
function stripVkCredentials(text: string): string {
  return text
    .replace(CREDENTIAL_QUERY_RE, "$1<redacted>")
    .replace(VK_TOKEN_RE, "vk1.a.<redacted>");
}

/** Secrets out of a text: what the core's redactor covers, then what it does not. */
function redactSecrets(text: string): string {
  return stripVkCredentials(redactSensitiveText(text));
}

/**
 * Room past the cap for a secret that straddles it to be redacted whole. A
 * secret cut by the edge of what is looked at is too short for any pattern to
 * know, so the end of the redacted text within this margin is never shown.
 */
const FULL_TEXT_MARGIN = 2_048;

/**
 * How much of a text is looked at, at `full`: nothing past the cap reaches the
 * log, and scanning a multi-megabyte error body would hold the send path for
 * nothing.
 */
const FULL_TEXT_SCAN = MAX_FULL_TEXT + FULL_TEXT_MARGIN;

/**
 * Text at `full`: no attachment contents, no secrets, bounded length. The cut
 * mark goes after the cap, so a long text still says that a URI was cut.
 */
function fullText(value: string): string {
  const head = value.slice(0, FULL_TEXT_SCAN);
  const start = head.search(DATA_URI_START_RE);
  const text = redactSecrets(start === -1 ? head : head.slice(0, start));
  // Only a text that runs past what was looked at ends at the window's edge.
  const edge = start === -1 && value.length > head.length ? text.length - FULL_TEXT_MARGIN : text.length;
  const shown = Math.max(0, Math.min(MAX_FULL_TEXT, edge));
  const capped = shown < text.length ? `${text.slice(0, shown)}…` : text;
  return start === -1 ? capped : `${capped}<data URI cut, ${value.length - start} chars>`;
}

/** Text below `full`: only what is an identifier, a token or a source kind, by field name. */
function redactedText(key: string, value: string): string {
  if (IDENTIFIER_FIELDS.has(key) || IDENTIFIER_KEY_RE.test(key)) {
    return redactIdentifier(value);
  }
  if (SOURCE_FIELDS.has(key)) {
    return describeVkSourceKind(value);
  }
  if (TOKEN_FIELDS.has(key) && (key === "mime" ? MIME_RE : TOKEN_RE).test(value)) {
    return value;
  }
  // A data URI or an address under any other name still says what kind of
  // thing it was; everything else is text, and text is not metadata.
  const kind = describeVkSourceKind(value);
  return kind === "data" || kind === "remote" ? kind : TEXT_PLACEHOLDER;
}

/** An error by class and codes only — what is safe to log at every level. */
type VkErrorSummary = {
  errorName: string;
  // Not `code`: the host logger masks any field named exactly `code` as a
  // likely auth code, so a VK error code logged under that name reads `***`.
  vkCode: number | null;
  errno?: string;
};

function summarizeError(error: unknown): VkErrorSummary {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  const rawName =
    record && typeof record.name === "string"
      ? record.name
      : error === undefined || error === null
        ? "none"
        : typeof error;
  const summary: VkErrorSummary = {
    errorName: TOKEN_RE.test(rawName) ? rawName : "Error",
    vkCode: readVkErrorCode(error) ?? null,
  };
  // Node's system errors carry `code: "ENOENT"`; vk-io's carry a number, read above.
  if (record && typeof record.code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(record.code)) {
    summary.errno = record.code;
  }
  return summary;
}

/**
 * The error's raw text, for `full` only — every field vk-io puts it in, minus
 * the class name, which is its own field. Not sanitised here: it goes through
 * `redactField` like any other string, exactly once.
 */
function errorText(error: unknown): string {
  if (!error || typeof error !== "object") {
    return typeof error === "string" ? error : String(error ?? "");
  }
  const record = error as Record<string, unknown>;
  return [record.message, record.description]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
}

/**
 * The single place that decides what reaches the log. Every field passes through
 * here, so a new call site cannot forget to redact its value.
 */
function redactField(key: string, value: unknown, level: VkDiagLevel, depth = 0): unknown {
  // The depth guard comes BEFORE the array branch: otherwise a self-referencing
  // array recurses forever and takes the send down with a stack overflow —
  // `vkDiag` is called straight from the send path and is wrapped in nothing.
  if (depth >= 4) {
    return "[deeper than 4 levels]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactField(key, item, level, depth + 1));
  }
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    // Attachment content is never written, at any level.
    return "buffer";
  }
  if (value instanceof Error) {
    // An Error as a field value used to serialize to `{}` — the class was lost.
    const summary = summarizeError(value);
    return level === "full" ? `${summary.errorName}: ${fullText(errorText(value))}` : summary;
  }
  if (value && typeof value === "object") {
    // Nested objects used to reach the log AS IS, bypassing redaction: any
    // object field holding a path or a peer id was a leak. We walk them
    // recursively and cap the depth so a cycle cannot run away.
    // `JSON.parse(JSON.stringify(buffer))` is `{ type: "Buffer", data: [...] }`:
    // no longer a Buffer, still the attachment.
    const record = value as { type?: unknown; data?: unknown };
    if (record.type === "Buffer" && Array.isArray(record.data)) {
      return "buffer";
    }
    if (value instanceof Map || value instanceof Set) {
      return `[${value.constructor.name}, ${value.size}]`;
    }
    const out: Record<string, unknown> = {};
    const nextNumber = new Map<string, number>();
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        // A key is text too: a map keyed by path, peer or source would carry
        // exactly what the value next to it is kept from saying. Two keys that
        // come out the same stay apart.
        // Numbering resumes where it stopped for the label: many keys that all
        // become `<key>` would otherwise rescan `#2…#n` each time.
        const label = labelFor(k, level, KEY_PLACEHOLDER);
        let n = nextNumber.get(label) ?? 1;
        let key = n === 1 ? label : `${label} #${n}`;
        while (Object.prototype.hasOwnProperty.call(out, key)) {
          n += 1;
          key = `${label} #${n}`;
        }
        nextNumber.set(label, n + 1);
        out[key] = redactField(k, v, level, depth + 1);
      }
    }
    return out;
  }
  // Identifiers also arrive as numbers (`peerId: 12324712`), not only strings,
  // so they must be checked BEFORE non-strings are returned early — otherwise a
  // peer id reaches the log raw.
  if (typeof value === "number" || typeof value === "bigint") {
    if (level === "full") {
      return typeof value === "bigint" ? value.toString() : value;
    }
    if (IDENTIFIER_FIELDS.has(key) || IDENTIFIER_KEY_RE.test(key)) {
      return redactIdentifier(String(value));
    }
    if (COUNTER_FIELDS.has(key) || COUNTER_KEY_RE.test(key)) {
      return typeof value === "bigint" ? value.toString() : value;
    }
    return NUMBER_PLACEHOLDER;
  }
  if (typeof value === "boolean" || value === null) {
    return value;
  }
  if (typeof value !== "string") {
    // Functions, symbols: nothing to log, and nothing that could leak.
    return `[${typeof value}]`;
  }
  if (level !== "full") {
    return redactedText(key, value);
  }
  // A data URI under a source field is the attachment itself: describe it, do
  // not keep it.
  return SOURCE_FIELDS.has(key) && describeVkSourceKind(value) === "data"
    ? describeDataSource(value)
    : fullText(value);
}

function redactFields(
  fields: Record<string, unknown>,
  level: VkDiagLevel,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    out[key] = redactField(key, value, level);
  }
  return out;
}

/**
 * The core does not cache child loggers inside `getChildLogger` — it clones the
 * settings and builds an object on every call. We keep one per process and
 * rebuild it only when the runtime itself changes (plugin re-registration).
 */
let cachedLogger: { runtime: unknown; logger: RuntimeLogger } | null = null;

function diagLogger(runtime: NonNullable<ReturnType<typeof tryGetVkRuntime>>): RuntimeLogger {
  if (cachedLogger?.runtime !== runtime) {
    cachedLogger = { runtime, logger: runtime.logging.getChildLogger(VK_DIAG_LOG_BINDINGS) };
  }
  return cachedLogger.logger;
}

function emit(event: string, fields: Record<string, unknown>, failure: boolean): void {
  const runtime = tryGetVkRuntime();
  if (!runtime) {
    // Before the plugin is registered there is nowhere to write, and nothing
    // here may throw on the send path.
    return;
  }
  const logger = diagLogger(runtime);
  if (failure) {
    logger.error(event, fields);
  } else {
    logger.info(event, fields);
  }
}

/**
 * An error for a plain log line written at every level (`runtime.error`), not
 * through the diagnostics: its text without secrets and attachment contents,
 * the way `full` shows it. A failed upload's error repeats the upload server
 * address with its one-time keys.
 */
export function redactVkErrorText(error: unknown): string {
  return fullText(String(error));
}

/**
 * An identifier for a regular log line.
 *
 * Not everything in the plugin goes through `vkDiag`: some messages are not
 * diagnostics but operational warnings ("message dropped by policy", "failed to
 * mark as read"), and they must always be visible. Printing a raw peer id in
 * them is not acceptable, and dropping it would make lines impossible to
 * correlate. So they are hashed the same way diagnostic fields are; at `full`
 * they are left as they are.
 */
export function redactVkId(value: string | number | undefined | null): string {
  if (value === undefined || value === null || value === "") {
    return "-";
  }
  return resolveVkDiagLevel() === "full" ? String(value) : redactIdentifier(String(value));
}

/** An address without its query and fragment: VK puts one-time keys there (`hash=`, `dl=`). */
function withoutQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : `${url.slice(0, cut)}?…`;
}

/**
 * Every address in a text, the same way: an error may name a redirect target too.
 * JSON-escaped slashes (`https:\/\/`) count as well.
 */
const URL_QUERY_RE = /\b(https?:(?:\\?\/){2}[^\s?#'"<>]+)[?#][^\s'"<>]*/gi;

/**
 * The response body the core's media fetcher appends to an HTTP error. It is the
 * remote server's text: an address in it may be escaped or encoded in any way,
 * so it is logged by length only.
 */
const RESPONSE_BODY_RE = /; body: ([\s\S]*)$/;

/**
 * A download failure for a regular log line, like `redactVkId` for an id. The
 * address is only its kind below `full`, and at `full` it loses its query; the
 * error is its class and codes below `full`, and at `full` its text with the
 * address in it cut the same way (the core's fetch errors repeat the address)
 * and the server's response body reduced to its length.
 */
export function describeVkDownloadFailure(url: string, error: unknown): string {
  const summary = summarizeError(error);
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  if (resolveVkDiagLevel() !== "full") {
    // The core's media errors carry a word code (`http_error`, `fetch_failed`).
    const code =
      typeof record?.code === "string" && TOKEN_RE.test(record.code) ? record.code : undefined;
    const codes = [summary.errorName, summary.vkCode ?? undefined, code ?? summary.errno]
      .filter((part) => part !== undefined)
      .join(" ");
    return `${describeVkSourceKind(url)}: ${codes}`;
  }
  const text = errorText(error)
    .replace(RESPONSE_BODY_RE, (_match, body: string) => `; body: <${body.length} chars>`)
    .replace(URL_QUERY_RE, "$1?…");
  return `${withoutQuery(url)}: ${summary.errorName}: ${fullText(text)}`;
}

/** Progress. Silent at `off`; fields are redacted according to the level. */
export function vkDiag(event: string, fields: Record<string, unknown> = {}): void {
  const level = resolveVkDiagLevel();
  if (level === "off") {
    return;
  }
  emit(labelFor(event, level, EVENT_PLACEHOLDER), redactFields(fields, level), false);
}

/**
 * A failure. Logged at every level, including `off`, and always through
 * `logger.error`. The error is summarised here rather than at the call sites:
 * its class, numeric code and `errno`-style code at every level, its text only
 * at `full` — the text is where paths and request parameters travel.
 */
export function vkDiagFailure(
  event: string,
  error: unknown,
  fields: Record<string, unknown> = {},
): void {
  const level = resolveVkDiagLevel();
  const effective: VkDiagLevel = level === "off" ? "redacted" : level;
  const summary = summarizeError(error);
  emit(
    labelFor(event, effective, EVENT_PLACEHOLDER),
    redactFields(
      {
        ...fields,
        ...summary,
        ...(effective === "full" ? { reason: errorText(error) } : {}),
      },
      effective,
    ),
    true,
  );
}
