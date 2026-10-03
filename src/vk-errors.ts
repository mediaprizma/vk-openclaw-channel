/**
 * Reading VK API failures.
 *
 * A module of its own because two callers need it: the send path (to decide
 * whether to retry) and diagnostics (what to write to the log). One reading keeps
 * them from disagreeing — e.g. on `description`, which is where vk-io keeps
 * permission failure text.
 */

/** Failure code: vk-io puts it either in `code` or in `error_code`. */
export function readVkErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  if (typeof record.code === "number") {
    return record.code;
  }
  if (typeof record.error_code === "number") {
    return record.error_code;
  }
  return undefined;
}

/** Failure text, joined from every field the vk-io layers put it in. */
export function readVkErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }
  const record = error as Record<string, unknown>;
  return [
    typeof record.message === "string" ? record.message : "",
    typeof record.name === "string" ? record.name : "",
    typeof record.description === "string" ? record.description : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Operating-system error code from the failure or anything it wraps: `ECONNRESET`,
 * `EPIPE`, `ETIMEDOUT`. vk-io buries these under `cause`, sometimes two levels deep,
 * so a truncated upload arrives looking exactly like a refusal from VK.
 *
 * Only an uppercase `errno`-shaped token is returned. It is a safe field by the
 * channel's logging rules — a class of failure, not its text — while `message`
 * carries paths and request parameters and must not be logged below `full`.
 */
export function readVkErrorSystemCode(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== "object" || depth > 4) {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  const code = record.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(code)) {
    return code;
  }
  // `AggregateError` from a happy-eyeballs connect keeps the real codes in `errors`.
  if (Array.isArray(record.errors)) {
    for (const nested of record.errors) {
      const found = readVkErrorSystemCode(nested, depth + 1);
      if (found) {
        return found;
      }
    }
  }
  return readVkErrorSystemCode(record.cause, depth + 1);
}
