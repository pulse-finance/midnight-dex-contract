import path from "node:path";

import { ContractExecutable, CompiledContract } from "@midnight-ntwrk/compact-js";
import type { Contract as CompactContract } from "@midnight-ntwrk/compact-js/effect/Contract";
import { encodeContractAddress, entryPointHash, type ZswapLocalState } from "@midnight-ntwrk/compact-runtime";
import {
  createCircuitCallTxInterface,
  createUnprovenCallTxFromInitialStates,
  deployContract,
  getPublicStates,
  submitTx,
  type CircuitCallTxInterface,
  type ContractProviders,
  type DeployedContract,
  type UnsubmittedCallTxData,
} from "@midnight-ntwrk/midnight-js-contracts";
import { asContractAddress, makeContractExecutableRuntime } from "@midnight-ntwrk/midnight-js-types";
import { fromHex } from "@midnight-ntwrk/midnight-js-utils";
import {
  ChargedState,
  communicationCommitmentRandomness,
  ContractDeploy,
  ContractMaintenanceAuthority,
  ContractOperationVersionedVerifierKey,
  ContractState as LedgerContractState,
  Intent,
  MaintenanceUpdate,
  maxField,
  signData,
  signingKeyFromBip340,
  Transaction,
  type CommunicationCommitmentRand,
  VerifierKeyInsert,
} from "@midnight-ntwrk/ledger-v8";

import {
  GENESIS_SEED_HEX,
  buildCompiledContract,
  bytes32,
  canonicalCoinKey,
  createMidnightProviders,
  createWallet,
  ensureDust,
  initializeMidnightRuntime,
  littleEndianHexToField,
  loadContractModule,
  makeShieldedUserAddress,
  readLedger,
  stopWallet,
  submitUnprovenTx,
  waitFor,
  type MidnightProviders,
  type WalletContext,
  type WalletShieldedCoin,
} from "./integ-support";
import { mergeContractCallTxs } from "./merge";
import type { MergeContractCallTxData } from "./merge";

type FaucetModule = typeof import("../../dist/faucet/contract/index.js");
type AmmModule = typeof import("../../dist/amm/contract/index.js");
type MintLpOrderModule = typeof import("../../dist/mintlporder/contract/index.js");
type BurnLpOrderModule = typeof import("../../dist/burnlporder/contract/index.js");
type MarketOrderModule = typeof import("../../dist/marketorder/contract/index.js");

type FaucetWitnesses = import("../../dist/faucet/contract/index.js").Witnesses<undefined>;
type AmmWitnesses = import("../../dist/amm/contract/index.js").Witnesses<undefined>;
type MintLpOrderWitnesses = import("../../dist/mintlporder/contract/index.js").Witnesses<undefined>;
type BurnLpOrderWitnesses = import("../../dist/burnlporder/contract/index.js").Witnesses<undefined>;
type MarketOrderWitnesses = import("../../dist/marketorder/contract/index.js").Witnesses<undefined>;

type FaucetInstance = import("../../dist/faucet/contract/index.js").Contract<undefined, FaucetWitnesses>;
type AmmInstance = import("../../dist/amm/contract/index.js").Contract<undefined, AmmWitnesses>;
type MintLpOrderInstance = import("../../dist/mintlporder/contract/index.js").Contract<undefined, MintLpOrderWitnesses>;
type BurnLpOrderInstance = import("../../dist/burnlporder/contract/index.js").Contract<undefined, BurnLpOrderWitnesses>;
type MarketOrderInstance = import("../../dist/marketorder/contract/index.js").Contract<undefined, MarketOrderWitnesses>;

type CompiledFor<C extends CompactContract.Any> = CompiledContract.CompiledContract<C, CompactContract.PrivateState<C>, never>;
type FaucetCompiledContract = CompiledFor<FaucetInstance>;
type AmmCompiledContract = CompiledFor<AmmInstance>;
type MintLpOrderCompiledContract = CompiledFor<MintLpOrderInstance>;
type BurnLpOrderCompiledContract = CompiledFor<BurnLpOrderInstance>;
type MarketOrderCompiledContract = CompiledFor<MarketOrderInstance>;
type AmmCircuitId = CompactContract.ProvableCircuitId<AmmInstance>;
type AmmEndpoints = CircuitCallTxInterface<AmmInstance>;
type LocalOutput = ZswapLocalState["outputs"][number];
type AmmLedger = ReturnType<AmmModule["ledger"]>;
type MintLpOrderLedger = ReturnType<MintLpOrderModule["ledger"]>;
type BurnLpOrderLedger = ReturnType<BurnLpOrderModule["ledger"]>;
type TypedModule<C extends CompactContract.Any, W extends object> = {
  Contract: new (witnesses: W) => C;
};

const DIST = path.resolve(process.cwd(), "dist");
const AMM_FEE_BPS = 10n;
const X_TOKEN_NAME = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const Y_TOKEN_NAME = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const INITIAL_X_LIQ = 1_000_000n;
const INITIAL_Y_LIQ = 2_000_000n;
const MINT_LP_X_IN = 100_000n;
const MINT_LP_Y_IN = 200_000n;
const BURN_LP_IN = 50_000n;
const SWAP_X_IN = 10_000n;
const SWAP_Y_IN = 20_000n;
const ZAP_IN_X_IN = 11_111n;
const ZAP_IN_Y_IN = 22_222n;
const ZAP_OUT_X_LP_IN = 7_777n;
const ZAP_OUT_Y_LP_IN = 6_666n;
const ORDER_OWNER_SECRET = new Uint8Array(32).fill(11);
const AMM_BATCHER_SECRET = new Uint8Array(32).fill(7);
const AMM_DEPLOY_CIRCUIT_BATCH_SIZE = 10;

const REQUIRED_AMM_OPERATIONS = [
  "AmmTick",
  "AmmXLiq",
  "AmmYLiq",
  "AmmInitXYLiq",
  "AmmDepositXYLiq",
  "AmmDepositXLiq",
  "AmmDepositYLiq",
  "AmmSwapXToY",
  "AmmSwapYToX",
  "AmmWithdrawXYLiq",
  "AmmWithdrawXLiq",
  "AmmWithdrawYLiq",
  "AmmMergeXLiq",
  "AmmMergeYLiq",
  "AmmMintLp",
  "AmmReward",
  "AmmSendX",
  "AmmSendY",
  "AmmUpdate",
  "AmmValidateDepositXYLiq",
  "AmmValidateDepositXLiq",
  "AmmValidateDepositYLiq",
  "AmmValidateSwapXToY",
  "AmmValidateSwapYToX",
  "AmmValidateWithdrawXYLiq",
  "AmmValidateWithdrawXLiq",
  "AmmValidateWithdrawYLiq",
] as const;

type AmmState = {
  feeBps: bigint;
  xLiquidity: bigint;
  yLiquidity: bigint;
  xRewards: bigint;
  lpCirculatingSupply: bigint;
};

const treasury = {
  is_left: true,
  left: { bytes: new Uint8Array(32).fill(1) },
  right: { bytes: new Uint8Array(32) },
};

function deterministicNonce(index: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[30] = (index >> 8) & 0xff;
  bytes[31] = index & 0xff;
  return bytes;
}

function communicationCommitmentRandomnessAsField(): CommunicationCommitmentRand {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const opening = communicationCommitmentRandomness();
    if (littleEndianHexToField(opening) <= maxField()) {
      return opening;
    }
  }

  throw new Error("Failed to sample communication commitment randomness within field range");
}

function batchesOf<T>(items: readonly T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize));
  }
  return batches;
}

function shieldedRecipient(providers: MidnightProviders) {
  return makeShieldedUserAddress(providers.walletProvider.getCoinPublicKey());
}

function ownerPubKey(providers: MidnightProviders) {
  return { bytes: bytes32(providers.walletProvider.getCoinPublicKey()) };
}

function makeOrderReceiveCircuit(contractAddress: string, entrypoint: string) {
  return {
    address: { bytes: fromHex(contractAddress) },
    hash: fromHex(entryPointHash(entrypoint)),
  };
}

function calcSwapXToY(state: Pick<AmmState, "feeBps" | "xLiquidity" | "yLiquidity">, xIn: bigint) {
  const xFee = (xIn * state.feeBps + 9999n) / 10000n;
  const yOut = state.yLiquidity - ((state.xLiquidity * state.yLiquidity) + (state.xLiquidity + xIn - xFee) - 1n) / (state.xLiquidity + xIn - xFee);
  return { xFee, yOut };
}

function calcSwapYToX(state: Pick<AmmState, "feeBps" | "xLiquidity" | "yLiquidity">, yIn: bigint) {
  const xOutAndFee = state.xLiquidity - ((state.xLiquidity * state.yLiquidity) + (state.yLiquidity + yIn) - 1n) / (state.yLiquidity + yIn);
  const xOut = (xOutAndFee * (10000n - state.feeBps)) / 10000n;
  const xFee = xOutAndFee - xOut;
  return { xFee, xOut };
}

function calcLpOut(state: Pick<AmmState, "xLiquidity" | "yLiquidity" | "lpCirculatingSupply">, xIn: bigint, yIn: bigint) {
  const byX = (xIn * state.lpCirculatingSupply) / state.xLiquidity;
  const byY = (yIn * state.lpCirculatingSupply) / state.yLiquidity;
  return byX < byY ? byX : byY;
}

function calcWithdrawXY(state: Pick<AmmState, "xLiquidity" | "yLiquidity" | "lpCirculatingSupply">, lpIn: bigint) {
  return {
    xOut: (lpIn * state.xLiquidity) / state.lpCirculatingSupply,
    yOut: (lpIn * state.yLiquidity) / state.lpCirculatingSupply,
  };
}

function findZapInX(state: AmmState, xIn: bigint) {
  for (let xSwap = 1n; xSwap < xIn; xSwap += 1n) {
    const { xFee, yOut: ySwap } = calcSwapXToY(state, xSwap);
    const xLiqAfterSwap = state.xLiquidity + xSwap - xFee;
    const yLiqAfterSwap = state.yLiquidity - ySwap;
    const xAdded = xIn - xSwap;
    const yAdded = ySwap;
    const xRatioLower = xAdded * yLiqAfterSwap;
    const xRatioUpper = (xAdded + 1n) * yLiqAfterSwap;
    const yRatio = yAdded * xLiqAfterSwap;
    if (!(xRatioLower <= yRatio && xRatioUpper >= yRatio)) {
      continue;
    }

    const lpOut = (xAdded * state.lpCirculatingSupply) / xLiqAfterSwap;
    const lhsLower = lpOut * xLiqAfterSwap;
    const lhsUpper = (lpOut + 1n) * xLiqAfterSwap;
    const rhs = xAdded * state.lpCirculatingSupply;
    if (lhsLower <= rhs && lhsUpper >= rhs) {
      return { xSwap, xFee, ySwap, lpOut };
    }
  }

  throw new Error("Failed to derive X zap-in validation args");
}

function findZapInY(state: AmmState, yIn: bigint) {
  for (let ySwap = 1n; ySwap < yIn; ySwap += 1n) {
    const { xFee, xOut: xSwap } = calcSwapYToX(state, ySwap);
    const xLiqAfterSwap = state.xLiquidity - xSwap - xFee;
    const yLiqAfterSwap = state.yLiquidity + ySwap;
    const xAdded = xSwap;
    const yAdded = yIn - ySwap;
    const xRatio = xAdded * yLiqAfterSwap;
    const yRatioLower = yAdded * xLiqAfterSwap;
    const yRatioUpper = (yAdded + 1n) * xLiqAfterSwap;
    if (!(yRatioLower <= xRatio && yRatioUpper >= xRatio)) {
      continue;
    }

    const lpOut = (yAdded * state.lpCirculatingSupply) / yLiqAfterSwap;
    const lhsLower = lpOut * yLiqAfterSwap;
    const lhsUpper = (lpOut + 1n) * yLiqAfterSwap;
    const rhs = yAdded * state.lpCirculatingSupply;
    if (lhsLower <= rhs && lhsUpper >= rhs) {
      return { ySwap, xFee, xSwap, lpOut };
    }
  }

  throw new Error("Failed to derive Y zap-in validation args");
}

function findZapOutX(state: AmmState, lpIn: bigint) {
  const maxX = (lpIn * state.xLiquidity) / state.lpCirculatingSupply + 1n;
  const maxY = (lpIn * state.yLiquidity) / state.lpCirculatingSupply + 1n;
  for (let xRemoved = 0n; xRemoved <= maxX; xRemoved += 1n) {
    for (let yRemoved = 0n; yRemoved <= maxY; yRemoved += 1n) {
      const xLower = xRemoved * state.lpCirculatingSupply;
      const xUpper = (xRemoved + 1n) * state.lpCirculatingSupply;
      const xRhs = lpIn * state.xLiquidity;
      const yLower = yRemoved * state.lpCirculatingSupply;
      const yUpper = (yRemoved + 1n) * state.lpCirculatingSupply;
      const yRhs = lpIn * state.yLiquidity;
      if (!(xLower <= xRhs && xUpper >= xRhs && yLower <= yRhs && yUpper >= yRhs)) {
        continue;
      }
      const reduced = {
        feeBps: state.feeBps,
        xLiquidity: state.xLiquidity - xRemoved,
        yLiquidity: state.yLiquidity - yRemoved,
      };
      const { xFee, xOut: xSwap } = calcSwapYToX(reduced, yRemoved);
      return { xOut: xRemoved + xSwap, ySwap: yRemoved, xFee, xSwap };
    }
  }
  throw new Error("Failed to derive X zap-out validation args");
}

function findZapOutY(state: AmmState, lpIn: bigint) {
  const maxX = (lpIn * state.xLiquidity) / state.lpCirculatingSupply + 1n;
  const maxY = (lpIn * state.yLiquidity) / state.lpCirculatingSupply + 1n;
  for (let xRemoved = 0n; xRemoved <= maxX; xRemoved += 1n) {
    for (let yRemoved = 0n; yRemoved <= maxY; yRemoved += 1n) {
      const xLower = xRemoved * state.lpCirculatingSupply;
      const xUpper = (xRemoved + 1n) * state.lpCirculatingSupply;
      const xRhs = lpIn * state.xLiquidity;
      const yLower = yRemoved * state.lpCirculatingSupply;
      const yUpper = (yRemoved + 1n) * state.lpCirculatingSupply;
      const yRhs = lpIn * state.yLiquidity;
      if (!(xLower <= xRhs && xUpper >= xRhs && yLower <= yRhs && yUpper >= yRhs)) {
        continue;
      }
      const reduced = {
        feeBps: state.feeBps,
        xLiquidity: state.xLiquidity - xRemoved,
        yLiquidity: state.yLiquidity - yRemoved,
      };
      const { xFee, yOut: ySwap } = calcSwapXToY(reduced, xRemoved);
      return { yOut: yRemoved + ySwap, xSwap: xRemoved, xFee, ySwap };
    }
  }
  throw new Error("Failed to derive Y zap-out validation args");
}

function applyInit(state: AmmState, xIn: bigint, yIn: bigint) {
  const lpOut = BigInt(Math.floor(Math.sqrt(Number(xIn) * Number(yIn))));
  return {
    ...state,
    xLiquidity: state.xLiquidity + xIn,
    yLiquidity: state.yLiquidity + yIn,
    lpCirculatingSupply: state.lpCirculatingSupply + lpOut,
  };
}

type OwnerSecretContext = { privateState: undefined };
type OwnerSecretWitnesses = {
  ownerSecret(context: OwnerSecretContext): [undefined, Uint8Array];
};
type OwnerCommitmentContract = {
  _persistentHash_1(value: [Uint8Array, Uint8Array]): Uint8Array;
};
type OwnerCommitmentModule = {
  Contract: new (witnesses: OwnerSecretWitnesses) => unknown;
};

function computeOwnerCommitment(contractModule: OwnerCommitmentModule, contractAddress: string) {
  const contract = new contractModule.Contract({
    ownerSecret: (context) => [context.privateState, ORDER_OWNER_SECRET],
  }) as OwnerCommitmentContract;
  return contract._persistentHash_1([
    encodeContractAddress(contractAddress),
    ORDER_OWNER_SECRET,
  ]);
}

function findOutput(outputs: readonly LocalOutput[], predicate: (output: LocalOutput) => boolean, description: string): LocalOutput {
  const output = outputs.find(predicate);
  if (!output) {
    throw new Error(`Missing output: ${description}`);
  }
  return output;
}

async function waitForNewCoin(
  wallet: WalletContext,
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

async function walletCoinSnapshot(wallet: WalletContext) {
  const state = await wallet.wallet.waitForSyncedState();
  return new Set(state.shielded.availableCoins.map((coin) => canonicalCoinKey(coin.coin)));
}

async function mintShieldedToken(
  providers: MidnightProviders,
  compiledContract: FaucetCompiledContract,
  faucetAddress: string,
  tokenName: Uint8Array,
  quantity: bigint,
  nonce: Uint8Array,
): Promise<void> {
  const initialStates = await getPublicStates(providers.publicDataProvider, faucetAddress);
  const mintCall = await createUnprovenCallTxFromInitialStates(
    providers.zkConfigProvider,
    {
      compiledContract,
      contractAddress: faucetAddress,
      circuitId: "FaucetMintShielded",
      args: [tokenName, quantity, nonce, shieldedRecipient(providers)],
      coinPublicKey: providers.walletProvider.getCoinPublicKey(),
      initialContractState: initialStates.contractState,
      initialZswapChainState: initialStates.zswapChainState,
      ledgerParameters: initialStates.ledgerParameters,
      initialPrivateState: undefined as CompactContract.PrivateState<FaucetInstance>,
    },
    providers.walletProvider.getEncryptionPublicKey(),
  );

  await submitUnprovenTx(
    providers,
    mintCall.private.unprovenTx,
  );
}

async function createSimpleCall<C extends CompactContract.Any, PCK extends CompactContract.ProvableCircuitId<C>>(
  providers: MidnightProviders,
  compiledContract: CompiledFor<C>,
  contractAddress: string,
  circuitId: PCK,
  args: CompactContract.CircuitParameters<C, PCK>,
): Promise<UnsubmittedCallTxData<C, PCK>> {
  const initialStates = await getPublicStates(providers.publicDataProvider, contractAddress);
  return createUnprovenCallTxFromInitialStates(
    providers.zkConfigProvider,
    {
      compiledContract,
      contractAddress,
      circuitId,
      args,
      coinPublicKey: providers.walletProvider.getCoinPublicKey(),
      initialContractState: initialStates.contractState,
      initialZswapChainState: initialStates.zswapChainState,
      ledgerParameters: initialStates.ledgerParameters,
      initialPrivateState: undefined as CompactContract.PrivateState<C>,
    },
    providers.walletProvider.getEncryptionPublicKey(),
  );
}

async function createLocalStateCall<C extends CompactContract.Any, PCK extends CompactContract.ProvableCircuitId<C>>(
  providers: MidnightProviders,
  compiledContract: CompiledFor<C>,
  contractAddress: string,
  circuitId: PCK,
  args: CompactContract.CircuitParameters<C, PCK>,
  _communicationCommitmentRand?: CommunicationCommitmentRand,
): Promise<MergeContractCallTxData<C, PCK>> {
  const callTxData = await createSimpleCall(providers, compiledContract, contractAddress, circuitId, args);
  return {
    callTxData,
    zswapLocalState: callTxData.private.nextZswapLocalState,
  };
}

async function submitCall<C extends CompactContract.Any, PCK extends CompactContract.ProvableCircuitId<C>>(
  providers: MidnightProviders,
  compiledContract: CompiledFor<C>,
  contractAddress: string,
  circuitId: PCK,
  args: CompactContract.CircuitParameters<C, PCK>,
  tokenKindsToBalance?: Array<"dust" | "shielded" | "unshielded">,
): Promise<void> {
  const callTx = await createSimpleCall(providers, compiledContract, contractAddress, circuitId, args);
  await submitUnprovenTx(
    providers,
    callTx.private.unprovenTx,
    { tokenKindsToBalance },
  );
}

async function submitAmmEndpoint<PCK extends AmmCircuitId>(
  endpoints: AmmEndpoints,
  circuitId: PCK,
  ...args: CompactContract.CircuitParameters<AmmInstance, PCK>
): Promise<void> {
  const endpoint = (endpoints as Record<string, (...endpointArgs: readonly unknown[]) => Promise<unknown>>)[circuitId];
  if (endpoint == null) {
    throw new Error(`Missing AMM endpoint for circuit ${String(circuitId)}`);
  }

  await endpoint(...args);
}

async function deployAmmSplit(
  providers: MidnightProviders,
  compiledContract: AmmCompiledContract,
  xColor: Uint8Array,
  yColor: Uint8Array,
) {
  console.log("[integ] AMM deploy: preparing split deployment");
  const contractRuntime = makeContractExecutableRuntime(providers.zkConfigProvider, {
    coinPublicKey: providers.walletProvider.getCoinPublicKey(),
    signingKey: Buffer.from(AMM_BATCHER_SECRET).toString("hex"),
  });
  const contractExec = ContractExecutable.make(compiledContract);
  const provableCircuitIds = contractExec.getProvableCircuitIds();
  const firstTxCircuitIds = provableCircuitIds.slice(0, AMM_DEPLOY_CIRCUIT_BATCH_SIZE);
  const maintenanceCircuitBatches = batchesOf(
    provableCircuitIds.slice(AMM_DEPLOY_CIRCUIT_BATCH_SIZE),
    AMM_DEPLOY_CIRCUIT_BATCH_SIZE,
  );
  const initialPrivateState = undefined;
  const contractResult = await contractRuntime.runPromise(
    contractExec.initialize(initialPrivateState, AMM_FEE_BPS, shieldedRecipient(providers), xColor, yColor),
  );

  const fullState = LedgerContractState.deserialize(contractResult.public.contractState.serialize());
  const deployState = new LedgerContractState();
  deployState.data = new ChargedState(fullState.data.state);
  deployState.balance = new Map(fullState.balance);
  deployState.maintenanceAuthority = new ContractMaintenanceAuthority(
    [...fullState.maintenanceAuthority.committee],
    fullState.maintenanceAuthority.threshold,
    fullState.maintenanceAuthority.counter,
  );

  const contractDeploy = new ContractDeploy(deployState);
  const firstBatchVerifierKeyInserts: VerifierKeyInsert[] = [];
  for (const circuitId of firstTxCircuitIds) {
    const verifierKey = await providers.zkConfigProvider.getVerifierKey(circuitId);
    firstBatchVerifierKeyInserts.push(
      new VerifierKeyInsert(circuitId, new ContractOperationVersionedVerifierKey("v3", verifierKey)),
    );
  }
  const batchSigningKey = signingKeyFromBip340(AMM_BATCHER_SECRET);
  const deployTx = Transaction.fromParts(
    "undeployed",
    undefined,
    undefined,
    Intent.new(new Date(Date.now() + 60 * 60 * 1000)).addDeploy(contractDeploy),
  );
  console.log(
    "[integ] AMM deploy: submitting base contract deploy (no circuit inserts)",
  );
  await submitTx(providers, { unprovenTx: deployTx });

  const contractAddress = contractDeploy.address;
  const maintenanceTxIds: string[] = [];
  console.log(`[integ] AMM deploy: contract address ${contractAddress}`);
  console.log(
    `[integ] AMM deploy: ${provableCircuitIds.length} provable circuits total`,
  );
  const allMaintenanceBatches: string[][] = [firstTxCircuitIds, ...maintenanceCircuitBatches];

  for (const [batchIndex, circuitBatch] of allMaintenanceBatches.entries()) {
    const batchStart = batchIndex * AMM_DEPLOY_CIRCUIT_BATCH_SIZE + 1;
    const batchEnd = batchStart + circuitBatch.length - 1;
    console.log(
      `[integ] AMM deploy: preparing maintenance batch ${batchIndex + 1}/${allMaintenanceBatches.length} for circuits ${batchStart}-${batchEnd}: ${circuitBatch.join(", ")}`,
    );
    const contractState = await providers.publicDataProvider.queryContractState(asContractAddress(contractAddress));
    if (!contractState) {
      throw new Error(`Missing on-chain contract state for ${contractAddress}`);
    }

    let verifierKeyInserts: VerifierKeyInsert[];
    if (batchIndex === 0) {
      verifierKeyInserts = firstBatchVerifierKeyInserts.filter((insert) => contractState.operation(insert.operation) == null);
      for (const insert of firstBatchVerifierKeyInserts) {
        if (contractState.operation(insert.operation) != null) {
          console.log(`[integ] AMM deploy: circuit already present, skipping ${insert.operation}`);
        }
      }
    } else {
      verifierKeyInserts = [];
      for (const circuitId of circuitBatch) {
        if (contractState.operation(circuitId) != null) {
          console.log(`[integ] AMM deploy: circuit already present, skipping ${circuitId}`);
          continue;
        }
        const verifierKey = await providers.zkConfigProvider.getVerifierKey(circuitId);
        verifierKeyInserts.push(
          new VerifierKeyInsert(circuitId, new ContractOperationVersionedVerifierKey("v3", verifierKey)),
        );
      }
    }

    if (verifierKeyInserts.length === 0) {
      console.log(`[integ] AMM deploy: maintenance batch ${batchIndex + 1} has no missing circuits, skipping tx`);
      continue;
    }

    const maintenanceUpdate = new MaintenanceUpdate(
      asContractAddress(contractAddress),
      verifierKeyInserts,
      contractState.maintenanceAuthority.counter,
    );
    const signedMaintenanceUpdate = maintenanceUpdate.addSignature(
      0n,
      signData(batchSigningKey, maintenanceUpdate.dataToSign),
    );

    console.log(
      `[integ] AMM deploy: submitting maintenance batch ${batchIndex + 1}/${allMaintenanceBatches.length} with ${verifierKeyInserts.length} circuits`,
    );
    const finalized = await submitTx(providers, {
      unprovenTx: Transaction.fromParts(
        "undeployed",
        undefined,
        undefined,
        Intent.new(new Date(Date.now() + 60 * 60 * 1000)).addMaintenanceUpdate(signedMaintenanceUpdate),
      ),
    });
    maintenanceTxIds.push(finalized.txId);
    console.log(`[integ] AMM deploy: submitted maintenance batch ${batchIndex + 1} as tx ${finalized.txId}`);
  }

  console.log(`[integ] AMM deploy: submitted ${maintenanceTxIds.length} maintenance tx batches`);

  return { contractAddress, maintenanceTxIds };
}

async function deployContractForTest<C extends CompactContract.Any>(
  providers: MidnightProviders,
  compiledContract: CompiledFor<C>,
  args: CompactContract.InitializeParameters<C>,
  privateStateId: string,
): Promise<DeployedContract<C>> {
  return deployContract(
    providers as ContractProviders<C>,
    {
      compiledContract,
      args,
      privateStateId,
      initialPrivateState: undefined as CompactContract.PrivateState<C>,
    },
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertString(value: unknown, message: string): asserts value is string {
  assert(typeof value === "string" && value.length > 0, message);
}

async function main() {
  let wallet: WalletContext | undefined;

  try {
    console.log("[integ] Initializing runtime");
    initializeMidnightRuntime();

    console.log("[integ] Creating genesis wallet");
    wallet = await createWallet(GENESIS_SEED_HEX, "genesis");

    console.log("[integ] Ensuring dust balance");
    await ensureDust(wallet);
    const activeWallet = wallet;

    console.log("[integ] Loading contract modules");
    const faucetModule = await loadContractModule<FaucetModule>(path.join(DIST, "faucet/contract/index.js"));
    const ammModule = await loadContractModule<AmmModule>(path.join(DIST, "amm/contract/index.js"));
    const mintLpOrderModule = await loadContractModule<MintLpOrderModule>(path.join(DIST, "mintlporder/contract/index.js"));
    const burnLpOrderModule = await loadContractModule<BurnLpOrderModule>(path.join(DIST, "burnlporder/contract/index.js"));
    const marketOrderModule = await loadContractModule<MarketOrderModule>(path.join(DIST, "marketorder/contract/index.js"));

    console.log("[integ] Building compiled contracts");
    const faucetCompiled: FaucetCompiledContract = buildCompiledContract(
      faucetModule as TypedModule<FaucetInstance, FaucetWitnesses>,
      path.join(DIST, "faucet"),
    ) as unknown as FaucetCompiledContract;
    const ammCompiled: AmmCompiledContract = buildCompiledContract(
      ammModule as TypedModule<AmmInstance, AmmWitnesses>,
      path.join(DIST, "amm"),
      {
      batcherSecret: (context: { privateState: undefined }) => [context.privateState, AMM_BATCHER_SECRET],
      },
    ) as unknown as AmmCompiledContract;
    const mintLpOrderCompiled: MintLpOrderCompiledContract = buildCompiledContract(
      mintLpOrderModule as TypedModule<MintLpOrderInstance, MintLpOrderWitnesses>,
      path.join(DIST, "mintlporder"),
      {
      ownerSecret: (context: { privateState: undefined }) => [context.privateState, ORDER_OWNER_SECRET],
      },
    ) as unknown as MintLpOrderCompiledContract;
    const burnLpOrderCompiled: BurnLpOrderCompiledContract = buildCompiledContract(
      burnLpOrderModule as TypedModule<BurnLpOrderInstance, BurnLpOrderWitnesses>,
      path.join(DIST, "burnlporder"),
      {
      ownerSecret: (context: { privateState: undefined }) => [context.privateState, ORDER_OWNER_SECRET],
      },
    ) as unknown as BurnLpOrderCompiledContract;
    const marketOrderCompiled: MarketOrderCompiledContract = buildCompiledContract(
      marketOrderModule as TypedModule<MarketOrderInstance, MarketOrderWitnesses>,
      path.join(DIST, "marketorder"),
      {
      ownerSecret: (context: { privateState: undefined }) => [context.privateState, ORDER_OWNER_SECRET],
      },
    ) as unknown as MarketOrderCompiledContract;

    console.log("[integ] Creating contract providers");
    const faucetProviders = await createMidnightProviders(activeWallet, path.join(DIST, "faucet"));
    const ammProviders = await createMidnightProviders(activeWallet, path.join(DIST, "amm"));
    const mintProviders = await createMidnightProviders(activeWallet, path.join(DIST, "mintlporder"));
    const burnProviders = await createMidnightProviders(activeWallet, path.join(DIST, "burnlporder"));
    const marketProviders = await createMidnightProviders(activeWallet, path.join(DIST, "marketorder"));
    const mintAmmProviders = await createMidnightProviders(activeWallet, [path.join(DIST, "mintlporder"), path.join(DIST, "amm")]);
    const burnAmmProviders = await createMidnightProviders(activeWallet, [path.join(DIST, "burnlporder"), path.join(DIST, "amm")]);
    const marketAmmProviders = await createMidnightProviders(activeWallet, [path.join(DIST, "marketorder"), path.join(DIST, "amm")]);

    console.log("[integ] Verifying AMM circuit coverage");
    assertEqual(
      ContractExecutable.make(ammCompiled).getProvableCircuitIds().length,
      REQUIRED_AMM_OPERATIONS.length,
      "Unexpected AMM circuit count",
    );

    console.log("[integ] Deploying faucet");
    const faucet = await deployContractForTest(faucetProviders, faucetCompiled, [], "faucet");
    const faucetAddress = faucet.deployTxData.public.contractAddress as string;
    assertString(faucetAddress, "Missing faucet address");

    console.log("[integ] Minting X token supply");
    const xCoinBefore = await walletCoinSnapshot(activeWallet);
    await mintShieldedToken(faucetProviders, faucetCompiled, faucetAddress, X_TOKEN_NAME, INITIAL_X_LIQ + MINT_LP_X_IN + SWAP_X_IN + ZAP_IN_X_IN, deterministicNonce(1));
    const xCoin = await waitForNewCoin(activeWallet, xCoinBefore);
    const xColor = bytes32(xCoin.coin.type);

    console.log("[integ] Minting Y token supply");
    const yCoinBefore = await walletCoinSnapshot(activeWallet);
    await mintShieldedToken(faucetProviders, faucetCompiled, faucetAddress, Y_TOKEN_NAME, INITIAL_Y_LIQ + MINT_LP_Y_IN + SWAP_Y_IN + ZAP_IN_Y_IN, deterministicNonce(2));
    const yCoin = await waitForNewCoin(activeWallet, yCoinBefore);
    const yColor = bytes32(yCoin.coin.type);
    assert(!Buffer.from(xColor).equals(Buffer.from(yColor)), "X and Y colors must differ");

    console.log("[integ] Deploying AMM");
    const amm = await deployAmmSplit(ammProviders, ammCompiled, xColor, yColor);
    assertString(amm.contractAddress, "Missing AMM contract address");
    assert(amm.maintenanceTxIds.length > 0, "AMM maintenance tx ids should not be empty");
    const ammEndpoints = createCircuitCallTxInterface<AmmInstance>(
      ammProviders as ContractProviders<AmmInstance>,
      ammCompiled,
      amm.contractAddress,
      undefined,
    ) as AmmEndpoints;

    console.log("[integ] Validating AMM operations are available");
    const ammState = await ammProviders.publicDataProvider.queryContractState(asContractAddress(amm.contractAddress));
    if (!ammState) {
      throw new Error(`Missing AMM state for ${amm.contractAddress}`);
    }
    for (const operation of REQUIRED_AMM_OPERATIONS) {
      assert(ammState.operation(operation) != null, `Missing AMM operation ${operation}`);
    }

    console.log("[integ] Initializing AMM liquidity");
    const initLpOut = BigInt(Math.floor(Math.sqrt(Number(INITIAL_X_LIQ) * Number(INITIAL_Y_LIQ))));
    await submitAmmEndpoint(
      ammEndpoints,
      "AmmInitXYLiq",
      INITIAL_X_LIQ,
      INITIAL_Y_LIQ,
      initLpOut,
      shieldedRecipient(ammProviders),
      deterministicNonce(10),
    );

    let ammLedger: AmmLedger = await readLedger(ammModule, ammProviders, amm.contractAddress);
    assertEqual(ammLedger.xLiquidity, INITIAL_X_LIQ, "Unexpected initial X liquidity");
    assertEqual(ammLedger.yLiquidity, INITIAL_Y_LIQ, "Unexpected initial Y liquidity");
    assertEqual(ammLedger.lpCirculatingSupply, initLpOut, "Unexpected initial LP supply");

    console.log("[integ] Waiting for initial LP coin");
    let lpCoin = await waitForNewCoin(activeWallet, await walletCoinSnapshot(activeWallet));
    const lpColor = bytes32(lpCoin.coin.type);

    console.log("[integ] Deploying order contracts");
    const mintLpOrder = await deployContractForTest(
      mintProviders,
      mintLpOrderCompiled,
      [fromHex(entryPointHash("MintLpOrderReceiveFromAmm")), fromHex(entryPointHash("AmmTick"))],
      "mint-lp-order",
    );
    const burnLpOrder = await deployContractForTest(
      burnProviders,
      burnLpOrderCompiled,
      [fromHex(entryPointHash("BurnLpOrderReceiveFromAmm")), fromHex(entryPointHash("AmmTick"))],
      "burn-lp-order",
    );

    let marketOrderAddress = (
      await deployContractForTest(
        marketProviders,
        marketOrderCompiled,
        [fromHex(entryPointHash("MarketOrderReceiveFromAmm")), fromHex(entryPointHash("AmmTick"))],
        "market-order-initial",
      )
    ).deployTxData.public.contractAddress as string;

    const mintOrderAddress = mintLpOrder.deployTxData.public.contractAddress as string;
    const burnOrderAddress = burnLpOrder.deployTxData.public.contractAddress as string;
    assertString(mintOrderAddress, "Missing mint order address");
    assertString(burnOrderAddress, "Missing burn order address");
    assertString(marketOrderAddress, "Missing market order address");

    let expected: AmmState = applyInit({
      feeBps: AMM_FEE_BPS,
      xLiquidity: 0n,
      yLiquidity: 0n,
      xRewards: 0n,
      lpCirculatingSupply: 0n,
    }, INITIAL_X_LIQ, INITIAL_Y_LIQ);

    console.log("[integ] Running mint LP order flow");
    const mintOpenNonce = deterministicNonce(20);
    await submitCall(mintProviders, mintLpOrderCompiled, mintOrderAddress, "MintLpOrderOpen", [
      computeOwnerCommitment(mintLpOrderModule, mintOrderAddress),
      MINT_LP_X_IN,
      xColor,
      MINT_LP_Y_IN,
      yColor,
      makeOrderReceiveCircuit(amm.contractAddress, "AmmDepositXYLiq"),
      ownerPubKey(mintProviders),
      lpColor,
      mintOpenNonce,
    ]);

    const sendRnd = communicationCommitmentRandomnessAsField();
    const sendRndField = littleEndianHexToField(sendRnd);
    const mintOrderSend = await createLocalStateCall(
      mintProviders,
      mintLpOrderCompiled,
      mintOrderAddress,
      "MintLpOrderSendToAmm",
      [sendRndField, ammLedger.tick, 0n],
    );
    const forwardedX = findOutput(mintOrderSend.zswapLocalState.outputs, (output) => !output.recipient.is_left && output.coinInfo.value === MINT_LP_X_IN, "mint forwarded X");
    const forwardedY = findOutput(mintOrderSend.zswapLocalState.outputs, (output) => !output.recipient.is_left && output.coinInfo.value === MINT_LP_Y_IN, "mint forwarded Y");
    const ammDeposit = await createLocalStateCall(
      ammProviders,
      ammCompiled,
      amm.contractAddress,
      "AmmDepositXYLiq",
      [
        MINT_LP_X_IN,
        MINT_LP_Y_IN,
        bytes32(forwardedX.coinInfo.nonce),
        bytes32(forwardedY.coinInfo.nonce),
        makeOrderReceiveCircuit(mintOrderAddress, "MintLpOrderReceiveFromAmm"),
      ],
      sendRnd,
    );
    await submitUnprovenTx(
      mintAmmProviders,
      mergeContractCallTxs(mintOrderSend, ammDeposit),
      { tokenKindsToBalance: ["dust"] },
    );

    const mintLpOut = calcLpOut(expected, MINT_LP_X_IN, MINT_LP_Y_IN);
    await submitAmmEndpoint(ammEndpoints, "AmmValidateDepositXYLiq", mintLpOut);
    const lpBeforeReceive = await walletCoinSnapshot(activeWallet);
    const mintRnd = communicationCommitmentRandomnessAsField();
    const mintRndField = littleEndianHexToField(mintRnd);
    const ammMint = await createLocalStateCall(
      ammProviders,
      ammCompiled,
      amm.contractAddress,
      "AmmMintLp",
      [deterministicNonce(21), mintRndField],
    );
    const mintedLpOutput = findOutput(ammMint.zswapLocalState.outputs, (output) => !output.recipient.is_left, "minted LP");
    const mintReceive = await createLocalStateCall(
      mintProviders,
      mintLpOrderCompiled,
      mintOrderAddress,
      "MintLpOrderReceiveFromAmm",
      [2n, mintLpOut, bytes32(mintedLpOutput.coinInfo.nonce)],
      mintRnd,
    );
    await submitUnprovenTx(
      mintAmmProviders,
      mergeContractCallTxs(ammMint, mintReceive),
      { tokenKindsToBalance: ["dust"] },
    );
    await submitCall(mintProviders, mintLpOrderCompiled, mintOrderAddress, "MintLpOrderClose", [ammLedger.tick + 1n, 0n], ["dust"]);
    lpCoin = await waitForNewCoin(activeWallet, lpBeforeReceive, lpColor);

    expected = {
      ...expected,
      xLiquidity: expected.xLiquidity + MINT_LP_X_IN,
      yLiquidity: expected.yLiquidity + MINT_LP_Y_IN,
      lpCirculatingSupply: expected.lpCirculatingSupply + mintLpOut,
    };
    ammLedger = await readLedger(ammModule, ammProviders, amm.contractAddress);
    assertEqual(ammLedger.xLiquidity, expected.xLiquidity, "Unexpected X liquidity after mint LP");
    assertEqual(ammLedger.yLiquidity, expected.yLiquidity, "Unexpected Y liquidity after mint LP");
    assertEqual(ammLedger.lpCirculatingSupply, expected.lpCirculatingSupply, "Unexpected LP supply after mint LP");
    assert(
      !(await readLedger(mintLpOrderModule, mintProviders, mintOrderAddress) as MintLpOrderLedger).slot.is_some,
      "Mint LP order should be closed",
    );

    console.log("[integ] Running burn LP order flow");
    const { xOut: burnXOut, yOut: burnYOut } = calcWithdrawXY(expected, BURN_LP_IN);
    await submitCall(burnProviders, burnLpOrderCompiled, burnOrderAddress, "BurnLpOrderOpen", [
      computeOwnerCommitment(burnLpOrderModule, burnOrderAddress),
      BURN_LP_IN,
      lpColor,
      makeOrderReceiveCircuit(amm.contractAddress, "AmmWithdrawXYLiq"),
      ownerPubKey(burnProviders),
      xColor,
      yColor,
      deterministicNonce(30),
    ]);
    const burnRnd = communicationCommitmentRandomnessAsField();
    const burnRndField = littleEndianHexToField(burnRnd);
    const burnSend = await createLocalStateCall(
      burnProviders,
      burnLpOrderCompiled,
      burnOrderAddress,
      "BurnLpOrderSendToAmm",
      [burnRndField, ammLedger.tick, 0n],
    );
    const burnForward = findOutput(burnSend.zswapLocalState.outputs, (output) => !output.recipient.is_left, "burn forwarded LP");
    const burnWithdraw = await createLocalStateCall(
      ammProviders,
      ammCompiled,
      amm.contractAddress,
      "AmmWithdrawXYLiq",
      [BURN_LP_IN, bytes32(burnForward.coinInfo.nonce), makeOrderReceiveCircuit(burnOrderAddress, "BurnLpOrderReceiveFromAmm")],
      burnRnd,
    );
    await submitUnprovenTx(
      burnAmmProviders,
      mergeContractCallTxs(burnSend, burnWithdraw),
      { tokenKindsToBalance: ["dust"] },
    );
    await submitAmmEndpoint(ammEndpoints, "AmmValidateWithdrawXYLiq", burnXOut, burnYOut);
    const burnReceiveBefore = await walletCoinSnapshot(activeWallet);
    const burnXRnd = communicationCommitmentRandomnessAsField();
    const burnXRndField = littleEndianHexToField(burnXRnd);
    const sendX = await createLocalStateCall(ammProviders, ammCompiled, amm.contractAddress, "AmmSendX", [burnXRndField]);
    const burnXOutput = findOutput(sendX.zswapLocalState.outputs, (output) => !output.recipient.is_left, "burn X return");
    const burnReceiveX = await createLocalStateCall(
      burnProviders,
      burnLpOrderCompiled,
      burnOrderAddress,
      "BurnLpOrderReceiveFromAmm",
      [0n, burnXOut, bytes32(burnXOutput.coinInfo.nonce)],
      burnXRnd,
    );
    await submitUnprovenTx(
      burnAmmProviders,
      mergeContractCallTxs(sendX, burnReceiveX),
      { tokenKindsToBalance: ["dust"] },
    );
    const burnYRnd = communicationCommitmentRandomnessAsField();
    const burnYRndField = littleEndianHexToField(burnYRnd);
    const sendY = await createLocalStateCall(ammProviders, ammCompiled, amm.contractAddress, "AmmSendY", [burnYRndField]);
    const burnYOutput = findOutput(sendY.zswapLocalState.outputs, (output) => !output.recipient.is_left, "burn Y return");
    const burnReceiveY = await createLocalStateCall(
      burnProviders,
      burnLpOrderCompiled,
      burnOrderAddress,
      "BurnLpOrderReceiveFromAmm",
      [1n, burnYOut, bytes32(burnYOutput.coinInfo.nonce)],
      burnYRnd,
    );
    await submitUnprovenTx(
      burnAmmProviders,
      mergeContractCallTxs(sendY, burnReceiveY),
      { tokenKindsToBalance: ["dust"] },
    );
    await submitCall(burnProviders, burnLpOrderCompiled, burnOrderAddress, "BurnLpOrderClose", [ammLedger.tick + 2n, 0n], ["dust"]);
    await waitForNewCoin(activeWallet, burnReceiveBefore, xColor);
    await waitForNewCoin(activeWallet, burnReceiveBefore, yColor);
    expected = {
      ...expected,
      xLiquidity: expected.xLiquidity - burnXOut,
      yLiquidity: expected.yLiquidity - burnYOut,
      lpCirculatingSupply: expected.lpCirculatingSupply - BURN_LP_IN,
    };
    async function runMarketOrderCase<PCK extends AmmCircuitId>(
      inputAmount: bigint,
      inputColor: Uint8Array,
      callHash: string,
      returnColor: Uint8Array,
      validateCircuit: PCK,
      validateArgs: CompactContract.CircuitParameters<AmmInstance, PCK>,
      sendCircuit: "AmmSendX" | "AmmSendY" | "AmmMintLp",
      receiveKind: bigint,
      outputAmount: bigint,
      expectedNext: AmmState,
    ) {
      console.log(`[integ] Starting market order case ${callHash}`);
      const deployed = await deployContractForTest(
        marketProviders,
        marketOrderCompiled,
        [fromHex(entryPointHash("MarketOrderReceiveFromAmm")), fromHex(entryPointHash("AmmTick"))],
        `market-order-${callHash}`,
      );
      marketOrderAddress = deployed.deployTxData.public.contractAddress as string;
      await submitCall(marketProviders, marketOrderCompiled, marketOrderAddress, "MarketOrderOpen", [
        computeOwnerCommitment(marketOrderModule, marketOrderAddress),
        inputAmount,
        inputColor,
        makeOrderReceiveCircuit(amm.contractAddress, callHash),
        ownerPubKey(marketProviders),
        returnColor,
        deterministicNonce(Math.floor(Number(inputAmount % 255n)) + 40),
      ]);
      const marketRnd = communicationCommitmentRandomnessAsField();
      const marketRndField = littleEndianHexToField(marketRnd);
      const marketSend = await createLocalStateCall(
        marketProviders,
        marketOrderCompiled,
        marketOrderAddress,
        "MarketOrderSendToAmm",
        [marketRndField, ammLedger.tick, 0n],
      );
      const forwarded = findOutput(marketSend.zswapLocalState.outputs, (output) => !output.recipient.is_left, "market forwarded input");
      void forwarded;
      await submitAmmEndpoint(ammEndpoints, validateCircuit, ...validateArgs);
      const coinBefore = await walletCoinSnapshot(activeWallet);
      const receiveRnd = communicationCommitmentRandomnessAsField();
      const receiveRndField = littleEndianHexToField(receiveRnd);
      const ammReturn = await createLocalStateCall(
        ammProviders,
        ammCompiled,
        amm.contractAddress,
        sendCircuit,
        sendCircuit === "AmmMintLp" ? [deterministicNonce(90), receiveRndField] : [receiveRndField],
      );
      const returnedOutput = findOutput(ammReturn.zswapLocalState.outputs, (output) => !output.recipient.is_left, "market returned output");
      const marketReceive = await createLocalStateCall(
        marketProviders,
        marketOrderCompiled,
        marketOrderAddress,
        "MarketOrderReceiveFromAmm",
        [receiveKind, outputAmount, bytes32(returnedOutput.coinInfo.nonce)],
        receiveRnd,
      );
      await submitUnprovenTx(
        marketAmmProviders,
        mergeContractCallTxs(ammReturn, marketReceive),
        { tokenKindsToBalance: ["dust"] },
      );
      await submitCall(marketProviders, marketOrderCompiled, marketOrderAddress, "MarketOrderClose", [ammLedger.tick + 1n, 0n], ["dust"]);
      await waitForNewCoin(activeWallet, coinBefore, returnColor);
      expected = expectedNext;
      console.log(`[integ] Finished market order case ${callHash}`);
    }

    console.log("[integ] Running market swap X->Y");
    const swapX = calcSwapXToY(expected, SWAP_X_IN);
    await runMarketOrderCase(
      SWAP_X_IN,
      xColor,
      "AmmSwapXToY",
      yColor,
      "AmmValidateSwapXToY",
      [swapX.xFee, swapX.yOut],
      "AmmSendY",
      1n,
      swapX.yOut,
      {
        ...expected,
        xLiquidity: expected.xLiquidity + SWAP_X_IN - swapX.xFee,
        yLiquidity: expected.yLiquidity - swapX.yOut,
        xRewards: expected.xRewards + swapX.xFee,
      },
    );

    console.log("[integ] Running market swap Y->X");
    const swapY = calcSwapYToX(expected, SWAP_Y_IN);
    await runMarketOrderCase(
      SWAP_Y_IN,
      yColor,
      "AmmSwapYToX",
      xColor,
      "AmmValidateSwapYToX",
      [swapY.xFee, swapY.xOut],
      "AmmSendX",
      0n,
      swapY.xOut,
      {
        ...expected,
        xLiquidity: expected.xLiquidity - swapY.xOut - swapY.xFee,
        yLiquidity: expected.yLiquidity + SWAP_Y_IN,
        xRewards: expected.xRewards + swapY.xFee,
      },
    );

    console.log("[integ] Running zap-in X");
    const zapInX = findZapInX(expected, ZAP_IN_X_IN);
    await runMarketOrderCase(
      ZAP_IN_X_IN,
      xColor,
      "AmmDepositXLiq",
      lpColor,
      "AmmValidateDepositXLiq",
      [zapInX.xSwap, zapInX.xFee, zapInX.ySwap, zapInX.lpOut],
      "AmmMintLp",
      2n,
      zapInX.lpOut,
      {
        ...expected,
        xLiquidity: expected.xLiquidity + ZAP_IN_X_IN - zapInX.xFee,
        yLiquidity: expected.yLiquidity,
        xRewards: expected.xRewards + zapInX.xFee,
        lpCirculatingSupply: expected.lpCirculatingSupply + zapInX.lpOut,
      },
    );

    console.log("[integ] Running zap-in Y");
    const zapInY = findZapInY(expected, ZAP_IN_Y_IN);
    await runMarketOrderCase(
      ZAP_IN_Y_IN,
      yColor,
      "AmmDepositYLiq",
      lpColor,
      "AmmValidateDepositYLiq",
      [zapInY.ySwap, zapInY.xFee, zapInY.xSwap, zapInY.lpOut],
      "AmmMintLp",
      2n,
      zapInY.lpOut,
      {
        ...expected,
        xLiquidity: expected.xLiquidity - zapInY.xFee,
        yLiquidity: expected.yLiquidity + ZAP_IN_Y_IN,
        xRewards: expected.xRewards + zapInY.xFee,
        lpCirculatingSupply: expected.lpCirculatingSupply + zapInY.lpOut,
      },
    );

    console.log("[integ] Running zap-out X");
    const zapOutX = findZapOutX(expected, ZAP_OUT_X_LP_IN);
    await runMarketOrderCase(
      ZAP_OUT_X_LP_IN,
      lpColor,
      "AmmWithdrawXLiq",
      xColor,
      "AmmValidateWithdrawXLiq",
      [zapOutX.xOut, zapOutX.ySwap, zapOutX.xFee, zapOutX.xSwap],
      "AmmSendX",
      0n,
      zapOutX.xOut,
      {
        ...expected,
        xLiquidity: expected.xLiquidity - zapOutX.xOut - zapOutX.xFee,
        yLiquidity: expected.yLiquidity,
        xRewards: expected.xRewards + zapOutX.xFee,
        lpCirculatingSupply: expected.lpCirculatingSupply - ZAP_OUT_X_LP_IN,
      },
    );

    console.log("[integ] Running zap-out Y");
    const zapOutY = findZapOutY(expected, ZAP_OUT_Y_LP_IN);
    await runMarketOrderCase(
      ZAP_OUT_Y_LP_IN,
      lpColor,
      "AmmWithdrawYLiq",
      yColor,
      "AmmValidateWithdrawYLiq",
      [zapOutY.yOut, zapOutY.xSwap, zapOutY.xFee, zapOutY.ySwap],
      "AmmSendY",
      1n,
      zapOutY.yOut,
      {
        ...expected,
        xLiquidity: expected.xLiquidity - zapOutY.xFee,
        yLiquidity: expected.yLiquidity - zapOutY.yOut,
        xRewards: expected.xRewards + zapOutY.xFee,
        lpCirculatingSupply: expected.lpCirculatingSupply - ZAP_OUT_Y_LP_IN,
      },
    );

    console.log("[integ] Verifying final AMM ledger state");
    ammLedger = await readLedger(ammModule, ammProviders, amm.contractAddress);
    assertEqual(ammLedger.xLiquidity, expected.xLiquidity, "Unexpected final X liquidity");
    assertEqual(ammLedger.yLiquidity, expected.yLiquidity, "Unexpected final Y liquidity");
    assertEqual(ammLedger.lpCirculatingSupply, expected.lpCirculatingSupply, "Unexpected final LP supply");
    assertEqual(ammLedger.xRewards, expected.xRewards, "Unexpected final X rewards");
    assert(
      !(await readLedger(burnLpOrderModule, burnProviders, burnOrderAddress) as BurnLpOrderLedger).slot.is_some,
      "Burn LP order should be closed",
    );

    console.log("[integ] Integration flow completed successfully");
  } finally {
    if (wallet) {
      console.log("[integ] Stopping wallet");
      await stopWallet(wallet);
    }
  }
}

await main();
