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
  type ContractProviders,
  type DeployedContract,
  type UnsubmittedCallTxData,
} from "@midnight-ntwrk/midnight-js-contracts";
import { makeContractExecutableRuntime, MidnightProviders } from "@midnight-ntwrk/midnight-js-types";
import { fromHex } from "@midnight-ntwrk/midnight-js-utils";
import {
  ChargedState,
  communicationCommitmentRandomness,
  ContractAddress,
  ContractDeploy,
  ContractMaintenanceAuthority,
  ContractOperationVersionedVerifierKey,
  ContractState as LedgerContractState,
  Intent,
  MaintenanceUpdate,
  maxField,
  rawTokenType,
  signData,
  signingKeyFromBip340,
  Transaction,
  type CommunicationCommitmentRand,
  VerifierKeyInsert,
} from "@midnight-ntwrk/ledger-v8";

import {
  AMM_BATCHER_SECRET,
  AMM_DEPLOY_CIRCUIT_BATCH_SIZE,
  AMM_FEE_BPS,
  BURN_LP_IN,
  GENESIS_SEED_HEX,
  INITIAL_X_LIQ,
  INITIAL_Y_LIQ,
  MINT_LP_X_IN,
  MINT_LP_Y_IN,
  ORDER_OWNER_SECRET,
  SWAP_X_IN,
  SWAP_Y_IN,
  X_TOKEN_NAME,
  Y_TOKEN_NAME,
  ZAP_IN_X_IN,
  ZAP_IN_Y_IN,
  ZAP_OUT_X_LP_IN,
  ZAP_OUT_Y_LP_IN,
} from "./Constants";
import * as Amm from "./Amm";
import * as BurnLpOrder from "./BurnLpOrder";
import * as MarketOrder from "./MarketOrder";
import * as MintLpOrder from "./MintLpOrder";
import * as Wallet from "./Wallet";
import {
  buildCompiledContract,
  bytes32,
  littleEndianHexToField,
  submitUnprovenTx,
} from "./integ-support";
import { mergeContractCallTxs, type MergeContractCallTxData } from "./merge";
import { makeMidnightProviders, ownerPubKey, shieldedRecipient } from "./Providers/MidnightProviders";

import * as faucetModule from "../../dist/faucet/contract";
import * as ammModule from "../../dist/amm/contract";
import * as mintLpOrderModule from "../../dist/mintlporder/contract";
import * as burnLpOrderModule from "../../dist/burnlporder/contract";
import * as marketOrderModule from "../../dist/marketorder/contract";

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
type LocalOutput = ZswapLocalState["outputs"][number];

type TypedModule<C extends CompactContract.Any, W extends object> = {
  Contract: new (witnesses: W) => C;
};

type OwnerSecretContext = { privateState: undefined };
type OwnerSecretWitnesses = {
  newNonce(context: OwnerSecretContext): [undefined, Uint8Array];
  ownerSecret(context: OwnerSecretContext): [undefined, Uint8Array];
};
type OwnerCommitmentContract = {
  _persistentHash_1(value: [Uint8Array, Uint8Array]): Uint8Array;
};
type OwnerCommitmentModule = {
  Contract: new (witnesses: OwnerSecretWitnesses) => unknown;
};

type TokenKind = "dust" | "shielded" | "unshielded";

const DIST = path.resolve(process.cwd(), "dist");

function deterministicNonce(index: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[30] = (index >> 8) & 0xff;
  bytes[31] = index & 0xff;
  return bytes;
}

function makeNonceWitness(seed: number) {
  let index = seed;
  return (context: { privateState: undefined }): [undefined, Uint8Array] => {
    index += 1;
    return [context.privateState, deterministicNonce(index)];
  };
}

function encodeTokenName(name: string): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode(name).slice(0, bytes.length));
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

function calcSwapXToY(state: Pick<Amm.Parameters, "feeBps" | "xLiquidity" | "yLiquidity">, xIn: bigint) {
  const xFee = (xIn * state.feeBps + 9999n) / 10000n;
  const yOut = state.yLiquidity - ((state.xLiquidity * state.yLiquidity) + (state.xLiquidity + xIn - xFee) - 1n) / (state.xLiquidity + xIn - xFee);
  return { xFee, yOut };
}

function calcSwapYToX(state: Pick<Amm.Parameters, "feeBps" | "xLiquidity" | "yLiquidity">, yIn: bigint) {
  const xOutAndFee = state.xLiquidity - ((state.xLiquidity * state.yLiquidity) + (state.yLiquidity + yIn) - 1n) / (state.yLiquidity + yIn);
  const xOut = (xOutAndFee * (10000n - state.feeBps)) / 10000n;
  const xFee = xOutAndFee - xOut;
  return { xFee, xOut };
}

function calcLpOut(state: Amm.Parameters, xIn: bigint, yIn: bigint) {
  const byX = (xIn * state.lpCirculatingSupply) / state.xLiquidity;
  const byY = (yIn * state.lpCirculatingSupply) / state.yLiquidity;
  return byX < byY ? byX : byY;
}

function calcWithdrawXY(state: Amm.Parameters, lpIn: bigint) {
  return {
    xOut: (lpIn * state.xLiquidity) / state.lpCirculatingSupply,
    yOut: (lpIn * state.yLiquidity) / state.lpCirculatingSupply,
  };
}

function findZapInX(state: Amm.Parameters, xIn: bigint) {
  for (let xSwap = 1n; xSwap < xIn; xSwap += 1n) {
    const { xFee, yOut: ySwap } = calcSwapXToY(state, xSwap);
    const xLiqAfterSwap = state.xLiquidity + xSwap - xFee;
    const yLiqAfterSwap = state.yLiquidity - ySwap;
    const xAdded = xIn - xSwap;
    const yAdded = ySwap;
    if (xAdded * yLiqAfterSwap > yAdded * xLiqAfterSwap || (xAdded + 1n) * yLiqAfterSwap < yAdded * xLiqAfterSwap) {
      continue;
    }
    const lpOut = (xAdded * state.lpCirculatingSupply) / xLiqAfterSwap;
    if (lpOut * xLiqAfterSwap <= xAdded * state.lpCirculatingSupply && (lpOut + 1n) * xLiqAfterSwap >= xAdded * state.lpCirculatingSupply) {
      return { xSwap, xFee, ySwap, lpOut };
    }
  }
  throw new Error("Failed to derive X zap-in validation args");
}

function findZapInY(state: Amm.Parameters, yIn: bigint) {
  for (let ySwap = 1n; ySwap < yIn; ySwap += 1n) {
    const { xFee, xOut: xSwap } = calcSwapYToX(state, ySwap);
    const xLiqAfterSwap = state.xLiquidity - xSwap - xFee;
    const yLiqAfterSwap = state.yLiquidity + ySwap;
    const xAdded = xSwap;
    const yAdded = yIn - ySwap;
    if (yAdded * xLiqAfterSwap > xAdded * yLiqAfterSwap || (yAdded + 1n) * xLiqAfterSwap < xAdded * yLiqAfterSwap) {
      continue;
    }
    const lpOut = (yAdded * state.lpCirculatingSupply) / yLiqAfterSwap;
    if (lpOut * yLiqAfterSwap <= yAdded * state.lpCirculatingSupply && (lpOut + 1n) * yLiqAfterSwap >= yAdded * state.lpCirculatingSupply) {
      return { ySwap, xFee, xSwap, lpOut };
    }
  }
  throw new Error("Failed to derive Y zap-in validation args");
}

function findZapOutX(state: Amm.Parameters, lpIn: bigint) {
  const maxX = (lpIn * state.xLiquidity) / state.lpCirculatingSupply + 1n;
  const maxY = (lpIn * state.yLiquidity) / state.lpCirculatingSupply + 1n;
  for (let xRemoved = 0n; xRemoved <= maxX; xRemoved += 1n) {
    for (let yRemoved = 0n; yRemoved <= maxY; yRemoved += 1n) {
      if (
        xRemoved * state.lpCirculatingSupply > lpIn * state.xLiquidity ||
        (xRemoved + 1n) * state.lpCirculatingSupply < lpIn * state.xLiquidity ||
        yRemoved * state.lpCirculatingSupply > lpIn * state.yLiquidity ||
        (yRemoved + 1n) * state.lpCirculatingSupply < lpIn * state.yLiquidity
      ) {
        continue;
      }
      const reduced = { ...state, xLiquidity: state.xLiquidity - xRemoved, yLiquidity: state.yLiquidity - yRemoved };
      const { xFee, xOut: xSwap } = calcSwapYToX(reduced, yRemoved);
      return { xOut: xRemoved + xSwap, ySwap: yRemoved, xFee, xSwap };
    }
  }
  throw new Error("Failed to derive X zap-out validation args");
}

function findZapOutY(state: Amm.Parameters, lpIn: bigint) {
  const maxX = (lpIn * state.xLiquidity) / state.lpCirculatingSupply + 1n;
  const maxY = (lpIn * state.yLiquidity) / state.lpCirculatingSupply + 1n;
  for (let xRemoved = 0n; xRemoved <= maxX; xRemoved += 1n) {
    for (let yRemoved = 0n; yRemoved <= maxY; yRemoved += 1n) {
      if (
        xRemoved * state.lpCirculatingSupply > lpIn * state.xLiquidity ||
        (xRemoved + 1n) * state.lpCirculatingSupply < lpIn * state.xLiquidity ||
        yRemoved * state.lpCirculatingSupply > lpIn * state.yLiquidity ||
        (yRemoved + 1n) * state.lpCirculatingSupply < lpIn * state.yLiquidity
      ) {
        continue;
      }
      const reduced = { ...state, xLiquidity: state.xLiquidity - xRemoved, yLiquidity: state.yLiquidity - yRemoved };
      const { xFee, yOut: ySwap } = calcSwapXToY(reduced, xRemoved);
      return { yOut: yRemoved + ySwap, xSwap: xRemoved, xFee, ySwap };
    }
  }
  throw new Error("Failed to derive Y zap-out validation args");
}

function applyInit(state: Amm.Parameters, xIn: bigint, yIn: bigint) {
  const lpOut = BigInt(Math.floor(Math.sqrt(Number(xIn) * Number(yIn))));
  return {
    ...state,
    xLiquidity: state.xLiquidity + xIn,
    yLiquidity: state.yLiquidity + yIn,
    lpCirculatingSupply: state.lpCirculatingSupply + lpOut,
  };
}

function computeOwnerCommitment(contractModule: OwnerCommitmentModule, contractAddress: string) {
  const contract = new contractModule.Contract({
    newNonce: (context) => [context.privateState, deterministicNonce(999)],
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

  await submitUnprovenTx(providers, mintCall.private.unprovenTx);
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
  tokenKindsToBalance?: TokenKind[],
): Promise<void> {
  const callTx = await createSimpleCall(providers, compiledContract, contractAddress, circuitId, args);
  await submitUnprovenTx(providers, callTx.private.unprovenTx, { tokenKindsToBalance });
}

async function submitMerged(
  providers: MidnightProviders,
  first: MergeContractCallTxData,
  second: MergeContractCallTxData,
): Promise<void> {
  await submitUnprovenTx(
    providers,
    mergeContractCallTxs(first, second),
    { tokenKindsToBalance: ["dust"] },
  );
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
  const contractResult = await contractRuntime.runPromise(
    contractExec.initialize(undefined, AMM_FEE_BPS, shieldedRecipient(providers), xColor, yColor),
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
  await submitTx(providers, {
    unprovenTx: Transaction.fromParts(
      "undeployed",
      undefined,
      undefined,
      Intent.new(new Date(Date.now() + 60 * 60 * 1000)).addDeploy(contractDeploy),
    ),
  });

  const contractAddress: ContractAddress = contractDeploy.address;
  const maintenanceTxIds: string[] = [];
  const allMaintenanceBatches: string[][] = [firstTxCircuitIds, ...maintenanceCircuitBatches];
  console.log(`[integ] AMM deploy: contract address ${contractAddress}`);
  console.log(`[integ] AMM deploy: ${provableCircuitIds.length} provable circuits total`);

  for (const [batchIndex, circuitBatch] of allMaintenanceBatches.entries()) {
    const contractState = await providers.publicDataProvider.queryContractState(contractAddress);
    if (!contractState) {
      throw new Error(`Missing on-chain contract state for ${contractAddress}`);
    }

    const verifierKeyInserts: VerifierKeyInsert[] = [];
    const candidates = batchIndex === 0 ? firstBatchVerifierKeyInserts : [];
    for (const insert of candidates) {
      if (contractState.operation(insert.operation) == null) {
        verifierKeyInserts.push(insert);
      }
    }
    if (batchIndex > 0) {
      for (const circuitId of circuitBatch) {
        if (contractState.operation(circuitId) != null) {
          continue;
        }
        const verifierKey = await providers.zkConfigProvider.getVerifierKey(circuitId);
        verifierKeyInserts.push(
          new VerifierKeyInsert(circuitId, new ContractOperationVersionedVerifierKey("v3", verifierKey)),
        );
      }
    }
    if (verifierKeyInserts.length === 0) {
      continue;
    }

    const maintenanceUpdate = new MaintenanceUpdate(
      contractAddress,
      verifierKeyInserts,
      contractState.maintenanceAuthority.counter,
    );
    const signedMaintenanceUpdate = maintenanceUpdate.addSignature(
      0n,
      signData(batchSigningKey, maintenanceUpdate.dataToSign),
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
    console.log(`[integ] AMM deploy: submitted maintenance batch ${batchIndex + 1}/${allMaintenanceBatches.length}`);
  }

  return { contractAddress: contractAddress as ContractAddress, maintenanceTxIds };
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

function contractAddress(deployed: DeployedContract<CompactContract.Any>, description: string): string {
  const address = deployed.deployTxData.public.contractAddress as string;
  assertString(address, `Missing ${description} address`);
  return address;
}

async function main() {
  console.log("[integ] Creating genesis wallet");
  const wallet = await Wallet.makeContext(GENESIS_SEED_HEX);
  const providers = makeMidnightProviders(wallet);

  console.log("[integ] Building compiled contracts");
  const faucetCompiled: FaucetCompiledContract = buildCompiledContract(
    faucetModule as TypedModule<FaucetInstance, FaucetWitnesses>,
    path.join(DIST, "faucet"),
  ) as unknown as FaucetCompiledContract;
  const ammCompiled: AmmCompiledContract = buildCompiledContract(
    ammModule as TypedModule<AmmInstance, AmmWitnesses>,
    path.join(DIST, "amm"),
    {
      newNonce: makeNonceWitness(1_000),
      batcherSecret: (context: { privateState: undefined }) => [context.privateState, AMM_BATCHER_SECRET],
    },
  ) as unknown as AmmCompiledContract;
  const mintLpOrderCompiled: MintLpOrderCompiledContract = buildCompiledContract(
    mintLpOrderModule as TypedModule<MintLpOrderInstance, MintLpOrderWitnesses>,
    path.join(DIST, "mintlporder"),
    {
      newNonce: makeNonceWitness(2_000),
      ownerSecret: (context: { privateState: undefined }) => [context.privateState, ORDER_OWNER_SECRET],
    },
  ) as unknown as MintLpOrderCompiledContract;
  const burnLpOrderCompiled: BurnLpOrderCompiledContract = buildCompiledContract(
    burnLpOrderModule as TypedModule<BurnLpOrderInstance, BurnLpOrderWitnesses>,
    path.join(DIST, "burnlporder"),
    {
      newNonce: makeNonceWitness(3_000),
      ownerSecret: (context: { privateState: undefined }) => [context.privateState, ORDER_OWNER_SECRET],
    },
  ) as unknown as BurnLpOrderCompiledContract;
  const marketOrderCompiled: MarketOrderCompiledContract = buildCompiledContract(
    marketOrderModule as TypedModule<MarketOrderInstance, MarketOrderWitnesses>,
    path.join(DIST, "marketorder"),
    {
      newNonce: makeNonceWitness(4_000),
      ownerSecret: (context: { privateState: undefined }) => [context.privateState, ORDER_OWNER_SECRET],
    },
  ) as unknown as MarketOrderCompiledContract;

  console.log("[integ] Verifying AMM circuit coverage");
  const ammCircuitIds = ContractExecutable.make(ammCompiled).getProvableCircuitIds();
  assertEqual(ammCircuitIds.length, Amm.Operations.length, "Unexpected AMM circuit count");
  for (const operation of Amm.Operations) {
    assert((ammCircuitIds as readonly string[]).includes(operation), `Missing compiled AMM operation ${operation}`);
  }

  console.log("[integ] Deploying faucet");
  const faucetAddress = contractAddress(await deployContractForTest(providers, faucetCompiled, [], "faucet"), "faucet");

  console.log("[integ] Minting token supply");
  const xCoinBefore = await Wallet.coins(wallet);
  await mintShieldedToken(providers, faucetCompiled, faucetAddress, X_TOKEN_NAME, INITIAL_X_LIQ + MINT_LP_X_IN + SWAP_X_IN + ZAP_IN_X_IN, deterministicNonce(1));
  const xCoin = await Wallet.waitForNewCoin(wallet, xCoinBefore);
  const xColor = bytes32(xCoin.coin.type);
  const yCoinBefore = await Wallet.coins(wallet);
  await mintShieldedToken(providers, faucetCompiled, faucetAddress, Y_TOKEN_NAME, INITIAL_Y_LIQ + MINT_LP_Y_IN + SWAP_Y_IN + ZAP_IN_Y_IN, deterministicNonce(2));
  const yCoin = await Wallet.waitForNewCoin(wallet, yCoinBefore);
  const yColor = bytes32(yCoin.coin.type);
  assert(!Buffer.from(xColor).equals(Buffer.from(yColor)), "X and Y colors must differ");

  console.log("[integ] Deploying AMM");
  const amm = await deployAmmSplit(providers, ammCompiled, xColor, yColor);
  assert(amm.maintenanceTxIds.length > 0, "AMM maintenance tx ids should not be empty");
  const ammAddress = amm.contractAddress;
  const lpColor = bytes32(rawTokenType(encodeTokenName("Pulse LP Token"), ammAddress));
  const ammEndpoints = createCircuitCallTxInterface<AmmInstance>(
    providers as ContractProviders<AmmInstance>,
    ammCompiled,
    ammAddress,
    undefined,
  );

  const deployedAmmState = await providers.publicDataProvider.queryContractState(ammAddress);
  assert(deployedAmmState, `Missing AMM state for ${ammAddress}`);
  for (const operation of Amm.Operations) {
    assert(deployedAmmState.operation(operation) != null, `Missing AMM operation ${operation}`);
  }

  console.log("[integ] Initializing AMM liquidity");
  const initLpOut = BigInt(Math.floor(Math.sqrt(Number(INITIAL_X_LIQ) * Number(INITIAL_Y_LIQ))));
  await ammEndpoints.AmmInitXYLiq(
    INITIAL_X_LIQ,
    INITIAL_Y_LIQ,
    initLpOut,
    shieldedRecipient(providers),
    deterministicNonce(10),
  );

  let ammLedger = await Amm.readState(providers, ammAddress);
  assertEqual(ammLedger.xLiquidity, INITIAL_X_LIQ, "Unexpected initial X liquidity");
  assertEqual(ammLedger.yLiquidity, INITIAL_Y_LIQ, "Unexpected initial Y liquidity");
  assertEqual(ammLedger.lpCirculatingSupply, initLpOut, "Unexpected initial LP supply");

  let expected: Amm.Parameters = applyInit({
    feeBps: AMM_FEE_BPS,
    xLiquidity: 0n,
    yLiquidity: 0n,
    xRewards: 0n,
    lpCirculatingSupply: 0n,
  }, INITIAL_X_LIQ, INITIAL_Y_LIQ);

  console.log("[integ] Deploying order contracts");
  const mintOrderAddress = contractAddress(
    await deployContractForTest(
      providers,
      mintLpOrderCompiled,
      [fromHex(entryPointHash("MintLpOrderReceiveFromAmm"))],
      "mint-lp-order",
    ),
    "mint LP order",
  );
  const burnOrderAddress = contractAddress(
    await deployContractForTest(
      providers,
      burnLpOrderCompiled,
      [fromHex(entryPointHash("BurnLpOrderReceiveCoinFromAmm")), fromHex(entryPointHash("AmmClearOrder"))],
      "burn-lp-order",
    ),
    "burn LP order",
  );

  console.log("[integ] Running mint LP order flow");
  const mintSlot = 1n;
  await submitCall(providers, mintLpOrderCompiled, mintOrderAddress, "MintLpOrderOpen", [{
    ownerCommitment: computeOwnerCommitment(mintLpOrderModule, mintOrderAddress),
    amm: Amm.circuitIds(ammAddress, "AmmFundOrderX", "AmmFundOrderY"),
    xAmountSent: MINT_LP_X_IN,
    yAmountSent: MINT_LP_Y_IN,
    xColorSent: xColor,
    yColorSent: yColor,
    colorReturned: lpColor,
    returnsTo: ownerPubKey(providers),
  }]);

  const mintReserveOpening = littleEndianHexToField(communicationCommitmentRandomnessAsField());
  await submitMerged(
    providers,
    await createLocalStateCall(providers, mintLpOrderCompiled, mintOrderAddress, "MintLpOrderReserveAmmSlot", [mintSlot, mintReserveOpening]),
    await createLocalStateCall(providers, ammCompiled, ammAddress, "AmmPlaceOrder", [
      mintSlot,
      Amm.OrderKind.DepositXYLiq,
      MINT_LP_X_IN,
      MINT_LP_Y_IN,
      Amm.circuitId(mintOrderAddress, "MintLpOrderReceiveFromAmm"),
    ]),
  );

  const mintXOpening = littleEndianHexToField(communicationCommitmentRandomnessAsField());
  const mintSendX = await createLocalStateCall(providers, mintLpOrderCompiled, mintOrderAddress, "MintLpOrderSendXCoinToAmm", [mintXOpening]);
  const mintForwardedX = findOutput(mintSendX.zswapLocalState.outputs, (output) => !output.recipient.is_left && output.coinInfo.value === MINT_LP_X_IN, "mint forwarded X");
  await submitMerged(
    providers,
    mintSendX,
    await createLocalStateCall(providers, ammCompiled, ammAddress, "AmmFundOrderX", [mintSlot, bytes32(mintForwardedX.coinInfo.nonce)]),
  );

  const mintYOpening = littleEndianHexToField(communicationCommitmentRandomnessAsField());
  const mintSendY = await createLocalStateCall(providers, mintLpOrderCompiled, mintOrderAddress, "MintLpOrderSendYCoinToAmm", [mintYOpening]);
  const mintForwardedY = findOutput(mintSendY.zswapLocalState.outputs, (output) => !output.recipient.is_left && output.coinInfo.value === MINT_LP_Y_IN, "mint forwarded Y");
  await submitMerged(
    providers,
    mintSendY,
    await createLocalStateCall(providers, ammCompiled, ammAddress, "AmmFundOrderY", [mintSlot, bytes32(mintForwardedY.coinInfo.nonce)]),
  );

  const mintLpOut = calcLpOut(expected, MINT_LP_X_IN, MINT_LP_Y_IN);
  await submitCall(providers, ammCompiled, ammAddress, "AmmActivateOrder", [mintSlot], ["dust"]);
  await submitCall(providers, ammCompiled, ammAddress, "AmmValidateDepositXYLiq", [mintLpOut], ["dust"]);
  await submitCall(providers, ammCompiled, ammAddress, "AmmMintLp", [], ["dust"]);
  const mintPayOpening = littleEndianHexToField(communicationCommitmentRandomnessAsField());
  const mintPay = await createLocalStateCall(providers, ammCompiled, ammAddress, "AmmPayLp", [mintSlot, mintPayOpening]);
  const mintLpOutput = findOutput(mintPay.zswapLocalState.outputs, (output) => !output.recipient.is_left && output.coinInfo.value === mintLpOut, "mint paid LP");
  await submitMerged(
    providers,
    mintPay,
    await createLocalStateCall(providers, mintLpOrderCompiled, mintOrderAddress, "MintLpOrderReceiveFromAmm", [BigInt(MarketOrder.ReturnKind.Lp), mintLpOut, bytes32(mintLpOutput.coinInfo.nonce)]),
  );

  expected = {
    ...expected,
    xLiquidity: expected.xLiquidity + MINT_LP_X_IN,
    yLiquidity: expected.yLiquidity + MINT_LP_Y_IN,
    lpCirculatingSupply: expected.lpCirculatingSupply + mintLpOut,
  };
  ammLedger = await Amm.readState(providers, ammAddress);
  assertEqual(ammLedger.xLiquidity, expected.xLiquidity, "Unexpected X liquidity after mint LP");
  assertEqual(ammLedger.yLiquidity, expected.yLiquidity, "Unexpected Y liquidity after mint LP");
  assertEqual(ammLedger.lpCirculatingSupply, expected.lpCirculatingSupply, "Unexpected LP supply after mint LP");
  assertEqual((await MintLpOrder.readState(providers, mintOrderAddress)).ammSlot, mintSlot, "Mint LP order should retain its AMM slot before close");

  console.log("[integ] Running burn LP order flow");
  const burnSlot = 2n;
  const { xOut: burnXOut, yOut: burnYOut } = calcWithdrawXY(expected, BURN_LP_IN);
  await submitCall(providers, burnLpOrderCompiled, burnOrderAddress, "BurnLpOrderOpen", [{
    ownerCommitment: computeOwnerCommitment(burnLpOrderModule, burnOrderAddress),
    amm: Amm.circuitIds(ammAddress, "AmmFundOrderLp"),
    amountSent: BURN_LP_IN,
    colorSent: lpColor,
    xColorReturned: xColor,
    yColorReturned: yColor,
    returnsTo: ownerPubKey(providers),
  }]);
  const burnReserveOpening = littleEndianHexToField(communicationCommitmentRandomnessAsField());
  await submitMerged(
    providers,
    await createLocalStateCall(providers, burnLpOrderCompiled, burnOrderAddress, "BurnLpOrderReserveAmmSlot", [burnSlot, burnReserveOpening]),
    await createLocalStateCall(providers, ammCompiled, ammAddress, "AmmPlaceOrder", [
      burnSlot,
      Amm.OrderKind.WithdrawXYLiq,
      BURN_LP_IN,
      0n,
      Amm.circuitId(burnOrderAddress, "BurnLpOrderReceiveCoinFromAmm"),
    ]),
  );
  const burnSendOpening = littleEndianHexToField(communicationCommitmentRandomnessAsField());
  const burnSend = await createLocalStateCall(providers, burnLpOrderCompiled, burnOrderAddress, "BurnLpOrderSendCoinToAmm", [burnSendOpening]);
  const burnForwarded = findOutput(burnSend.zswapLocalState.outputs, (output) => !output.recipient.is_left && output.coinInfo.value === BURN_LP_IN, "burn forwarded LP");
  await submitMerged(
    providers,
    burnSend,
    await createLocalStateCall(providers, ammCompiled, ammAddress, "AmmFundOrderLp", [burnSlot, bytes32(burnForwarded.coinInfo.nonce)]),
  );
  await submitCall(providers, ammCompiled, ammAddress, "AmmActivateOrder", [burnSlot], ["dust"]);
  await submitCall(providers, ammCompiled, ammAddress, "AmmValidateWithdrawXYLiq", [burnXOut, burnYOut], ["dust"]);
  await submitCall(providers, ammCompiled, ammAddress, "AmmSplitX", [], ["dust"]);
  await submitCall(providers, ammCompiled, ammAddress, "AmmSplitY", [], ["dust"]);
  const burnPayXOpening = littleEndianHexToField(communicationCommitmentRandomnessAsField());
  const burnPayX = await createLocalStateCall(providers, ammCompiled, ammAddress, "AmmPayX", [burnSlot, burnPayXOpening]);
  const burnXOutput = findOutput(burnPayX.zswapLocalState.outputs, (output) => !output.recipient.is_left && output.coinInfo.value === burnXOut, "burn paid X");
  await submitMerged(
    providers,
    burnPayX,
    await createLocalStateCall(providers, burnLpOrderCompiled, burnOrderAddress, "BurnLpOrderReceiveCoinFromAmm", [BurnLpOrder.ReturnKind.X, burnXOut, bytes32(burnXOutput.coinInfo.nonce)]),
  );
  const burnPayYOpening = littleEndianHexToField(communicationCommitmentRandomnessAsField());
  const burnPayY = await createLocalStateCall(providers, ammCompiled, ammAddress, "AmmPayY", [burnSlot, burnPayYOpening]);
  const burnYOutput = findOutput(burnPayY.zswapLocalState.outputs, (output) => !output.recipient.is_left && output.coinInfo.value === burnYOut, "burn paid Y");
  await submitMerged(
    providers,
    burnPayY,
    await createLocalStateCall(providers, burnLpOrderCompiled, burnOrderAddress, "BurnLpOrderReceiveCoinFromAmm", [BurnLpOrder.ReturnKind.Y, burnYOut, bytes32(burnYOutput.coinInfo.nonce)]),
  );
  const burnCloseOpening = littleEndianHexToField(communicationCommitmentRandomnessAsField());
  const coinBeforeBurnClose = await Wallet.coins(wallet);
  await submitMerged(
    providers,
    await createLocalStateCall(providers, burnLpOrderCompiled, burnOrderAddress, "BurnLpOrderCloseX", [burnCloseOpening]),
    await createLocalStateCall(providers, ammCompiled, ammAddress, "AmmClearOrder", [burnSlot]),
  );
  await submitCall(providers, burnLpOrderCompiled, burnOrderAddress, "BurnLpOrderCloseY", [], ["dust"]);
  await Wallet.waitForNewCoin(wallet, coinBeforeBurnClose, xColor);
  await Wallet.waitForNewCoin(wallet, coinBeforeBurnClose, yColor);

  expected = {
    ...expected,
    xLiquidity: expected.xLiquidity - burnXOut,
    yLiquidity: expected.yLiquidity - burnYOut,
    lpCirculatingSupply: expected.lpCirculatingSupply - BURN_LP_IN,
  };

  async function runMarketOrderCase<PCK extends AmmCircuitId>(
    label: string,
    slot: bigint,
    inputAmount: bigint,
    inputColor: Uint8Array,
    orderKind: number,
    fundCircuit: "AmmFundOrderX" | "AmmFundOrderY" | "AmmFundOrderLp",
    returnColor: Uint8Array,
    validateCircuit: PCK,
    validateArgs: CompactContract.CircuitParameters<AmmInstance, PCK>,
    settleCircuit: "AmmMintLp" | "AmmSplitX" | "AmmSplitY",
    payCircuit: "AmmPayX" | "AmmPayY" | "AmmPayLp",
    returnKind: number,
    outputAmount: bigint,
    expectedNext: Amm.Parameters,
  ) {
    console.log(`[integ] Running market order case ${label}`);
    const marketOrderAddress = contractAddress(
      await deployContractForTest(
        providers,
        marketOrderCompiled,
        [fromHex(entryPointHash("MarketOrderReceiveCoinFromAmm"))],
        `market-order-${label}`,
      ),
      `${label} market order`,
    );
    await submitCall(providers, marketOrderCompiled, marketOrderAddress, "MarketOrderOpen", [{
      ownerCommitment: computeOwnerCommitment(marketOrderModule, marketOrderAddress),
      amm: Amm.circuitIds(ammAddress, fundCircuit),
      kind: orderKind,
      amountSent: inputAmount,
      colorSent: inputColor,
      colorReturned: returnColor,
      returnsTo: ownerPubKey(providers),
    }]);
    const reserveOpening = littleEndianHexToField(communicationCommitmentRandomnessAsField());
    await submitMerged(
      providers,
      await createLocalStateCall(providers, marketOrderCompiled, marketOrderAddress, "MarketOrderReserveAmmSlot", [slot, reserveOpening]),
      await createLocalStateCall(providers, ammCompiled, ammAddress, "AmmPlaceOrder", [
        slot,
        orderKind,
        orderKind === Amm.OrderKind.SwapYToX || orderKind === Amm.OrderKind.DepositYLiq ? 0n : inputAmount,
        orderKind === Amm.OrderKind.SwapYToX || orderKind === Amm.OrderKind.DepositYLiq ? inputAmount : 0n,
        Amm.circuitId(marketOrderAddress, "MarketOrderReceiveCoinFromAmm"),
      ]),
    );
    const fundOpening = littleEndianHexToField(communicationCommitmentRandomnessAsField());
    const marketSend = await createLocalStateCall(providers, marketOrderCompiled, marketOrderAddress, "MarketOrderSendCoinToAmm", [fundOpening]);
    const forwarded = findOutput(marketSend.zswapLocalState.outputs, (output) => !output.recipient.is_left && output.coinInfo.value === inputAmount, `${label} forwarded input`);
    await submitMerged(
      providers,
      marketSend,
      await createLocalStateCall(providers, ammCompiled, ammAddress, fundCircuit, [slot, bytes32(forwarded.coinInfo.nonce)]),
    );
    await submitCall(providers, ammCompiled, ammAddress, "AmmActivateOrder", [slot], ["dust"]);
    await submitCall(providers, ammCompiled, ammAddress, validateCircuit, validateArgs, ["dust"]);
    await submitCall(providers, ammCompiled, ammAddress, settleCircuit, [], ["dust"]);
    const payOpening = littleEndianHexToField(communicationCommitmentRandomnessAsField());
    const pay = await createLocalStateCall(providers, ammCompiled, ammAddress, payCircuit, [slot, payOpening]);
    const returnedOutput = findOutput(pay.zswapLocalState.outputs, (output) => !output.recipient.is_left && output.coinInfo.value === outputAmount, `${label} paid output`);
    await submitMerged(
      providers,
      pay,
      await createLocalStateCall(providers, marketOrderCompiled, marketOrderAddress, "MarketOrderReceiveCoinFromAmm", [returnKind, outputAmount, bytes32(returnedOutput.coinInfo.nonce)]),
    );
    const closeOpening = littleEndianHexToField(communicationCommitmentRandomnessAsField());
    const coinBeforeClose = await Wallet.coins(wallet);
    await submitMerged(
      providers,
      await createLocalStateCall(providers, marketOrderCompiled, marketOrderAddress, "MarketOrderClose", [closeOpening]),
      await createLocalStateCall(providers, ammCompiled, ammAddress, "AmmClearOrder", [slot]),
    );
    await Wallet.waitForNewCoin(wallet, coinBeforeClose, returnColor);
    expected = expectedNext;
    assert(!(await MarketOrder.readState(providers, marketOrderAddress)).coins.member(0n), `${label} market order should be closed`);
  }

  await runMarketOrderCase(
    "swap-x-to-y",
    3n,
    SWAP_X_IN,
    xColor,
    Amm.OrderKind.SwapXToY,
    "AmmFundOrderX",
    yColor,
    "AmmValidateSwapXToY",
    [calcSwapXToY(expected, SWAP_X_IN).xFee, calcSwapXToY(expected, SWAP_X_IN).yOut],
    "AmmSplitY",
    "AmmPayY",
    MarketOrder.ReturnKind.Y,
    calcSwapXToY(expected, SWAP_X_IN).yOut,
    {
      ...expected,
      xLiquidity: expected.xLiquidity + SWAP_X_IN - calcSwapXToY(expected, SWAP_X_IN).xFee,
      yLiquidity: expected.yLiquidity - calcSwapXToY(expected, SWAP_X_IN).yOut,
      xRewards: expected.xRewards + calcSwapXToY(expected, SWAP_X_IN).xFee,
    },
  );

  const swapY = calcSwapYToX(expected, SWAP_Y_IN);
  await runMarketOrderCase(
    "swap-y-to-x",
    4n,
    SWAP_Y_IN,
    yColor,
    Amm.OrderKind.SwapYToX,
    "AmmFundOrderY",
    xColor,
    "AmmValidateSwapYToX",
    [swapY.xFee, swapY.xOut],
    "AmmSplitX",
    "AmmPayX",
    MarketOrder.ReturnKind.X,
    swapY.xOut,
    {
      ...expected,
      xLiquidity: expected.xLiquidity - swapY.xOut - swapY.xFee,
      yLiquidity: expected.yLiquidity + SWAP_Y_IN,
      xRewards: expected.xRewards + swapY.xFee,
    },
  );

  const zapInX = findZapInX(expected, ZAP_IN_X_IN);
  await runMarketOrderCase(
    "zap-in-x",
    5n,
    ZAP_IN_X_IN,
    xColor,
    Amm.OrderKind.DepositXLiq,
    "AmmFundOrderX",
    lpColor,
    "AmmValidateDepositXLiq",
    [zapInX.xSwap, zapInX.xFee, zapInX.ySwap, zapInX.lpOut],
    "AmmMintLp",
    "AmmPayLp",
    MarketOrder.ReturnKind.Lp,
    zapInX.lpOut,
    {
      ...expected,
      xLiquidity: expected.xLiquidity + ZAP_IN_X_IN - zapInX.xFee,
      yLiquidity: expected.yLiquidity,
      xRewards: expected.xRewards + zapInX.xFee,
      lpCirculatingSupply: expected.lpCirculatingSupply + zapInX.lpOut,
    },
  );

  const zapInY = findZapInY(expected, ZAP_IN_Y_IN);
  await runMarketOrderCase(
    "zap-in-y",
    6n,
    ZAP_IN_Y_IN,
    yColor,
    Amm.OrderKind.DepositYLiq,
    "AmmFundOrderY",
    lpColor,
    "AmmValidateDepositYLiq",
    [zapInY.ySwap, zapInY.xFee, zapInY.xSwap, zapInY.lpOut],
    "AmmMintLp",
    "AmmPayLp",
    MarketOrder.ReturnKind.Lp,
    zapInY.lpOut,
    {
      ...expected,
      xLiquidity: expected.xLiquidity - zapInY.xFee,
      yLiquidity: expected.yLiquidity + ZAP_IN_Y_IN,
      xRewards: expected.xRewards + zapInY.xFee,
      lpCirculatingSupply: expected.lpCirculatingSupply + zapInY.lpOut,
    },
  );

  const zapOutX = findZapOutX(expected, ZAP_OUT_X_LP_IN);
  await runMarketOrderCase(
    "zap-out-x",
    7n,
    ZAP_OUT_X_LP_IN,
    lpColor,
    Amm.OrderKind.WithdrawXLiq,
    "AmmFundOrderLp",
    xColor,
    "AmmValidateWithdrawXLiq",
    [zapOutX.xOut, zapOutX.ySwap, zapOutX.xFee, zapOutX.xSwap],
    "AmmSplitX",
    "AmmPayX",
    MarketOrder.ReturnKind.X,
    zapOutX.xOut,
    {
      ...expected,
      xLiquidity: expected.xLiquidity - zapOutX.xOut - zapOutX.xFee,
      yLiquidity: expected.yLiquidity,
      xRewards: expected.xRewards + zapOutX.xFee,
      lpCirculatingSupply: expected.lpCirculatingSupply - ZAP_OUT_X_LP_IN,
    },
  );

  const zapOutY = findZapOutY(expected, ZAP_OUT_Y_LP_IN);
  await runMarketOrderCase(
    "zap-out-y",
    8n,
    ZAP_OUT_Y_LP_IN,
    lpColor,
    Amm.OrderKind.WithdrawYLiq,
    "AmmFundOrderLp",
    yColor,
    "AmmValidateWithdrawYLiq",
    [zapOutY.yOut, zapOutY.xSwap, zapOutY.xFee, zapOutY.ySwap],
    "AmmSplitY",
    "AmmPayY",
    MarketOrder.ReturnKind.Y,
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
  ammLedger = await Amm.readState(providers, ammAddress);
  assertEqual(ammLedger.xLiquidity, expected.xLiquidity, "Unexpected final X liquidity");
  assertEqual(ammLedger.yLiquidity, expected.yLiquidity, "Unexpected final Y liquidity");
  assertEqual(ammLedger.lpCirculatingSupply, expected.lpCirculatingSupply, "Unexpected final LP supply");
  assertEqual(ammLedger.xRewards, expected.xRewards, "Unexpected final X rewards");
  assert(!(await BurnLpOrder.readState(providers, burnOrderAddress)).coins.member(0n), "Burn LP order should be closed");
  console.log("[integ] Integration flow completed successfully");
}

await main();
