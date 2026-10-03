# VK Channel for OpenClaw

VK channel integration for [OpenClaw](https://github.com/openclaw/openclaw).

This project connects an OpenClaw agent to a VK community through the VK Bots Long Poll API. It supports private conversations, group chats, media delivery, keyboards, reactions, progress messages and multiple VK accounts.

> This repository is an independent development project maintained by **mediaprizma**.

## Requirements

- OpenClaw **2026.9.x or newer**
- Node.js version supported by the installed OpenClaw release
- A VK community with a community access token
- VK Bots Long Poll API enabled

## Features

- VK private messages
- VK group conversations
- Separate OpenClaw sessions for different conversations
- Multiple VK community accounts
- Access policies for private and group messages
- Per-conversation system prompts
- Markdown-compatible message formatting
- Images, documents and audio
- VK keyboards and callback events
- Message reactions
- Typing indicators
- Message editing and deletion
- Progress/streaming-style status messages
- OpenClaw secret references for VK tokens

The channel uses the existing OpenClaw channel runtime rather than implementing a separate agent or message-processing system.

## VK community setup

In your VK community:

1. Open **Community management → Messages** and enable community messages.
2. Open **API usage → Access keys** and create a community token.
3. Grant the permissions required by the features you plan to use:
   - **Messages**
   - **Community management**
   - **Photos** — for outgoing images
   - **Documents** — for files and voice messages
4. Open **API usage → Bots Long Poll API** and enable it.
5. Enable the event types required by your OpenClaw configuration.
6. If the bot will be used in group conversations, allow the community to be added to chats.

Keep the community token private. Do not commit it to this repository.

## Installation

For a published package:

```bash
openclaw plugins install <package-name> --force --accept-capabilities
```

For local development:

```bash
git clone https://github.com/mediaprizma/vk-openclaw-channel.git
cd vk-openclaw-channel
npm install
npm run build
openclaw plugins install --link ./dist/index.js
```

Then verify the plugin:

```bash
openclaw plugins info vk --json
openclaw channels status --json --probe
```

Restart the gateway after configuration changes when required:

```bash
openclaw gateway restart
```

## Configuration

Add the VK channel to `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "vk": {
      "enabled": true,
      "token": "<VK_COMMUNITY_TOKEN>",
      "dmPolicy": "pairing"
    }
  }
}
```

### Access policies

Private messages can use:

- `pairing`
- `allowlist`
- `open`
- `disabled`

Example:

```json
{
  "channels": {
    "vk": {
      "enabled": true,
      "token": "<VK_COMMUNITY_TOKEN>",
      "dmPolicy": "allowlist",
      "allowFrom": [123456789]
    }
  }
}
```

For group conversations, use `groupPolicy` and `groupAllowFrom`.

### Per-conversation settings

Individual group conversations can have their own settings:

```json
{
  "channels": {
    "vk": {
      "groups": {
        "2000000123": {
          "enabled": true,
          "allowFrom": [123456789],
          "requireMention": true,
          "systemPrompt": "Отвечай кратко и по существу."
        }
      }
    }
  }
}
```

### Multiple VK communities

Multiple VK community tokens can be configured as separate accounts:

```json
{
  "channels": {
    "vk": {
      "accounts": {
        "sales": {
          "enabled": true,
          "token": "<SALES_TOKEN>",
          "dmPolicy": "allowlist",
          "allowFrom": ["*"]
        },
        "support": {
          "enabled": true,
          "tokenFile": "/etc/openclaw/vk-support.token",
          "dmPolicy": "pairing"
        }
      }
    }
  }
}
```

## Token security

A token may be supplied through:

- `token`
- `tokenFile`
- `VK_TOKEN`
- an OpenClaw SecretRef

Example SecretRef:

```json
{
  "channels": {
    "vk": {
      "token": {
        "source": "env",
        "provider": "default",
        "id": "VK_TOKEN"
      }
    }
  }
}
```

For production installations, prefer a secret provider or a protected token file instead of storing credentials directly in the OpenClaw configuration.

## Media

The channel supports outgoing:

- images
- documents
- audio
- voice messages

VK community tokens need the corresponding `photos` and `docs` permissions for these operations.

If an image URL cannot be downloaded directly by VK, the channel can fall back to downloading the media through the OpenClaw host and uploading it to VK.

## Formatting

OpenClaw responses can use Markdown-style formatting supported by VK's `format_data`, including:

- **bold**
- *italic*
- ***bold italic***
- [links](https://example.com)

Unsupported Markdown is sent as ordinary text.

## Development

Install dependencies:

```bash
npm install
```

Build:

```bash
npm run build
```

Run tests:

```bash
npm test
```

Type checking and project-specific validation should be run before publishing changes.

## Troubleshooting

Check the channel:

```bash
openclaw channels status --json --probe
```

Check plugin information:

```bash
openclaw plugins info vk --json
```

If the channel is configured but not running, inspect the OpenClaw gateway logs and verify:

1. the VK token is valid;
2. Bots Long Poll API is enabled;
3. required VK event types are enabled;
4. the plugin is enabled;
5. the configured access policy allows the sender;
6. the gateway has been restarted after relevant configuration changes.

For media errors involving access scopes, recreate the community token with the required VK permissions and restart the OpenClaw gateway.

## Roadmap

The repository is intended to evolve beyond basic VK message transport.

Planned work includes:

- processing comments on VK wall posts;
- processing comments on VK Clips;
- passing post/clip context to the OpenClaw agent;
- AI-assisted comment analysis;
- configurable automatic replies;
- comment deduplication and loop protection;
- moderation and filtering rules;
- rate limiting for automated replies.

These features will be implemented directly in this project rather than depending on the architecture of the original upstream implementation.

## License

See [LICENSE](LICENSE).
