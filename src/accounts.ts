import {
  DEFAULT_ACCOUNT_ID,
  tryReadSecretFileSync,
} from "openclaw/plugin-sdk/core";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { ResolvedVkAccount, VkAccountConfig, VkConfig, CoreConfig } from "./types.js";
export type { ResolvedVkAccount } from "./types.js";

function mergeVkAccountConfig(cfg: CoreConfig, accountId: string): VkAccountConfig {
  const vkConfig = (cfg.channels?.vk ?? {}) as VkConfig;
  const base: VkAccountConfig = {
    name: vkConfig.name,
    enabled: vkConfig.enabled,
    token: vkConfig.token,
    tokenFile: vkConfig.tokenFile,
    dmPolicy: vkConfig.dmPolicy,
    allowFrom: vkConfig.allowFrom,
    defaultTo: vkConfig.defaultTo,
    groupPolicy: vkConfig.groupPolicy,
    groupAllowFrom: vkConfig.groupAllowFrom,
    transport: vkConfig.transport,
    contextVisibility: vkConfig.contextVisibility,
    groups: vkConfig.groups,
  };

  if (accountId !== DEFAULT_ACCOUNT_ID && vkConfig.accounts?.[accountId]) {
    const accountConfig = vkConfig.accounts[accountId];
    return {
      ...base,
      ...accountConfig,
      // Merge groups from base and account
      groups: { ...base.groups, ...accountConfig.groups },
    };
  }

  return base;
}

/**
 * The host resolves a SecretRef token before the plugin sees the config. When it
 * cannot (provider down, id missing), it leaves the reference object in place and
 * marks the account unavailable; nothing here may call `.trim()` on that object.
 */
function describeUnresolvedToken(value: unknown): string | undefined {
  if (value === undefined || value === null || typeof value === "string") {
    return undefined;
  }
  if (typeof value === "object" && typeof (value as { source?: unknown }).source === "string") {
    const ref = value as { source: string; provider?: unknown; id?: unknown };
    return `${ref.source}:${String(ref.provider ?? "?")}:${String(ref.id ?? "?")}`;
  }
  return "value is not a string";
}

function hasVkTokenInput(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : describeUnresolvedToken(value) !== undefined;
}

/** Why an account has no usable token, for errors that reach the operator. */
export function describeMissingVkToken(
  account: Pick<ResolvedVkAccount, "accountId" | "tokenUnresolved"> & {
    config?: Pick<VkAccountConfig, "tokenFile">;
  },
): string {
  if (!account.tokenUnresolved) {
    return "VK token not configured";
  }
  // With a tokenFile the reference is not read, so the host does not resolve it
  // either (`secret-contract.ts`): the file is what is missing here.
  if (account.config?.tokenFile?.trim()) {
    return (
      `VK tokenFile for account "${account.accountId}" is empty or unreadable; ` +
      `the token SecretRef ${account.tokenUnresolved} is not used while tokenFile is set`
    );
  }
  return (
    `VK token SecretRef ${account.tokenUnresolved} for account "${account.accountId}" is not resolved ` +
    "(check the secrets provider: openclaw secrets audit)"
  );
}

function resolveVkToken(
  accountId: string,
  config: VkAccountConfig,
): { token: string; source: "env" | "tokenFile" | "config" | "none"; unresolved?: string } {
  // 1. Environment variable
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const envToken = process.env.VK_TOKEN?.trim();
    if (envToken) {
      return { token: envToken, source: "env" };
    }
  }

  // 2. Token file
  if (config.tokenFile?.trim()) {
    const fileValue = tryReadSecretFileSync(config.tokenFile.trim(), "VK token");
    if (fileValue?.trim()) {
      return { token: fileValue.trim(), source: "tokenFile" };
    }
  }

  // 3. Config value: a string, or a SecretRef the host has already resolved into one
  if (typeof config.token === "string" && config.token.trim()) {
    return { token: config.token.trim(), source: "config" };
  }
  const unresolved = describeUnresolvedToken(config.token);
  if (unresolved) {
    return { token: "", source: "none", unresolved };
  }

  return { token: "", source: "none" };
}

export function resolveVkAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedVkAccount {
  const accountId = normalizeAccountId(params.accountId ?? undefined);
  const config = mergeVkAccountConfig(params.cfg, accountId);
  const { token, source, unresolved } = resolveVkToken(accountId, config);

  return {
    accountId,
    enabled: config.enabled !== false,
    name: config.name?.trim() || undefined,
    token,
    ...(unresolved ? { tokenUnresolved: unresolved } : {}),
    tokenSource: source,
    config,
  };
}

export function listVkAccountIds(cfg: CoreConfig): string[] {
  const vkConfig = cfg.channels?.vk as VkConfig | undefined;
  if (!vkConfig) {
    return [];
  }

  const ids: string[] = [];
  // Include default account if top-level token/tokenFile is present
  if (hasVkTokenInput(vkConfig.token) || vkConfig.tokenFile?.trim() || process.env.VK_TOKEN?.trim()) {
    ids.push(DEFAULT_ACCOUNT_ID);
  }

  if (vkConfig.accounts) {
    for (const id of Object.keys(vkConfig.accounts)) {
      if (id !== DEFAULT_ACCOUNT_ID && !ids.includes(id)) {
        ids.push(id);
      }
    }
  }

  // If no accounts found but config section exists, include default
  if (ids.length === 0 && vkConfig) {
    ids.push(DEFAULT_ACCOUNT_ID);
  }

  return ids;
}

export function resolveDefaultVkAccountId(cfg: CoreConfig): string {
  const ids = listVkAccountIds(cfg);
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function listEnabledVkAccounts(cfg: CoreConfig): ResolvedVkAccount[] {
  return listVkAccountIds(cfg)
    .map((accountId) => resolveVkAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
