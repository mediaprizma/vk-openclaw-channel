import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { vkPlugin } from "./src/channel.js";
import { setVkRuntime } from "./src/runtime.js";
import {
  getVkClientSession,
  rememberVkMasterQuestion,
} from "./src/master-routing.js";
import { resolveVkAccount } from "./src/accounts.js";
import type { CoreConfig } from "./src/types.js";

export { vkPlugin } from "./src/channel.js";
export { setVkRuntime } from "./src/runtime.js";

const CHANNEL_ID = "vk-openclaw-channel";

function configuredMasterVkId(cfg: CoreConfig, accountId?: string): number | undefined {
  const account = resolveVkAccount({ cfg, accountId });
  const raw = account.config.masterVkId;
  if (raw === undefined) return undefined;
  const id = Number(String(raw).trim());
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function numericVkTarget(target: string): number | undefined {
  const normalized = target.trim().replace(/^vk:(?:user:)?/i, "");
  const id = Number(normalized);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export default defineChannelPluginEntry({
  id: "vk-openclaw-channel",
  name: "VK OpenClaw Channel",
  description: "Канал OpenClaw для сообществ ВКонтакте.",
  plugin: vkPlugin as ChannelPlugin,
  setRuntime: setVkRuntime,
  registerFull: (api) => {
    api.on("message_received", async (event, ctx) => {
      if (ctx.channelId !== CHANNEL_ID || !ctx.sessionKey || !ctx.accountId) return;
      const masterId = configuredMasterVkId(api.config as CoreConfig, ctx.accountId);
      const peerId = numericVkTarget(event.from);
      const senderId = Number(event.senderId);
      if (masterId !== undefined && (senderId === masterId || peerId === masterId)) return;
      if (peerId === undefined || peerId >= 2_000_000_000) return;

      await rememberVkClientSession({
        accountId: ctx.accountId,
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        clientPeerId: peerId,
        clientTarget: `vk:${peerId}`,
        updatedAt: Date.now(),
      });
    });

    api.on("message_sent", async (event, ctx) => {
      if (
        ctx.channelId !== CHANNEL_ID ||
        !ctx.accountId ||
        !ctx.sessionKey ||
        !event.success ||
        !event.messageId
      ) {
        return;
      }

      const masterId = configuredMasterVkId(api.config as CoreConfig, ctx.accountId);
      if (masterId === undefined || numericVkTarget(event.to) !== masterId) return;

      const client = await getVkClientSession(ctx.sessionKey);
      if (!client) {
        api.logger.warn(
          `VK master routing: outbound message ${event.messageId} has no client-session binding for session ${ctx.sessionKey}`,
        );
        return;
      }

      await rememberVkMasterQuestion({
        messageId: event.messageId,
        accountId: ctx.accountId,
        sessionKey: ctx.sessionKey,
        agentId: client.agentId ?? ctx.agentId,
        clientPeerId: client.clientPeerId,
        clientTarget: client.clientTarget,
        createdAt: Date.now(),
      });

      api.logger.info(
        `VK master routing: message ${event.messageId} -> client ${client.clientPeerId} session ${ctx.sessionKey}`,
      );
    });
  },
});
