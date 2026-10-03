import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { vkPositiveSetting } from "./settings.js";

// ── Tunables (env-overridable) ──────────────────────────────────────────────

/**
 * Hard cap (ms) for a single VK voice message. VK rejects voice notes longer
 * than ~5 minutes; we leave a safety margin (4.5 min default).
 */
export function getVkAudioMessageMaxMs(): number {
  return vkPositiveSetting({ env: "VK_AUDIO_MESSAGE_MAX_MS", section: "audio", key: "maxVoiceMs", fallback: 270_000 });
}

/** Deadline for the whole split operation. */
function getAudioSplitDeadlineMs(): number {
  return vkPositiveSetting({ env: "VK_AUDIO_SPLIT_DEADLINE_MS", section: "audio", key: "splitDeadlineMs", fallback: 5 * 60 * 1000 });
}

/** Input file size ceiling: we do not split a gigabyte. */
function getAudioSplitMaxInputBytes(): number {
  return vkPositiveSetting({ env: "VK_AUDIO_SPLIT_MAX_INPUT_BYTES", section: "audio", key: "maxInputBytes", fallback: 512 * 1024 * 1024 });
}


/**
 * Margin used when PLANNING the cuts. `-c copy` cuts on key frames, so a
 * segment comes out longer than requested (measured: 10.000 s requested →
 * 10.020 s file). We compensate here rather than with a tolerance on the check:
 * a tolerance in seconds made the check toothless — a segment nearly two seconds
 * over the VK limit would pass it and be rejected at upload instead.
 */
const SEGMENT_PLANNING_MARGIN_MS = 250;

/** Segment count ceiling: nobody listens to that many voice messages in a row. */
function getAudioSplitMaxSegments(): number {
  return vkPositiveSetting({ env: "VK_AUDIO_SPLIT_MAX_SEGMENTS", section: "audio", key: "maxSegments", fallback: 12 });
}

function getAudioSplitTimeoutMs(): number {
  return vkPositiveSetting({ env: "VK_AUDIO_SPLIT_TIMEOUT_MS", section: "audio", key: "splitTimeoutMs", fallback: 120_000 });
}

function getFfprobeBin(): string {
  return process.env.FFPROBE_BIN?.trim() || "ffprobe";
}

function getFfmpegBin(): string {
  return process.env.FFMPEG_BIN?.trim() || "ffmpeg";
}


// ── Process helper ──────────────────────────────────────────────────────────

type ExecResult = { stdout: string; stderr: string };

/**
 * Runs ffmpeg/ffprobe with cancellation propagated.
 *
 * Without `signal` a gateway stop left ffmpeg running: the process lives on,
 * writes into /tmp and holds disk, with nobody left to collect its result.
 */
function isAbortError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    ((error as { name?: unknown }).name === "AbortError" ||
      (error as { code?: unknown }).code === "ABORT_ERR")
  );
}

function runProcess(
  bin: string,
  args: string[],
  signal?: AbortSignal,
): Promise<ExecResult> {
  // Checked up front: `execFile` only honours a signal that fires while the
  // process runs, and a signal that is already aborted must not start one.
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: getAudioSplitTimeoutMs(), maxBuffer: 32 * 1024 * 1024, signal },
      (error, stdout, stderr) => {
        if (error) {
          // Attach captured stderr for debugging but still reject.
          (error as Error & { stderr?: string }).stderr = String(stderr ?? "");
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

// ── Duration probe ──────────────────────────────────────────────────────────

/**
 * Returns container duration in milliseconds, or null if it could not be
 * determined (missing ffprobe, unreadable file, etc.). Never throws — except
 * when cancelled: an abort is not a measurement failure, and swallowing it
 * would let the caller carry on and upload after a stop.
 */
export async function probeAudioDurationMs(
  file: string,
  signal?: AbortSignal,
): Promise<number | null> {
  try {
    const { stdout } = await runProcess(getFfprobeBin(), [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      file,
    ], signal);
    const seconds = Number.parseFloat(stdout.trim());
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return null;
    }
    return Math.round(seconds * 1000);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return null;
  }
}

// ── Silence detection + cut-point selection ─────────────────────────────────

type SilenceWindow = { start: number; end: number };

/**
 * Parses `silence_start` / `silence_end` pairs (seconds) out of ffmpeg's
 * `silencedetect` stderr output.
 */
export function parseSilenceWindows(stderr: string): SilenceWindow[] {
  const windows: SilenceWindow[] = [];
  let pendingStart: number | null = null;
  const startRe = /silence_start:\s*([0-9]+(?:\.[0-9]+)?)/;
  const endRe = /silence_end:\s*([0-9]+(?:\.[0-9]+)?)/;

  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = startRe.exec(line);
    if (startMatch) {
      pendingStart = Number.parseFloat(startMatch[1] as string);
      continue;
    }
    const endMatch = endRe.exec(line);
    if (endMatch) {
      const end = Number.parseFloat(endMatch[1] as string);
      const start = pendingStart ?? Math.max(0, end);
      if (Number.isFinite(end)) {
        windows.push({ start: Number.isFinite(start) ? start : Math.max(0, end), end });
      }
      pendingStart = null;
    }
  }
  return windows;
}

/**
 * Greedily picks cut boundaries (in ms) so each segment is ≤ maxMs.
 * For each window we prefer the LAST silence boundary that still fits under
 * maxMs from the current segment start. The midpoint of a silence window is
 * used as the actual cut so the gap is split between both segments.
 * If no silence fits, we cut hard at maxMs.
 *
 * Returns ordered boundaries strictly between 0 and totalMs (exclusive).
 */
export function selectCutPointsMs(
  silenceWindows: SilenceWindow[],
  totalMs: number,
  maxMs: number,
): number[] {
  const boundaries: number[] = [];
  if (totalMs <= maxMs || maxMs <= 0) {
    return boundaries;
  }

  // Candidate cut points (ms): midpoint of each silence window, sorted.
  const candidates = silenceWindows
    .map((w) => Math.round(((w.start + w.end) / 2) * 1000))
    .filter((ms) => Number.isFinite(ms) && ms > 0 && ms < totalMs)
    .sort((a, b) => a - b);

  // Plan with a margin: stream copy moves a cut FORWARD to the nearest key
  // frame, so the target sits slightly below the limit — segments then fit by
  // construction and the check on the way out stays strict.
  const target = Math.max(1, maxMs - SEGMENT_PLANNING_MARGIN_MS);
  let segmentStart = 0;
  while (totalMs - segmentStart > maxMs) {
    const limit = segmentStart + target;
    // Last candidate strictly within (segmentStart, limit].
    let chosen: number | null = null;
    for (const candidate of candidates) {
      if (candidate <= segmentStart) {
        continue;
      }
      if (candidate <= limit) {
        chosen = candidate;
      } else {
        break;
      }
    }
    // `chosen` is strictly past `segmentStart` (candidates at or before it are
    // skipped above) and `limit` is `segmentStart + target` with `target >= 1`,
    // so the cut always advances.
    const cut = chosen ?? limit;
    boundaries.push(cut);
    segmentStart = cut;
  }
  return boundaries;
}

// ── Segment extraction ──────────────────────────────────────────────────────

/**
 * Extension of an audio file, defaulting to `.ogg`.
 *
 * Exported because the send path needs the same answer: it used to carry its own
 * copy of this rule plus a third, cruder variant (`endsWith(".wav") ? … : ".ogg"`),
 * and three answers to one question is how a segment ends up mislabelled.
 */
export function audioFileExtension(file: string): string {
  return extname(file) || ".ogg";
}

/**
 * Splits `file` at silence into ≤ maxMs segments. Returns absolute paths of the
 * produced temp files (in os.tmpdir()), or an empty array on any failure / when
 * no split is needed — its own deadline included; a cancellation through
 * `opts.signal` is rethrown instead, so the caller stops rather than falls
 * back. The caller is responsible for deleting the returned files AND their
 * parent directory (use `cleanupAudioSegments`).
 *
 * Segments keep the input container/codec via `-c copy` (stream copy). Stream
 * copy can only cut on keyframes, so the actual boundaries may drift slightly
 * from the requested cut points — acceptable for voice.
 */
export async function splitAudioAtSilence(
  file: string,
  maxMs: number,
  opts: {
    /** Already measured duration: the caller usually knows it, so we do not measure twice. */
    knownDurationMs?: number | null;
    /** A gateway stop must not leave ffmpeg running. */
    signal?: AbortSignal;
  } = {},
): Promise<string[]> {
  if (!file || maxMs <= 0) {
    return [];
  }

  // An overall deadline: splitting must not take longer than someone is willing
  // to wait for a voice message. Combined with the gateway's own cancellation.
  const deadline = AbortSignal.timeout(getAudioSplitDeadlineMs());
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, deadline])
    : deadline;

  try {
    return await splitUnderSignal(file, maxMs, opts, signal);
  } catch (error) {
    // The one place that tells the two aborts apart. Node reports the split's
    // own deadline as an `AbortError` too (`cause: TimeoutError`), and running
    // out of splitting budget is a failed split — the caller sends the original
    // as a document — so only the caller's signal makes an abort a stop. Every
    // stage below removes what it wrote before an abort escapes it.
    if (isAbortError(error) && opts.signal?.aborted !== true) {
      return [];
    }
    throw error;
  }
}

/** The split itself, under the combined signal: an abort escapes to the boundary above. */
async function splitUnderSignal(
  file: string,
  maxMs: number,
  opts: { knownDurationMs?: number | null },
  signal: AbortSignal,
): Promise<string[]> {
  // Input size ceiling: a gigabyte recording is not worth opening at all.
  // Failing to learn the size is no reason to refuse the split: ffmpeg will
  // stumble on a bad file anyway and the caller falls back normally.
  try {
    if ((await stat(file)).size > getAudioSplitMaxInputBytes()) {
      return [];
    }
  } catch {
    /* size unknown — carry on */
  }

  let totalMs: number | null;
  if (typeof opts.knownDurationMs === "number" && opts.knownDurationMs > 0) {
    totalMs = opts.knownDurationMs;
  } else {
    // Only an abort escapes the probe, and it must escape here too.
    totalMs = await probeAudioDurationMs(file, signal);
  }
  if (totalMs === null || totalMs <= maxMs) {
    return [];
  }
  // Early exit on a SINGLE knob: if the segment count is bound to exceed the
  // ceiling, splitting is pointless — and the expensive silence search is not
  // worth running (seconds wasted on a two-hour recording). The same guard used
  // to exist as a second, separate duration ceiling: two knobs for one thing,
  // kept consistent by hand.
  if (Math.ceil(totalMs / maxMs) > getAudioSplitMaxSegments()) {
    return [];
  }

  let silenceStderr = "";
  try {
    const result = await runProcess(getFfmpegBin(), [
      "-hide_banner",
      "-nostats",
      "-i",
      file,
      "-af",
      "silencedetect=noise=-30dB:d=0.4",
      "-f",
      "null",
      "-",
    ], signal);
    silenceStderr = result.stderr;
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    silenceStderr = String((error as { stderr?: string }).stderr ?? "");
  }

  const windows = parseSilenceWindows(silenceStderr);
  const cutPoints = selectCutPointsMs(windows, totalMs, maxMs);
  if (cutPoints.length === 0) {
    return [];
  }

  // Build [start, end) ranges in ms.
  const ranges: Array<{ start: number; end: number }> = [];
  let prev = 0;
  for (const cut of cutPoints) {
    ranges.push({ start: prev, end: cut });
    prev = cut;
  }
  ranges.push({ start: prev, end: totalMs });

  // No `< 2` check: an empty `cutPoints` returned above, and every cut adds a
  // range, so there are always at least two here.
  if (ranges.length > getAudioSplitMaxSegments()) {
    return [];
  }

  const ext = audioFileExtension(file);
  let dir: string;
  try {
    dir = await mkdtemp(join(tmpdir(), "vk-voice-"));
  } catch {
    return [];
  }

  const outputs: string[] = [];
  try {
    for (let index = 0; index < ranges.length; index += 1) {
      const range = ranges[index] as { start: number; end: number };
      const out = join(dir, `part-${String(index).padStart(3, "0")}${ext}`);
      const startSec = (range.start / 1000).toFixed(3);
      const args = [
        "-y",
        "-hide_banner",
        "-nostats",
        "-ss",
        startSec,
        "-i",
        file,
      ];
      // Last range runs to EOF; intermediate ranges get an explicit duration.
      if (index < ranges.length - 1) {
        const durSec = ((range.end - range.start) / 1000).toFixed(3);
        args.push("-t", durSec);
      }
      args.push("-c", "copy", out);
      await runProcess(getFfmpegBin(), args, signal);
      outputs.push(out);
    }
  } catch (error) {
    // Any extraction failure drops the whole directory: every segment lives
    // inside it, so cleaning files separately was redundant.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    if (isAbortError(error)) {
      throw error;
    }
    return [];
  }

  // Check what came out instead of trusting what was requested. Stream copy
  // only cuts on key frames, so a segment can end up longer than asked — and VK
  // then rejects it exactly as it rejected the original. Returning a split that
  // is known to be unusable is worse than not splitting at all: at least the
  // caller falls back to sending a document.
  // Independent probes: awaiting them in turn added (N-1) round trips for
  // nothing. A segment whose duration cannot be read is unverified, and an
  // unverified segment is not a bounded one: the split is discarded and the
  // caller sends a document instead of gambling on a voice message.
  let actualDurations: Array<number | null>;
  try {
    actualDurations = await Promise.all(outputs.map((out) => probeAudioDurationMs(out, signal)));
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  if (actualDurations.some((actual) => actual === null || actual > maxMs)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return [];
  }
  return outputs;
}

/**
 * Removes generated segment temp files and their parent dir. Never throws.
 */
export async function cleanupAudioSegments(files: readonly string[]): Promise<void> {
  const dirs = new Set<string>();
  for (const file of files) {
    if (!file) {
      continue;
    }
    // A bare filename has no separator, and `slice(0, -1)` would then yield the
    // name minus its last character — a path this function goes on to remove
    // recursively. Only a real parent directory is collected.
    const separator = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
    if (separator > 0) {
      dirs.add(file.slice(0, separator));
    }
    await rm(file, { force: true }).catch(() => {});
  }
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
