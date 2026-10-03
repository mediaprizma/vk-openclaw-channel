import { defineSetupPluginEntry } from "openclaw/plugin-sdk/core";
import { vkSetupPlugin } from "./src/channel.setup.js";

export { vkSetupPlugin } from "./src/channel.setup.js";

export default defineSetupPluginEntry(vkSetupPlugin);
