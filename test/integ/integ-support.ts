import { pathToFileURL } from "node:url";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import type { Contract as CompactContract } from "@midnight-ntwrk/compact-js/effect/Contract";
import {
  type ChargedState,
  type StateValue,
} from "@midnight-ntwrk/compact-runtime";
import { submitTx } from "@midnight-ntwrk/midnight-js-contracts";
import {
  MidnightProviders,
  type WalletProvider,
} from "@midnight-ntwrk/midnight-js-types";
import { fromHex } from "@midnight-ntwrk/midnight-js-utils";
import {
  type UnprovenTransaction
} from "@midnight-ntwrk/ledger-v8";

import { NETWORK_ID } from "./Constants";
import * as Wallet from "./Wallet"


export const DEFAULT_RUNTIME_CONFIGURATION = {
  networkId: NETWORK_ID,
  indexerUrl: "http://127.0.0.1:8088/api/v4/graphql",
  indexerWsUrl: "ws://127.0.0.1:8088/api/v4/graphql/ws",
  nodeWsUrl: "ws://127.0.0.1:9944",
  proofServerUrl: "http://127.0.0.1:6300",
} as const

export type RuntimeConfiguration = typeof DEFAULT_RUNTIME_CONFIGURATION;

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

export async function stopWallet(walletCtx: Wallet.Context): Promise<void> {
  await walletCtx.wallet.stop().catch(() => {});
}

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

export async function submitUnprovenTx(
  providers: MidnightProviders,
  unprovenTx: UnprovenTransaction,
  options: { tokenKindsToBalance?: TokenKindsToBalance } = {},
): Promise<void> {
  if (!options.tokenKindsToBalance) {
    await submitTx(providers, { unprovenTx });
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
