import { pbkdf2Sync } from "node:crypto";
import path from "node:path";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CompiledContract } from "@midnight-ntwrk/compact-js";
import type { Contract as CompactContract } from "@midnight-ntwrk/compact-js/effect/Contract";
import {
  type ChargedState,
  CompactTypeBytes,
  CompactTypeField,
  CompactTypeVector,
  type StateValue,
  convertBytesToField,
  degradeToTransient,
  transientHash,
  upgradeFromTransient,
} from "@midnight-ntwrk/compact-runtime";
import { submitTx } from "@midnight-ntwrk/midnight-js-contracts";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import {
  type ProverKey,
  type VerifierKey,
  type WalletProvider,
  ZKConfigProvider,
  type ZKIR,
  createProofProvider,
  createProverKey,
  createVerifierKey,
  createZKIR,
} from "@midnight-ntwrk/midnight-js-types";
import { fromHex } from "@midnight-ntwrk/midnight-js-utils";
import {
  createCheckPayload,
  createProvingPayload,
  DustSecretKey,
  LedgerParameters,
  parseCheckResult,
  type Bindingish,
  type Proofish,
  type Signaturish,
  type UnprovenTransaction,
  ZswapSecretKeys,
} from "@midnight-ntwrk/ledger-v8";
import { DustWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";
import { ShieldedWallet } from "@midnight-ntwrk/wallet-sdk-shielded";
import {
  InMemoryTransactionHistoryStorage,
  PublicKey,
  UnshieldedWallet,
  createKeystore,
  type UnshieldedKeystore,
} from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const NONCE_EVOLVE_TAG = new TextEncoder().encode("midnight:kernel:nonce_evolve");
const TWO_FIELD_DESCRIPTOR = new CompactTypeVector(2, CompactTypeField);

const BUILTIN_CIRCUITS: Record<string, string> = {
  "midnight/zswap/spend": "zswap/9/spend",
  "midnight/zswap/output": "zswap/9/output",
  "midnight/zswap/sign": "zswap/9/sign",
  "midnight/dust/spend": "dust/9/spend",
};

export const NETWORK_ID = "undeployed";
export const GENESIS_SEED_HEX = "0000000000000000000000000000000000000000000000000000000000000001";

export const DEFAULT_RUNTIME_CONFIGURATION = {
  networkId: NETWORK_ID,
  indexerUrl: process.env.MIDNIGHT_INDEXER_URL ?? "http://127.0.0.1:8088/api/v4/graphql",
  indexerWsUrl: process.env.MIDNIGHT_INDEXER_WS_URL ?? "ws://127.0.0.1:8088/api/v4/graphql/ws",
  nodeWsUrl: process.env.MIDNIGHT_NODE_WS_URL ?? "ws://127.0.0.1:9944",
  proofServerUrl: process.env.MIDNIGHT_PROOF_SERVER_URL ?? "http://127.0.0.1:6300",
} as const;

export type RuntimeConfiguration = typeof DEFAULT_RUNTIME_CONFIGURATION;

export type WalletContext = {
  label: string;
  wallet: WalletFacade;
  shieldedSecretKeys: ZswapSecretKeys;
  dustSecretKey: DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
  runtimeConfiguration: RuntimeConfiguration;
};

export type WalletShieldedCoin = {
  coin: {
    nonce: string | Uint8Array;
    type: string | Uint8Array;
    value: bigint;
  };
};

export type AddressArg = {
  is_left: boolean;
  left: { bytes: Uint8Array };
  right: { bytes: Uint8Array };
};

type TokenKindsToBalance = "all" | Array<"dust" | "shielded" | "unshielded">;
type ExtendedWalletProvider = WalletProvider & {
  balanceTx(tx: Parameters<WalletProvider["balanceTx"]>[0], ttl?: Date, tokenKindsToBalance?: TokenKindsToBalance): ReturnType<WalletProvider["balanceTx"]>;
};

const txTtlMs = 60 * 60 * 1000;

async function resolveBuiltInCircuitsDir(): Promise<string> {
  const candidates = [
    path.resolve(REPO_ROOT, "../claim-contract-call-tests/public/circuits/midnight"),
    path.resolve(REPO_ROOT, "../dex-app/public/circuits/midnight"),
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep looking.
    }
  }

  throw new Error("Could not resolve Midnight built-in circuit assets");
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

export function initializeMidnightRuntime(
  runtimeConfiguration: RuntimeConfiguration = DEFAULT_RUNTIME_CONFIGURATION,
): void {
  if (typeof globalThis.WebSocket === "undefined") {
    throw new Error("This runtime does not provide a global WebSocket implementation.");
  }

  setNetworkId(runtimeConfiguration.networkId);
}

export async function waitFor<T>(
  description: string,
  fn: () => Promise<T | null>,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const startedAt = Date.now();
  const intervalMs = options.intervalMs ?? 1_000;
  const timeoutMs = options.timeoutMs ?? 120_000;

  while (Date.now() - startedAt < timeoutMs) {
    const result = await fn();
    if (result) {
      return result;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out while waiting for ${description}`);
}

export async function createWallet(
  seedHex: string,
  label: string,
  runtimeConfiguration: RuntimeConfiguration = DEFAULT_RUNTIME_CONFIGURATION,
): Promise<WalletContext> {
  const material = deriveWalletMaterialFromSeed(Buffer.from(seedHex, "hex"), runtimeConfiguration.networkId);
  const wallet = await WalletFacade.init({
    configuration: {
      networkId: runtimeConfiguration.networkId,
      indexerClientConnection: {
        indexerHttpUrl: runtimeConfiguration.indexerUrl,
        indexerWsUrl: runtimeConfiguration.indexerWsUrl,
      },
      relayURL: new URL(runtimeConfiguration.nodeWsUrl),
      provingServerUrl: new URL(runtimeConfiguration.proofServerUrl),
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
    label,
    wallet,
    shieldedSecretKeys: material.shieldedSecretKeys,
    dustSecretKey: material.dustSecretKey,
    unshieldedKeystore: material.unshieldedKeystore,
    runtimeConfiguration,
  };
}

export async function stopWallet(walletCtx: WalletContext): Promise<void> {
  await walletCtx.wallet.stop().catch(() => {});
}

export async function ensureDust(walletCtx: WalletContext): Promise<bigint> {
  const syncedState = await walletCtx.wallet.waitForSyncedState();
  const availableDust = syncedState.dust.balance(new Date());
  if (availableDust > 0n) {
    return availableDust;
  }

  const nightUtxos = syncedState.unshielded.availableCoins.filter(
    (coin) => coin.meta?.registeredForDustGeneration !== true,
  );

  if (nightUtxos.length > 0) {
    const recipe = await walletCtx.wallet.registerNightUtxosForDustGeneration(
      nightUtxos,
      walletCtx.unshieldedKeystore.getPublicKey(),
      (payload) => walletCtx.unshieldedKeystore.signData(payload),
    );
    const finalized = await walletCtx.wallet.finalizeRecipe(recipe);
    await walletCtx.wallet.submitTransaction(finalized);
  }

  return waitFor(`${walletCtx.label} dust`, async () => {
    const state = await walletCtx.wallet.waitForSyncedState();
    const balance = state.dust.balance(new Date());
    return balance > 0n ? balance : null;
  });
}

class LocalFileZKConfigProvider extends ZKConfigProvider<string> {
  constructor(
    private readonly builtInCircuitsDir: string,
    private readonly contractDirs: string[],
  ) {
    super();
  }

  private resolveBuiltIn(circuitId: string, extension: string): string | null {
    const relativePath = BUILTIN_CIRCUITS[circuitId];
    return relativePath ? path.join(this.builtInCircuitsDir, `${relativePath}${extension}`) : null;
  }

  private resolveContractAsset(circuitId: string, kind: string, extension: string): string[] {
    return this.contractDirs.map((contractDir) => path.join(contractDir, kind, `${circuitId}${extension}`));
  }

  private async readBinary(circuitId: string, assetKind: string, filePaths: string | string[]): Promise<Uint8Array> {
    const candidatePaths = Array.isArray(filePaths) ? filePaths : [filePaths];
    let lastError: unknown = null;

    for (const filePath of candidatePaths) {
      try {
        const bytes = new Uint8Array(await readFile(filePath));
        if (circuitId === "AmmInitXYLiq") {
          console.error(
            `[integ-proof] ZK asset loaded for ${circuitId}: kind='${assetKind}' path='${filePath}' bytes=${bytes.byteLength}`,
          );
        }
        return bytes;
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(`Missing ${assetKind} for circuit '${circuitId}': ${String(lastError)}`);
  }

  async getZKIR(circuitId: string): Promise<ZKIR> {
    const builtIn = this.resolveBuiltIn(circuitId, ".bzkir");
    return createZKIR(await this.readBinary(circuitId, "ZKIR", builtIn ?? this.resolveContractAsset(circuitId, "zkir", ".bzkir")));
  }

  async getProverKey(circuitId: string): Promise<ProverKey> {
    const builtIn = this.resolveBuiltIn(circuitId, ".prover");
    return createProverKey(await this.readBinary(circuitId, "prover key", builtIn ?? this.resolveContractAsset(circuitId, "keys", ".prover")));
  }

  async getVerifierKey(circuitId: string): Promise<VerifierKey> {
    const builtIn = this.resolveBuiltIn(circuitId, ".verifier");
    return createVerifierKey(await this.readBinary(circuitId, "verifier key", builtIn ?? this.resolveContractAsset(circuitId, "keys", ".verifier")));
  }
}

export async function createMidnightProviders(
  walletCtx: WalletContext,
  contractBuildDir: string | string[],
  runtimeConfiguration: RuntimeConfiguration = walletCtx.runtimeConfiguration,
) {
  const builtInCircuitsDir = await resolveBuiltInCircuitsDir();
  const contractDirs = Array.isArray(contractBuildDir) ? contractBuildDir : [contractBuildDir];
  const zkConfigProvider = new LocalFileZKConfigProvider(builtInCircuitsDir, contractDirs);
  const log = (message: string) => console.error(`[integ-proof] ${message}`);

  return {
    privateStateProvider: levelPrivateStateProvider({
      midnightDbName: "midnight-dex-contract-integ-db",
      privateStateStoreName: "midnight-dex-contract-integ-private-state",
      signingKeyStoreName: "midnight-dex-contract-integ-signing-keys",
      privateStoragePasswordProvider: () => "MidnightDexInteg!2026",
      accountId: walletCtx.unshieldedKeystore.getBech32Address().toString(),
    }),
    publicDataProvider: indexerPublicDataProvider(
      runtimeConfiguration.indexerUrl,
      runtimeConfiguration.indexerWsUrl,
    ),
    zkConfigProvider,
    proofProvider: createProofProvider({
      async check(serializedPreimage, keyLocation) {
        try {
          const zkir = await zkConfigProvider.getZKIR(keyLocation);
          const response = await fetch(new URL("/check", runtimeConfiguration.proofServerUrl), {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: Buffer.from(createCheckPayload(serializedPreimage, zkir)),
          });

          if (!response.ok) {
            const body = await response.text().catch(() => "<unreadable>");
            log(`Proof check failed for keyLocation='${keyLocation}' body=${body}`);
            throw new Error(`Proof check failed: ${response.status} ${response.statusText}`);
          }

          return parseCheckResult(new Uint8Array(await response.arrayBuffer()));
        } catch (error) {
          log(`Proof check failed for keyLocation='${keyLocation}'`);
          throw error;
        }
      },
      async prove(serializedPreimage, keyLocation, overwriteBindingInput) {
        try {
          const [zkir, proverKey, verifierKey] = await Promise.all([
            zkConfigProvider.getZKIR(keyLocation),
            zkConfigProvider.getProverKey(keyLocation),
            zkConfigProvider.getVerifierKey(keyLocation),
          ]);
          if (keyLocation === "AmmInitXYLiq") {
            log(
              `Prove payload for ${keyLocation}: preimageBytes=${serializedPreimage.byteLength} zkirBytes=${zkir.byteLength} proverKeyBytes=${proverKey.byteLength} verifierKeyBytes=${verifierKey.byteLength} overwriteBindingInput=${overwriteBindingInput == null ? "<none>" : overwriteBindingInput.toString()}`,
            );
          }
          const response = await fetch(new URL("/prove", runtimeConfiguration.proofServerUrl), {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: Buffer.from(createProvingPayload(
              serializedPreimage,
              overwriteBindingInput,
              {
                ir: zkir,
                proverKey,
                verifierKey,
              },
            )),
          });

          if (!response.ok) {
            const body = await response.text().catch(() => "<unreadable>");
            log(`Proof generation failed for keyLocation='${keyLocation}' body=${body}`);
            throw new Error(`Proof generation failed: ${response.status} ${response.statusText}`);
          }

          return new Uint8Array(await response.arrayBuffer());
        } catch (error) {
          log(`Proof generation failed for keyLocation='${keyLocation}'`);
          throw error;
        }
      },
    }),
    walletProvider: {
      getCoinPublicKey() {
        return walletCtx.shieldedSecretKeys.coinPublicKey;
      },
      getEncryptionPublicKey() {
        return walletCtx.shieldedSecretKeys.encryptionPublicKey;
      },
      async balanceTx(
        tx: Parameters<WalletFacade["balanceUnboundTransaction"]>[0],
        ttl?: Date,
        tokenKindsToBalance?: TokenKindsToBalance,
      ) {
        const recipe = await walletCtx.wallet.balanceUnboundTransaction(
          tx,
          {
            shieldedSecretKeys: walletCtx.shieldedSecretKeys,
            dustSecretKey: walletCtx.dustSecretKey,
          },
          {
            ttl: ttl ?? new Date(Date.now() + txTtlMs),
            tokenKindsToBalance,
          },
        );

        return walletCtx.wallet.finalizeRecipe(recipe);
      },
    },
    midnightProvider: {
      submitTx(tx: Parameters<WalletFacade["submitTransaction"]>[0]) {
        return walletCtx.wallet.submitTransaction(tx);
      },
    },
  };
}

export type MidnightProviders = Awaited<ReturnType<typeof createMidnightProviders>>;
type SubmitProviders = Omit<MidnightProviders, "walletProvider"> & {
  walletProvider: WalletProvider;
};

export async function loadContractModule<T>(contractModulePath: string): Promise<T> {
  return import(pathToFileURL(contractModulePath).href) as Promise<T>;
}

export function buildCompiledContract<C extends CompactContract.Any, W extends object>(
  contractModule: { Contract: new (witnesses: W) => C },
  contractBuildDir: string,
  witnesses?: W,
) {
  const base = CompiledContract.make("Contract", contractModule.Contract as never);
  const withWitnesses = witnesses
    ? CompiledContract.withWitnesses(base, witnesses as never)
    : CompiledContract.withVacantWitnesses(base);

  return CompiledContract.withCompiledFileAssets(withWitnesses, contractBuildDir);
}

export async function readLedger<TLedger>(
  contractModule: { ledger: (data: StateValue | ChargedState) => TLedger },
  providers: MidnightProviders,
  contractAddress: string,
): Promise<TLedger> {
  const { getPublicStates } = await import("@midnight-ntwrk/midnight-js-contracts");
  const states = await getPublicStates(providers.publicDataProvider, contractAddress);
  return contractModule.ledger(states.contractState.data);
}

export function bytes32(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? fromHex(value) : value;
}

export function makeShieldedUserAddress(bytes: Uint8Array | string): AddressArg {
  return {
    is_left: true,
    left: { bytes: bytes32(bytes) },
    right: { bytes: new Uint8Array(32) },
  };
}

function normalizeCoinBytes(bytes: string | Uint8Array): string {
  return typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("hex");
}

export function canonicalCoinKey(coinInfo: {
  nonce: string | Uint8Array;
  type?: string | Uint8Array;
  color?: string | Uint8Array;
  value: bigint;
}): string {
  const coinType = coinInfo.color ?? coinInfo.type;
  if (!coinType) {
    throw new Error("Expected shielded coin type or color");
  }

  return `${normalizeCoinBytes(coinInfo.nonce)}:${normalizeCoinBytes(coinType)}:${coinInfo.value.toString()}`;
}

export function littleEndianHexToField(hex: string): bigint {
  const normalizedHex = hex.length === 66 && hex.startsWith("73") ? hex.slice(2) : hex;
  const bytes = Buffer.from(normalizedHex, "hex");
  let value = 0n;

  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[index]);
  }

  return value;
}

export function evolveNonce(nonce: Uint8Array): Uint8Array {
  return upgradeFromTransient(
    transientHash(TWO_FIELD_DESCRIPTOR, [
      convertBytesToField(NONCE_EVOLVE_TAG.length, NONCE_EVOLVE_TAG, "midnight.evolveNonce"),
      degradeToTransient(nonce),
    ]),
  );
}

export async function submitUnprovenTx(
  providers: MidnightProviders,
  unprovenTx: UnprovenTransaction,
  options: { tokenKindsToBalance?: TokenKindsToBalance } = {},
): Promise<void> {
  if (!options.tokenKindsToBalance) {
    await submitTx(providers as SubmitProviders, { unprovenTx });
    return;
  }

  const provenTx = await providers.proofProvider.proveTx(unprovenTx);
  const balancedTx = await (providers.walletProvider as ExtendedWalletProvider).balanceTx(
    provenTx,
    undefined,
    options.tokenKindsToBalance,
  );
  const txId = await providers.midnightProvider.submitTx(balancedTx);
  await providers.publicDataProvider.watchForTxData(txId);
}
