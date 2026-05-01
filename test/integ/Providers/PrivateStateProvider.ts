import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider"

export function makePrivateStateProvider(accountId: string) {
  return levelPrivateStateProvider({
    midnightDbName: "midnight-dex-contract-integ-db",
    privateStateStoreName: "midnight-dex-contract-integ-private-state",
    signingKeyStoreName: "midnight-dex-contract-integ-signing-keys",
    privateStoragePasswordProvider: () => "MidnightDexInteg!2026",
    accountId,
  })
}
