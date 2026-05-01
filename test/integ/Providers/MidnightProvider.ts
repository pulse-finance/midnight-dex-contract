import { MidnightProvider } from "@midnight-ntwrk/midnight-js-types";
import { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import { FinalizedTransaction } from "@midnight-ntwrk/ledger-v8";

export function makeMidnightProvider(wallet: WalletFacade): MidnightProvider {
    return {
        async submitTx(tx: FinalizedTransaction) {
            try {
                return await wallet.submitTransaction(tx);
            } catch (e) {
                console.log(`Failed to submit tx ${e}: ${tx.toString()}`)
                throw e
            }
        }
    }
}