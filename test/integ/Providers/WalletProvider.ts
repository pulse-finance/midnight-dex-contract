import { UnboundTransaction, WalletProvider } from "@midnight-ntwrk/midnight-js-types"
import * as Wallet from "../Wallet"
import { TX_TTL_MS } from "../Constants"

export type TokenKindsToBalance = "all" | Array<"dust" | "shielded" | "unshielded">

export function makeWalletProvider(ctx: Wallet.Context): WalletProvider {
  return {
    getCoinPublicKey() {
      return ctx.shieldedSecretKeys.coinPublicKey
    },
    getEncryptionPublicKey() {
      return ctx.shieldedSecretKeys.encryptionPublicKey
    },
    async balanceTx(tx: UnboundTransaction, ttl?: Date, tokenKindsToBalance?: TokenKindsToBalance) {
      const recipe = await ctx.wallet.balanceUnboundTransaction(
        tx,
        {
          shieldedSecretKeys: ctx.shieldedSecretKeys,
          dustSecretKey: ctx.dustSecretKey,
        },
        {
          ttl: ttl ?? new Date(Date.now() + TX_TTL_MS),
          tokenKindsToBalance,
        },
      )

      return ctx.wallet.finalizeRecipe(recipe)
    },
  }
}
