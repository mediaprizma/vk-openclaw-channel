/**
 * Entry point the host loads (from `dist/secret-contract-api.js`) to resolve
 * SecretRef tokens before the channel starts. See `src/secret-contract.ts`.
 */
export {
  channelSecrets,
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from "./src/secret-contract.js";
