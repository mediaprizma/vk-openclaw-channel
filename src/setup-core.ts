import { DEFAULT_ACCOUNT_ID, type OpenClawConfig } from "openclaw/plugin-sdk/core";
import { normalizeAccountId } from "openclaw/plugin-sdk/core";
import type { ChannelSetupAdapter } from "openclaw/plugin-sdk/setup";
import { listVkAccountIds, resolveVkAccount } from "./accounts.js";
import type { VkConfig } from "./types.js";

const channel = "vk" as const;

export function patchVkAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: Record<string, unknown>;
  clearFields?: string[];
  enabled?: boolean;
}): OpenClawConfig {
  const accountId = normalizeAccountId(params.accountId);
  const vkConfig = ((params.cfg.channels as Record<string, unknown>)?.vk ?? {}) as VkConfig;
  const clearFields = params.clearFields ?? [];

  if (accountId === DEFAULT_ACCOUNT_ID) {
    const nextVk = { ...vkConfig } as Record<string, unknown>;
    for (const field of clearFields) {
      delete nextVk[field];
    }
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        vk: {
          ...nextVk,
          ...(params.enabled ? { enabled: true } : {}),
          ...params.patch,
        },
      },
    };
  }

  const nextAccount = {
    ...(vkConfig.accounts?.[accountId] ?? {}),
  } as Record<string, unknown>;
  for (const field of clearFields) {
    delete nextAccount[field];
  }

  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      vk: {
        ...vkConfig,
        ...(params.enabled ? { enabled: true } : {}),
        accounts: {
          ...vkConfig.accounts,
          [accountId]: {
            ...nextAccount,
            ...(params.enabled ? { enabled: true } : {}),
            ...params.patch,
          },
        },
      },
    },
  };
}

export function isVkConfigured(cfg: OpenClawConfig, accountId: string): boolean {
  const resolved = resolveVkAccount({ cfg, accountId });
  return Boolean(resolved.token.trim());
}

export function parseVkAllowFromId(raw: string): string | null {
  const trimmed = raw.trim().replace(/^vk:(?:user:)?/i, "");
  // VK user IDs are numeric
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export const vkSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    patchVkAccountConfig({
      cfg,
      accountId,
      patch: name?.trim() ? { name: name.trim() } : {},
    }),
  validateInput: ({ accountId, input }) => {
    const typedInput = input as {
      useEnv?: boolean;
      token?: string;
      tokenFile?: string;
    };
    if (typedInput.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      return "VK_TOKEN can only be used for the default account.";
    }
    if (typedInput.useEnv && !process.env.VK_TOKEN?.trim()) {
      return "VK_TOKEN is not set or is empty. Set it before using --use-env.";
    }
    if (
      !typedInput.useEnv &&
      !typedInput.token?.trim() &&
      !typedInput.tokenFile?.trim()
    ) {
      return "VK requires a community access token (or --use-env).";
    }
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const typedInput = input as {
      useEnv?: boolean;
      token?: string;
      tokenFile?: string;
    };
    const normalizedAccountId = normalizeAccountId(accountId);
    if (normalizedAccountId === DEFAULT_ACCOUNT_ID) {
      return patchVkAccountConfig({
        cfg,
        accountId: normalizedAccountId,
        enabled: true,
        clearFields: typedInput.useEnv ? ["token", "tokenFile"] : undefined,
        patch: typedInput.useEnv
          ? {}
          : {
              ...(typedInput.tokenFile
                ? { tokenFile: typedInput.tokenFile }
                : typedInput.token
                  ? { token: typedInput.token }
                  : {}),
            },
      });
    }
    return patchVkAccountConfig({
      cfg,
      accountId: normalizedAccountId,
      enabled: true,
      patch: {
        ...(typedInput.tokenFile
          ? { tokenFile: typedInput.tokenFile }
          : typedInput.token
            ? { token: typedInput.token }
            : {}),
      },
    });
  },
};

export { listVkAccountIds };
