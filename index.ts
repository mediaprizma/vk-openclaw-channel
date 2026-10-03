import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { vkPlugin } from "./src/channel.js";
import { setVkRuntime } from "./src/runtime.js";

export { vkPlugin } from "./src/channel.js";
export { setVkRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "vk",
  name: "VK OpenClaw Channel",
  description: "Канал OpenClaw для сообществ ВКонтакте.",
  plugin: vkPlugin as ChannelPlugin,
  setRuntime: setVkRuntime,
});
