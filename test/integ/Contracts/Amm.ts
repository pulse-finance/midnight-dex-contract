import { equal, ok } from "node:assert"
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CompiledContract, ContractExecutable } from "@midnight-ntwrk/compact-js";
import { entryPointHash } from "@midnight-ntwrk/compact-runtime";
import { ChargedState, ContractAddress, ContractDeploy, ContractMaintenanceAuthority, ContractOperationVersionedVerifierKey, ContractState, Intent, MaintenanceUpdate, rawTokenType, signData, signingKeyFromBip340, Transaction, VerifierKeyInsert } from "@midnight-ntwrk/ledger-v8";
import { makeContractExecutableRuntime, MidnightProviders } from "@midnight-ntwrk/midnight-js-types";
import { ContractProviders, createCircuitCallTxInterface, getPublicStates, submitTx } from "@midnight-ntwrk/midnight-js-contracts";
import { Contract as AmmContract, type Ledger, ledger, Witnesses as AmmWitnesses } from "../../../dist/amm/contract"
import { fromHex } from "@midnight-ntwrk/midnight-js-utils";
import { AMM_BATCHER_SECRET, AMM_DEPLOY_CIRCUIT_BATCH_SIZE, AMM_FEE_BPS } from "../Constants";
import * as Addresses from "./Addresses"
import * as Tokens from "./Tokens"
import * as Witnesses from "./Witnesses"

export { type Ledger }

type AmmInstance = AmmContract<undefined, AmmWitnesses<undefined>>

export type Parameters = Omit<Ledger, "treasury" | "batcherCommitment" | "xColor" | "yColor" | "slots" | "active" | "coins">

export const ReturnKind = {
  X: 0,
  Y: 1,
  Lp: 2,
} as const;

export type CircuitIds = {
  address: { bytes: Uint8Array };
  placeOrder: Uint8Array;
  fundOrder: Uint8Array;
  fundOrderAlt: Uint8Array;
  clearOrder: Uint8Array;
};

export const OrderKind = {
  DepositXYLiq: 0,
  DepositXLiq: 1,
  DepositYLiq: 2,
  SwapXToY: 3,
  SwapYToX: 4,
  WithdrawXYLiq: 5,
  WithdrawXLiq: 6,
  WithdrawYLiq: 7,
} as const;

export const CircuitNames = [
  "AmmXLiq",
  "AmmYLiq",
  "AmmInitXYLiq",
  "AmmPlaceOrder",
  "AmmFundOrderX",
  "AmmFundOrderY",
  "AmmFundOrderLp",
  "AmmMergeCoins",
  "AmmActivateOrder",
  "AmmValidateDepositXYLiq",
  "AmmValidateDepositXLiq",
  "AmmValidateDepositYLiq",
  "AmmValidateSwapXToY",
  "AmmValidateSwapYToX",
  "AmmValidateWithdrawXYLiq",
  "AmmValidateWithdrawXLiq",
  "AmmValidateWithdrawYLiq",
  "AmmMintLp",
  "AmmSplitX",
  "AmmSplitY",
  "AmmPayX",
  "AmmPayY",
  "AmmPayLp",
  "AmmClearOrder",
  "AmmReward",
  "AmmUpdate",
] as const;

export type CircuitName = (typeof CircuitNames) extends ReadonlyArray<infer T> ? T : never 

function compile() {
  const withWitnesses = CompiledContract.withWitnesses(CompiledContract.make("Amm", AmmContract), {
    newNonce: Witnesses.newNonce(1_000),
    batcherSecret: Witnesses.actorSecret(AMM_BATCHER_SECRET)
  })

  return CompiledContract.withCompiledFileAssets(
    withWitnesses, 
    dirname(fileURLToPath(import.meta.resolve("../../../dist/amm")))
  )
}

type AmmProps = {
  xColor: Uint8Array,
  yColor: Uint8Array,
  treasury: Addresses.Address
}

async function deploy(
  compiled: CompiledContract.CompiledContract<AmmContract<any, any>, any, never>, 
  {xColor, yColor, treasury}: AmmProps,
  providers: MidnightProviders
) {
  const runtime = makeContractExecutableRuntime(providers.zkConfigProvider, {
    coinPublicKey: providers.walletProvider.getCoinPublicKey(),
    signingKey: Buffer.from(AMM_BATCHER_SECRET).toString("hex"),
  });

  const exec = ContractExecutable.make(compiled);

  const circuitIds: string[] = exec.getProvableCircuitIds();

  equal(circuitIds.length, CircuitNames.length, "Unexpected AMM circuit count");

  for (const operation of CircuitNames) {
    ok(circuitIds.includes(operation), `Missing compiled AMM operation ${operation}`);
  }

  const contractResult = await runtime.runPromise(
    exec.initialize(undefined, AMM_FEE_BPS, treasury, xColor, yColor),
  );

  const fullState = ContractState.deserialize(contractResult.public.contractState.serialize());
  const deployState = new ContractState();
  deployState.data = new ChargedState(fullState.data.state);
  deployState.balance = new Map(fullState.balance);
  deployState.maintenanceAuthority = new ContractMaintenanceAuthority(
    [...fullState.maintenanceAuthority.committee],
    fullState.maintenanceAuthority.threshold,
    fullState.maintenanceAuthority.counter,
  );

  const contractDeploy = new ContractDeploy(deployState);
  
  const batchSigningKey = signingKeyFromBip340(AMM_BATCHER_SECRET);
  await submitTx(providers, {
    unprovenTx: Transaction.fromParts(
      "undeployed",
      undefined,
      undefined,
      Intent.new(new Date(Date.now() + 60 * 60 * 1000)).addDeploy(contractDeploy),
    ),
  });

  const circuitBatches: string[][] = batchesOf(
    circuitIds.slice(AMM_DEPLOY_CIRCUIT_BATCH_SIZE),
    AMM_DEPLOY_CIRCUIT_BATCH_SIZE,
  );

  const contractAddress: ContractAddress = contractDeploy.address;
  
  console.log(`[integ] AMM deploy: contract address ${contractAddress}`);
  console.log(`[integ] AMM deploy: ${circuitIds.length} provable circuits total`);

  for (const [batchIndex, circuitBatch] of circuitBatches.entries()) {
    const contractState = await providers.publicDataProvider.queryContractState(contractAddress);
    if (!contractState) {
      throw new Error(`Missing on-chain contract state for ${contractAddress}`);
    }

    
    const verifierKeyInserts: VerifierKeyInsert[] = [];

    for (const circuitId of circuitBatch) {
      if (contractState.operation(circuitId) != null) {
        continue;
      }

      const verifierKey = await providers.zkConfigProvider.getVerifierKey(circuitId);

      verifierKeyInserts.push(
        new VerifierKeyInsert(circuitId, new ContractOperationVersionedVerifierKey("v3", verifierKey)),
      );
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

    await submitTx(providers, {
      unprovenTx: Transaction.fromParts(
        "undeployed",
        undefined,
        undefined,
        Intent.new(new Date(Date.now() + 60 * 60 * 1000)).addMaintenanceUpdate(signedMaintenanceUpdate),
      ),
    });

    console.log(`[integ] AMM deploy: submitted maintenance batch ${batchIndex + 1}/${circuitBatches.length}`);
  }

  return contractAddress;
}

function batchesOf<T>(items: readonly T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize));
  }
  return batches;
}

export async function make(
  props: AmmProps,
  providers: MidnightProviders
) {
  const compiled = compile()

  const address = await deploy(compiled, props, providers)

  const endpoints = createCircuitCallTxInterface<AmmInstance>(
    providers as ContractProviders<AmmInstance>,
    compiled,
    address,
    undefined,
  );

  return {
    address,
    circuitIds: (fundOrder: CircuitName, fundOrderAlt: CircuitName = fundOrder): CircuitIds => {
      return {
        address: { bytes: fromHex(address) },
        placeOrder: fromHex(entryPointHash("AmmPlaceOrder" satisfies CircuitName)),
        fundOrder: fromHex(entryPointHash(fundOrder)),
        fundOrderAlt: fromHex(entryPointHash(fundOrderAlt)),
        clearOrder: fromHex(entryPointHash("AmmClearOrder" satisfies CircuitName)),
      };
    },
    lpColor: fromHex(rawTokenType(Tokens.encodeName("Pulse LP Token"), address)),
    state: async () => {
      const states = await getPublicStates(providers.publicDataProvider, address);

      return ledger(states.contractState.data);
    },
    initXYLiq: (xLiq: bigint, yLiq: bigint, lpOut: bigint, address: Addresses.Address) => 
      endpoints.AmmInitXYLiq(
        xLiq,
        yLiq,
        lpOut,
        address
      )
  }
}

export function calcInitLpOut(xLiq: bigint, yLiq: bigint) {
  return BigInt(Math.floor(Math.sqrt(Number(xLiq) * Number(yLiq))));
}