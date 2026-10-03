/**
 * SecretRef contract for the VK channel.
 *
 * The host looks for `secret-contract-api.js` in the plugin root or `dist/` and
 * calls `collectRuntimeConfigAssignments` while it builds the runtime config
 * snapshot: every `token` that is a SecretRef (`{ source, provider, id }`) is
 * resolved there, and the plugin receives a plain string.
 *
 * The collector follows VK's own account model (`accounts.ts`) rather than the
 * host's generic one:
 * - the root `token` backs the `default` account and every named account without
 *   a token of its own (`mergeVkAccountConfig` spreads the root under it);
 * - `VK_TOKEN` in the environment wins for the default account, so the root
 *   reference has no default consumer then;
 * - `accounts.default` is never read (the default account is the root);
 * - `tokenFile` comes before `token` in `resolveVkToken`, so an account with a
 *   non-empty `tokenFile` (its own, or the root's it inherits) does not read the
 *   token, and a reference nobody reads is inactive — the same rule as
 *   Telegram's `botToken` next to `tokenFile`.
 * The generic helper would skip the root token once named accounts exist,
 * leaving `default` with an unresolved object.
 */
import {
  collectSecretInputAssignment,
  createChannelSecretTargetRegistryEntries,
  getChannelRecord,
  hasOwnProperty,
  isRecord,
  type ResolverContext,
  type SecretDefaults,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";

const CHANNEL_KEY = "vk";
const DEFAULT_ACCOUNT_ID = "default";

export const secretTargetRegistryEntries = createChannelSecretTargetRegistryEntries({
  channelKey: CHANNEL_KEY,
  account: ["token"],
  channel: ["token"],
});

function accountOwner(accountId: string, contract: unknown) {
  return {
    ownerKind: "account" as const,
    ownerId: `${CHANNEL_KEY}:${normalizeAccountId(accountId)}`,
    requiredForGateway: false,
    disposition: "isolate" as const,
    contract,
  };
}

/** Mirrors the host's `appendConfigPathSegment`, which the SDK does not export. */
function accountTokenPath(accountId: string): string {
  const base = `channels.${CHANNEL_KEY}.accounts`;
  const segment = /^[A-Za-z_$][A-Za-z0-9_$:-]*$/.test(accountId)
    ? `.${accountId}`
    : `[${JSON.stringify(accountId)}]`;
  return `${base}${segment}.token`;
}

/** A configured `tokenFile`, trimmed; empty when none is set. */
function tokenFileOf(record: Record<string, unknown>): string {
  return typeof record.tokenFile === "string" ? record.tokenFile.trim() : "";
}

/** Same rule as `mergeVkAccountConfig`: an account's own `tokenFile`, else the root's. */
function accountTokenFile(channel: Record<string, unknown>, account: Record<string, unknown>): string {
  return hasOwnProperty(account, "tokenFile") ? tokenFileOf(account) : tokenFileOf(channel);
}

/** Same rule as `resolveVkAccount`: the account's own `enabled` wins over the root. */
function isAccountEnabled(channel: Record<string, unknown>, account: Record<string, unknown>): boolean {
  const flag = hasOwnProperty(account, "enabled") ? account.enabled : channel.enabled;
  return flag !== false;
}

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const channel = getChannelRecord(params.config, CHANNEL_KEY);
  if (!channel) return;

  const { accounts: rawAccounts, ...channelDefaults } = channel;
  const accounts = Object.entries(isRecord(rawAccounts) ? rawAccounts : {}).filter(
    (entry): entry is [string, Record<string, unknown>] =>
      isRecord(entry[1]) && normalizeAccountId(entry[0]) !== DEFAULT_ACCOUNT_ID,
  );

  if (hasOwnProperty(channel, "token")) {
    const envTokenWins = Boolean(params.context.env?.VK_TOKEN?.trim());
    const baseTokenFile = tokenFileOf(channel);
    const consumers = [
      ...(channel.enabled !== false && !envTokenWins && baseTokenFile.length === 0
        ? [{ accountId: DEFAULT_ACCOUNT_ID, account: {} }]
        : []),
      ...accounts
        .filter(
          ([, account]) =>
            !hasOwnProperty(account, "token") &&
            isAccountEnabled(channel, account) &&
            accountTokenFile(channel, account).length === 0,
        )
        .map(([accountId, account]) => ({ accountId, account })),
    ];
    const apply = (value: unknown) => {
      channel.token = value;
    };
    if (consumers.length === 0) {
      collectSecretInputAssignment({
        value: channel.token,
        path: `channels.${CHANNEL_KEY}.token`,
        expected: "string",
        defaults: params.defaults,
        context: params.context,
        active: false,
        inactiveReason: `${
          envTokenWins
            ? "VK_TOKEN is set for the default account"
            : baseTokenFile.length > 0
              ? "tokenFile is configured for the default account"
              : "VK channel is disabled"
        } and no enabled account without a tokenFile inherits this top-level token.`,
        apply,
      });
    } else {
      const contract = {
        channel: channelDefaults,
        consumers: consumers
          .map(({ accountId, account }) => ({ accountId: normalizeAccountId(accountId), account }))
          .sort((left, right) => left.accountId.localeCompare(right.accountId)),
      };
      for (const { accountId } of consumers) {
        collectSecretInputAssignment({
          value: channel.token,
          path: `channels.${CHANNEL_KEY}.token`,
          expected: "string",
          defaults: params.defaults,
          context: params.context,
          owner: accountOwner(accountId, contract),
          apply,
        });
      }
    }
  }

  for (const [accountId, account] of accounts) {
    if (!hasOwnProperty(account, "token")) continue;
    collectSecretInputAssignment({
      value: account.token,
      path: accountTokenPath(accountId),
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: isAccountEnabled(channel, account) && accountTokenFile(channel, account).length === 0,
      inactiveReason: "VK account is disabled or tokenFile is configured.",
      owner: accountOwner(accountId, { channel: channelDefaults, account }),
      apply: (value: unknown) => {
        account.token = value;
      },
    });
  }
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
