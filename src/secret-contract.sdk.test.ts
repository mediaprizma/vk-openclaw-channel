import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * End to end on the real SDK: a SecretRef in `channels.vk-openclaw-channel` is collected by the
 * contract, resolved and applied by the core's own secret runtime, and reaches
 * `resolveVkAccount` as a string. Where the host cannot resolve it, the account
 * resolver must survive the object the core leaves in place.
 *
 * Like `diagnostics.sdk.test.ts`, this skips itself where the optional
 * `openclaw` peer is not installed.
 */
const SECRET_REF_RUNTIME = "openclaw/plugin-sdk/secret-ref-runtime";
const require = createRequire(import.meta.url);
const sdkInstalled = (() => {
  try {
    require.resolve(SECRET_REF_RUNTIME);
    return true;
  } catch {
    return false;
  }
})();
const core: typeof import("openclaw/plugin-sdk/secret-ref-runtime") | null = sdkInstalled
  ? await import(/* @vite-ignore */ SECRET_REF_RUNTIME)
  : null;
const contract: typeof import("./secret-contract.js") | null = sdkInstalled
  ? await import("./secret-contract.js")
  : null;
const accounts: typeof import("./accounts.js") | null = sdkInstalled ? await import("./accounts.js") : null;

describe.skipIf(!sdkInstalled)("SecretRef token on the real SDK", () => {
  let savedVkToken: string | undefined;
  beforeEach(() => {
    savedVkToken = process.env.VK_TOKEN;
    delete process.env.VK_TOKEN;
  });
  afterEach(() => {
    if (savedVkToken !== undefined) process.env.VK_TOKEN = savedVkToken;
  });

  async function resolveThroughCore(config: { channels: { "vk-openclaw-channel": Record<string, unknown> } }, env: NodeJS.ProcessEnv) {
    const context = core!.createResolverContext({ sourceConfig: structuredClone(config) as never, env });
    contract!.collectRuntimeConfigAssignments({ config, context });
    const resolved = await core!.resolveSecretRefValues(
      context.assignments.map((a) => a.ref),
      { config: config as never, env },
    );
    core!.applyResolvedAssignments({ assignments: context.assignments, resolved });
    return context;
  }

  it("resolves the channel and account references into strings", async () => {
    const config = {
      channels: {
        "vk-openclaw-channel": {
          token: { source: "env", provider: "default", id: "VK_ROOT_TOKEN" },
          accounts: { work: { token: { source: "env", provider: "default", id: "VK_WORK_TOKEN" } } },
        },
      },
    };
    const context = await resolveThroughCore(config, { VK_ROOT_TOKEN: " root-secret ", VK_WORK_TOKEN: "work-secret" });

    expect(context.assignments.map((a) => [a.path, a.ownerId])).toEqual([
      ["channels.vk-openclaw-channel.token", "vk-openclaw-channel:default"],
      ["channels.vk-openclaw-channel.accounts.work.token", "vk-openclaw-channel:work"],
    ]);
    expect(accounts!.resolveVkAccount({ cfg: config as never })).toMatchObject({ token: "root-secret", tokenSource: "config" });
    expect(accounts!.resolveVkAccount({ cfg: config as never, accountId: "work" }).token).toBe("work-secret");
  });

  it("leaves a plain string token alone", async () => {
    const config = { channels: { "vk-openclaw-channel": { token: "plain" } } };
    const context = await resolveThroughCore(config, {});
    expect(context.assignments).toEqual([]);
  });

  it("a tokenFile wins, so an unresolvable reference beside it does not fail the snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-token-file-"));
    try {
      const tokenFile = join(dir, "vk-token");
      writeFileSync(tokenFile, "file-secret\n", { mode: 0o600 });
      const config = {
        channels: { "vk-openclaw-channel": { tokenFile, token: { source: "env", provider: "default", id: "VK_MISSING_TOKEN" } } },
      };
      const context = await resolveThroughCore(config, {});
      expect(context.assignments).toEqual([]);
      expect(accounts!.resolveVkAccount({ cfg: config as never })).toMatchObject({
        token: "file-secret",
        tokenSource: "tokenFile",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unresolvable reference fails in the core; the plugin names it instead of crashing", async () => {
    const config = { channels: { "vk-openclaw-channel": { token: { source: "env", provider: "default", id: "VK_MISSING_TOKEN" } } } };
    await expect(resolveThroughCore(config, {})).rejects.toThrow(/VK_MISSING_TOKEN/);
    // This is what the core leaves for an owner in cold degradation: the reference itself.
    const account = accounts!.resolveVkAccount({ cfg: config as never });
    expect(account).toMatchObject({ token: "", tokenUnresolved: "env:default:VK_MISSING_TOKEN" });
  });
});
