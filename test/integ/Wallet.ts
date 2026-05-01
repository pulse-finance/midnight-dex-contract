import { DustSecretKey, LedgerParameters, ZswapSecretKeys } from "@midnight-ntwrk/ledger-v8";
import { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";
import { createKeystore, InMemoryTransactionHistoryStorage, PublicKey, UnshieldedKeystore, UnshieldedWallet } from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import { INDEXER_URL, INDEXER_WS_URL, NETWORK_ID, NODE_WS_URL, PROOF_SERVER_URL } from "./Constants";
import { ShieldedWallet } from "@midnight-ntwrk/wallet-sdk-shielded";
import { DustWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import { bytes32, canonicalCoinKey, waitFor, WalletShieldedCoin } from "./integ-support";

export type Context = {
  wallet: WalletFacade;
  shieldedSecretKeys: ZswapSecretKeys;
  dustSecretKey: DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
};

export async function makeContext(
  seedHex: string
): Promise<Context> {
  const material = deriveWalletMaterialFromSeed(Buffer.from(seedHex, "hex"), NETWORK_ID);

  const wallet = await WalletFacade.init({
    configuration: {
      networkId: NETWORK_ID,
      indexerClientConnection: {
        indexerHttpUrl: INDEXER_URL,
        indexerWsUrl: INDEXER_WS_URL,
      },
      relayURL: new URL(NODE_WS_URL),
      provingServerUrl: new URL(PROOF_SERVER_URL),
      costParameters: {
        additionalFeeOverhead: 300_000_000_000_000n,
        feeBlocksMargin: 5,
      },
      txHistoryStorage: new InMemoryTransactionHistoryStorage(),
    },
    shielded: (config) => ShieldedWallet(config).startWithSecretKeys(material.shieldedSecretKeys),
    unshielded: (config) =>
      UnshieldedWallet(config).startWithPublicKey(PublicKey.fromKeyStore(material.unshieldedKeystore)),
    dust: (config) =>
      DustWallet(config).startWithSecretKey(material.dustSecretKey, LedgerParameters.initialParameters().dust),
  });

  await wallet.start(material.shieldedSecretKeys, material.dustSecretKey);
  await wallet.waitForSyncedState();

  return {
    wallet,
    shieldedSecretKeys: material.shieldedSecretKeys,
    dustSecretKey: material.dustSecretKey,
    unshieldedKeystore: material.unshieldedKeystore
  }
}

function deriveWalletMaterialFromSeed(seed: Uint8Array, networkId: string) {
  const hdWallet = HDWallet.fromSeed(seed);
  if (hdWallet.type !== "seedOk") {
    throw new Error("Failed to initialize HD wallet from seed");
  }

  const derivation = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);

  if (derivation.type !== "keysDerived") {
    throw new Error("Failed to derive wallet keys");
  }

  hdWallet.hdWallet.clear();

  return {
    shieldedSecretKeys: ZswapSecretKeys.fromSeed(derivation.keys[Roles.Zswap]),
    dustSecretKey: DustSecretKey.fromSeed(derivation.keys[Roles.Dust]),
    unshieldedKeystore: createKeystore(derivation.keys[Roles.NightExternal], networkId),
  };
}

export async function coins(wallet: Context) {
  const state = await wallet.wallet.waitForSyncedState();
  return new Set(state.shielded.availableCoins.map((coin) => canonicalCoinKey(coin.coin)));
}

export async function waitForNewCoin(
  wallet: Context,
  existingKeys: Set<string>,
  expectedType?: Uint8Array,
): Promise<WalletShieldedCoin> {
  return waitFor("wallet coin", async () => {
    const state = await wallet.wallet.waitForSyncedState();
    const next = state.shielded.availableCoins.find((coin) => {
      if (existingKeys.has(canonicalCoinKey(coin.coin))) {
        return false;
      }
      if (!expectedType) {
        return true;
      }
      return Buffer.from(bytes32(coin.coin.type)).equals(Buffer.from(expectedType));
    });
    return next ?? null;
  });
}