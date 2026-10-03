# VK diagnostics levels

The VK channel can describe what it does with an attachment — which stage it
reached, what VK answered, how many attempts it took — without writing names,
paths or message contents to the log. How much it says is one channel-wide
level.

All log excerpts below are illustrative and contain no real identifiers, paths,
or URLs.

## Levels

| level | contents |
|---|---|
| `off` (default) | failures only, by error class and codes |
| `redacted` | progress in safe fields, identifiers hashed for correlation |
| `full` | the same plus names: paths, URLs, peer ids |

`redacted` is the level meant for day-to-day use on a channel shared with
others. `full` is for an operator looking into their own deployment, where the
names are theirs to see.

## Configuration

```json
{ "channels": { "vk": { "diagnostics": { "level": "redacted" } } } }
```

- **Channel-wide.** One level applies to every account of the channel.
  `channels.vk.accounts.<id>.diagnostics` is rejected — by the plugin manifest
  schema that `openclaw config validate` checks, and by the plugin's own config
  schema — rather than accepted and ignored.
- **Read on every call**, so a config edit takes effect without restarting the
  gateway.
- **`VK_DIAG_LEVEL`** in the gateway environment overrides the config, for a
  quick look on a running process.
- **An unrecognised value resolves to `off`**, for the environment override too:
  a set but invalid `VK_DIAG_LEVEL` does not fall through to a `full` configured
  in the file.

Output goes through the gateway's structured logger
(`runtime.logging.getChildLogger()` with the `vk-diag` module binding), so it
inherits the gateway's levels, formatting, rotation and file permissions. The
channel has no log file of its own; filter the gateway feed by the module
binding instead.

## What reaches the log below `full`

The rule is an allowlist by field name and value type. Nothing in it depends on
recognising what a string contains, so a path shape the code has never seen
still cannot reach the log.

| what | at `off` / `redacted` |
|---|---|
| identifier fields (`to`, `peerId`, `messageId`, …) and any id-shaped name (`peer_id`, `userId`, `groupId`, …) | hashed with `redactIdentifier` from the SDK |
| counters (`textLen`, `bytes`, `index`, `total`, `attempt`, `vkCode`, names ending in `Ms`, `Count`, `Size`, …) | as they are |
| any other number | the constant `<number>` |
| booleans, `null` | as they are |
| token fields (`kind`, `mime`, `stage`, `errorName`, `errno`) | kept only if the value looks like a token |
| source fields (`source`, `mediaUrl`, `url`, `path`, …) | replaced by the kind: `local` / `remote` / `data` |
| any other string, error messages included | the constant `<text>` |
| an `Error` | its class, numeric code and `errno`-style code; never its message |
| buffers, typed arrays, a serialized `{ type: "Buffer", data }` | the constant `buffer` |

Keys of nested fields and event names are text too: one that does not look like
a name in code becomes `<key>` or `<event>`.

Identifiers survive as hashes, not as names: `redactIdentifier` gives a stable
`sha256:…` prefix, so two failed sends to different recipients stay
distinguishable without naming anyone. This is the core's own convention; the
bundled Discord plugin redacts the same way.

## Attachment contents never reach the log

At `full` either:

- A data URI under a source field is replaced by a description —
  `data (audio/wav, name=voice%20note.wav, 8 chars)`; the name is shown only when
  it is plainly a file name.
- In any other text, everything from the first data URI on is cut and replaced by
  its length: `failed to read <data URI cut, 52 chars>`. The payload is not picked
  out of the URI — its forms are too many — so the text after it goes too. Which
  spellings start a data URI, and why prose that merely mentions `data:` is left
  alone, is listed at `DATA_URI_START_RE` in `src/diagnostics.ts`.
- Only the start of a text is looked at: as much as the length cap lets through,
  plus a margin for a secret straddling it. Attachment bytes that reach a text
  with no data URI around them are not recognised.
- The core's secret redactor runs over the rest, plus a pass of the channel's own
  for what it does not cover: checked against the real `plugin-sdk/logging-core`,
  it leaves a credential in a URL's query string (`?access_token=…`) and a bare VK
  token (`vk1.a.…`) as they are, and both can appear in an error thrown by vk-io.

## When `full` is worth turning on

The safe fields are enough to **detect** a delivery problem. They are often not
enough to **reproduce** one.

**Identical safe fields, different causes.** A remote attachment rejected by VK
logs this at `redacted`:

```
vk upload failed  kind=photo source=remote mime=image/jpeg bytes=182034 attempt=3
                  errorName=APIError vkCode=100
```

An expired signed URL, a host VK's fetchers cannot reach, and a URL that serves
an HTML error page with an image content type all produce that exact line. Each
has a different fix, and only the URL separates them.

**Silent wrong-attachment delivery.** Every safe field looks healthy:

```
send payload   media=1 mediaRefs=[<text>] textLen=412
vk upload ok   kind=photo source=local mime=image/jpeg bytes=177065 attempt=1
media sent     index=1 total=1 messageId=sha256:9f2c1ab04e77
```

…and the recipient still receives the previous render, because the send used a
stale path produced elsewhere. Only the path shows it.

**Correlation across subsystems.** When one component writes a file and the
channel sends it, the file name is the only key the two logs share.

## Safeguards

- **Off by default**, and off after an unrecognised value.
- **Never implicit.** Nothing raises the level automatically — not an error, a
  retry or a stall.
- **Operator-scoped.** Turning it on needs write access to the gateway config or
  its environment — the same trust boundary that already holds the group access
  token.
- **Failures stay minimal.** They are logged even at `off`, but only by class and
  codes — `errorName=APIError vkCode=100`, `errno=ENOENT` — never by message.
- **Tested against the real redactor.** `src/diagnostics.test.ts` runs with a test
  double for the SDK, because the `openclaw` peer is optional;
  `src/diagnostics.sdk.test.ts` repeats the contract through the real
  `plugin-sdk/logging-core` in the CI job that installs the host.
- **Not for hosted deployments.** An operator running the gateway on behalf of
  other people should leave the default.
