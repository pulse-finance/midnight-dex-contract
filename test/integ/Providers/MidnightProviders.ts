import { MidnightProviders, WalletProvider } from "@midnight-ntwrk/midnight-js-types"
import * as Wallet from "../Wallet"
import { makeMidnightProvider } from "./MidnightProvider"
import { makePrivateStateProvider } from "./PrivateStateProvider"
import { makeProofProvider } from "./ProofProvider"
import { makePublicDataProvider } from "./PublicDataProvider"
import { makeWalletProvider, type TokenKindsToBalance } from "./WalletProvider"
import { LocalFileZKConfigProvider } from "./ZKConfigProvider"
import { submitTx } from "@midnight-ntwrk/midnight-js-contracts"
import { UnprovenTransaction } from "@midnight-ntwrk/ledger-v8"

export function makeMidnightProviders(ctx: Wallet.Context): MidnightProviders {
  const zkConfigProvider = new LocalFileZKConfigProvider()

  return {
    privateStateProvider: makePrivateStateProvider(
      ctx.unshieldedKeystore.getBech32Address().toString(),
    ),
    publicDataProvider: makePublicDataProvider(),
    zkConfigProvider,
    proofProvider: makeProofProvider(zkConfigProvider),
    walletProvider: makeWalletProvider(ctx),
    midnightProvider: makeMidnightProvider(ctx.wallet),
  }
}

type ExtendedWalletProvider = WalletProvider & {
  balanceTx(
    tx: Parameters<WalletProvider["balanceTx"]>[0],
    ttl?: Date,
    tokenKindsToBalance?: TokenKindsToBalance,
  ): ReturnType<WalletProvider["balanceTx"]>
}

export async function submitUnprovenTx(
  providers: MidnightProviders,
  unprovenTx: UnprovenTransaction,
  options: { tokenKindsToBalance?: TokenKindsToBalance } = {},
): Promise<void> {
  if (!options.tokenKindsToBalance) {
    await submitTx(providers, { unprovenTx })
    return
  }

  const provenTx = await providers.proofProvider.proveTx(unprovenTx)
  const balancedTx = await (providers.walletProvider as ExtendedWalletProvider).balanceTx(
    provenTx,
    undefined,
    options.tokenKindsToBalance,
  )
  const txId = await providers.midnightProvider.submitTx(balancedTx)
  await providers.publicDataProvider.watchForTxData(txId)
}
