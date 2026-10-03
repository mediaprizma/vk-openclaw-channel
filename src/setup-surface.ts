import {
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  setSetupChannelEnabled,
  setTopLevelChannelDmPolicyWithAllowFrom,
  splitSetupEntries,
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup";
import type { DmPolicy } from "./types.js";
import { resolveVkAccount } from "./accounts.js";
import {
  isVkConfigured,
  listVkAccountIds,
  parseVkAllowFromId,
  patchVkAccountConfig,
} from "./setup-core.js";

const channel = "vk" as const;

const VK_SETUP_HELP_LINES = [
  "1) Go to VK community settings > API usage > Access tokens",
  "2) Create a community access token with all required scopes:",
  "   - messages: receive and send community messages",
  "   - manage: use Bots Long Poll API",
  "   - photos: send images",
  "   - docs: send files, TTS audio, and voice messages",
  "3) Enable Bots Long Poll API in community settings",
  "4) Grant the bot message sending permissions in the community",
  `Docs: ${formatDocsLink("/channels/vk", "channels/vk")}`,
];

const VK_ALLOW_FROM_HELP_LINES = [
  "Allowlist VK DMs by user id.",
  "VK user IDs are numeric.",
  "Examples:",
  "- 123456789",
  "- vk:123456789",
  "Multiple entries: comma-separated.",
  `Docs: ${formatDocsLink("/channels/vk", "channels/vk")}`,
];

const vkDmPolicy: ChannelSetupDmPolicy = {
  label: "VK",
  channel,
  policyKey: "channels.vk.dmPolicy",
  allowFromKey: "channels.vk.allowFrom",
  getCurrent: (cfg) =>
    ((cfg.channels as Record<string, Record<string, string>> | undefined)?.vk?.dmPolicy as
      | DmPolicy
      | undefined) ?? "pairing",
  setPolicy: (cfg, policy) =>
    setTopLevelChannelDmPolicyWithAllowFrom({
      cfg,
      channel,
      dmPolicy: policy,
    }),
};

export { vkSetupAdapter } from "./setup-core.js";

export const vkSetupWizard: ChannelSetupWizard = {
  channel,
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "needs token",
    configuredHint: "configured",
    unconfiguredHint: "needs community access token",
    configuredScore: 1,
    unconfiguredScore: 0,
    resolveConfigured: ({ cfg }) =>
      listVkAccountIds(cfg).some((accountId) => isVkConfigured(cfg, accountId)),
    resolveStatusLines: ({ cfg, configured }) => [
      `VK: ${configured ? "configured" : "needs token"}`,
      `Accounts: ${listVkAccountIds(cfg).length || 0}`,
    ],
  },
  introNote: {
    title: "VK Community Bot",
    lines: VK_SETUP_HELP_LINES,
    shouldShow: ({ cfg, accountId }) => !isVkConfigured(cfg, accountId),
  },
  credentials: [
    {
      inputKey: "token",
      providerHint: channel,
      credentialLabel: "community access token",
      preferredEnvVar: "VK_TOKEN",
      helpTitle: "VK Community Bot",
      helpLines: VK_SETUP_HELP_LINES,
      envPrompt: "VK_TOKEN detected. Use env var?",
      keepPrompt: "VK community access token already configured. Keep it?",
      inputPrompt: "Enter VK community access token",
      allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
      inspect: ({ cfg, accountId }) => {
        const resolved = resolveVkAccount({ cfg, accountId });
        return {
          accountConfigured: Boolean(resolved.token.trim()),
          // A SecretRef token is an object; it counts as configured, not as a string to trim.
          hasConfiguredValue: Boolean(
            (typeof resolved.config.token === "string"
              ? resolved.config.token.trim()
              : resolved.config.token) || resolved.config.tokenFile?.trim(),
          ),
          resolvedValue: resolved.token.trim() || undefined,
          envValue:
            accountId === DEFAULT_ACCOUNT_ID
              ? process.env.VK_TOKEN?.trim() || undefined
              : undefined,
        };
      },
      applyUseEnv: ({ cfg, accountId }) =>
        patchVkAccountConfig({
          cfg,
          accountId,
          enabled: true,
          clearFields: ["token", "tokenFile"],
          patch: {},
        }),
      applySet: ({ cfg, accountId, resolvedValue }) =>
        patchVkAccountConfig({
          cfg,
          accountId,
          enabled: true,
          clearFields: ["tokenFile"],
          patch: { token: resolvedValue },
        }),
    },
  ],
  allowFrom: {
    helpTitle: "VK allowlist",
    helpLines: VK_ALLOW_FROM_HELP_LINES,
    message: "VK allowFrom (user id)",
    placeholder: "123456789",
    invalidWithoutCredentialNote: "VK allowFrom requires numeric user IDs like 123456789.",
    parseInputs: splitSetupEntries,
    parseId: parseVkAllowFromId,
    resolveEntries: async ({ entries }) =>
      entries.map((entry) => {
        const id = parseVkAllowFromId(entry);
        return {
          input: entry,
          resolved: Boolean(id),
          id,
        };
      }),
    apply: ({ cfg, accountId, allowFrom }) =>
      patchVkAccountConfig({
        cfg,
        accountId,
        enabled: true,
        patch: { dmPolicy: "allowlist", allowFrom },
      }),
  },
  dmPolicy: vkDmPolicy,
  completionNote: {
    title: "VK bot ready",
    lines: [
      "Ensure Bots Long Poll API is enabled in your VK community settings.",
      "The bot will automatically start receiving messages via long polling.",
      `Docs: ${formatDocsLink("/channels/vk", "channels/vk")}`,
    ],
  },
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};
