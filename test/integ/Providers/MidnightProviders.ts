import { MidnightProviders } from "@midnight-ntwrk/midnight-js-types";
import * as Wallet from "../Wallet";
import { makeMidnightProvider } from "./MidnightProvider";
import { makePrivateStateProvider } from "./PrivateStateProvider";
import { makeProofProvider } from "./ProofProvider";
import { makePublicDataProvider } from "./PublicDataProvider";
import { makeWalletProvider } from "./WalletProvider";
import { LocalFileZKConfigProvider } from "./ZKConfigProvider";
import { bytes32, makeShieldedUserAddress } from "../integ-support";

export function makeMidnightProviders(ctx: Wallet.Context): MidnightProviders {
    const zkConfigProvider = new LocalFileZKConfigProvider()
    
    return {
        privateStateProvider: makePrivateStateProvider(ctx.unshieldedKeystore.getBech32Address().toString()),
        publicDataProvider: makePublicDataProvider(),
        zkConfigProvider,
        proofProvider: makeProofProvider(zkConfigProvider),
        walletProvider: makeWalletProvider(ctx),
        midnightProvider: makeMidnightProvider(ctx.wallet)
    };
}

export function shieldedRecipient(providers: MidnightProviders) {
  return makeShieldedUserAddress(providers.walletProvider.getCoinPublicKey());
}

export function ownerPubKey(providers: MidnightProviders) {
  return { bytes: bytes32(providers.walletProvider.getCoinPublicKey()) };
}