import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { CoreConfig } from "./types.js";

const ERROR_MESSAGE = "VK runtime not initialized - plugin not registered";

const store = createPluginRuntimeStore<PluginRuntime>(ERROR_MESSAGE);

/**
 * Last runtime this process registered, kept beside the SDK store.
 *
 * The SDK resolves its slot from the *invoking* managed instance: inside a host
 * call into the plugin it is that instance's slot, outside any such call it is
 * the store's standalone slot. Registration happens inside an invocation, so a
 * callback the host runs on its own — the progress callbacks it invokes from the
 * agent lane, above all — reads the standalone slot and finds nothing. That is
 * how `VK runtime not initialized` appeared in the middle of a working turn:
 * the step draft failed on every tool step while the same account
 * kept delivering the answer and its media fine.
 *
 * One VK plugin instance runs per process, so mirroring the registered runtime
 * here is safe; `clearVkRuntime` drops it together with the store's slot.
 */
let registeredRuntime: PluginRuntime | null = null;

export function setVkRuntime(next: PluginRuntime): void {
  registeredRuntime = next;
  store.setRuntime(next);
}

export function clearVkRuntime(): void {
  registeredRuntime = null;
  store.clearRuntime?.();
}

export function tryGetVkRuntime(): PluginRuntime | null {
  return store.tryGetRuntime?.() ?? registeredRuntime;
}

export function getVkRuntime(): PluginRuntime {
  const runtime = tryGetVkRuntime();
  if (!runtime) {
    throw new Error(ERROR_MESSAGE);
  }
  return runtime;
}

export function readVkRuntimeConfig(runtime: PluginRuntime = getVkRuntime()): CoreConfig {
  if (typeof runtime.config.current !== "function") {
    throw new Error("OpenClaw runtime does not expose config.current()");
  }
  return runtime.config.current() as unknown as CoreConfig;
}
