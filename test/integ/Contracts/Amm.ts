import { equal, ok } from "node:assert"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { CompiledContract, ContractExecutable } from "@midnight-ntwrk/compact-js"
import type { Contract as CompactContract } from "@midnight-ntwrk/compact-js/effect/Contract"
import { entryPointHash } from "@midnight-ntwrk/compact-runtime"
import {
  ChargedState,
  ContractAddress,
  ContractDeploy,
  ContractMaintenanceAuthority,
  ContractOperationVersionedVerifierKey,
  ContractState,
  Intent,
  MaintenanceUpdate,
  rawTokenType,
  type FinalizedTransaction,
  signData,
  signingKeyFromBip340,
  Transaction,
  VerifierKeyInsert,
} from "@midnight-ntwrk/ledger-v8"
import {
  makeContractExecutableRuntime,
  MidnightProviders,
  type UnboundTransaction,
} from "@midnight-ntwrk/midnight-js-types"
import {
  ContractProviders,
  createCircuitCallTxInterface,
  createUnprovenCallTxFromInitialStates,
  getPublicStates,
  submitTx,
  type UnsubmittedCallTxData,
} from "@midnight-ntwrk/midnight-js-contracts"
import {
  Contract as AmmContract,
  type Ledger,
  ledger,
  Witnesses as AmmWitnesses,
} from "../../../dist/amm/contract"
import { fromHex } from "@midnight-ntwrk/midnight-js-utils"
import { AMM_BATCHER_SECRET, AMM_DEPLOY_CIRCUIT_BATCH_SIZE, AMM_FEE_BPS } from "../Constants"
import { nonceEvolve } from "../integ-support"
import * as Addresses from "./Addresses"
import * as CircuitId from "./CircuitId"
import * as Tokens from "./Tokens"
import * as Witnesses from "./Witnesses"

export { type Ledger }

type AmmInstance = AmmContract<undefined, AmmWitnesses<undefined>>
type TokenKindsToBalance = "all" | Array<"dust" | "shielded" | "unshielded">
type WalletProviderWithTokenKindBalancing = MidnightProviders["walletProvider"] & {
  balanceTx(
    tx: UnboundTransaction,
    ttl?: Date,
    tokenKindsToBalance?: TokenKindsToBalance,
  ): Promise<FinalizedTransaction>
}

export type Parameters = Omit<
  Ledger,
  "treasury" | "batcherCommitment" | "xColor" | "yColor" | "slots" | "active" | "coins"
>

export const ReturnKind = {
  X: 0,
  Y: 1,
  Lp: 2,
} as const

export type CircuitIds = {
  address: { bytes: Uint8Array }
  placeOrder: Uint8Array
  fundOrder: Uint8Array
  fundOrderAlt: Uint8Array
  clearOrder: Uint8Array
}

export const OrderKind = {
  DepositXYLiq: 0,
  DepositXLiq: 1,
  DepositYLiq: 2,
  SwapXToY: 3,
  SwapYToX: 4,
  WithdrawXYLiq: 5,
  WithdrawXLiq: 6,
  WithdrawYLiq: 7,
} as const

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
] as const

export type CircuitName = typeof CircuitNames extends ReadonlyArray<infer T> ? T : never
export type FundCircuit = "AmmFundOrderX" | "AmmFundOrderY" | "AmmFundOrderLp"
export type PayCircuit = "AmmPayX" | "AmmPayY" | "AmmPayLp"

function compile() {
  const withWitnesses = CompiledContract.withWitnesses(CompiledContract.make("Amm", AmmContract), {
    newNonce: Witnesses.newNonce(1_000),
    batcherSecret: Witnesses.actorSecret(AMM_BATCHER_SECRET),
  })

  return CompiledContract.withCompiledFileAssets(
    withWitnesses,
    dirname(fileURLToPath(import.meta.resolve("../../../dist/amm"))),
  )
}

type AmmProps = {
  xColor: Uint8Array
  yColor: Uint8Array
  treasury: Addresses.Address
}

async function deploy(
  compiled: CompiledContract.CompiledContract<AmmContract<any, any>, any, never>,
  { xColor, yColor, treasury }: AmmProps,
  providers: MidnightProviders,
) {
  const runtime = makeContractExecutableRuntime(providers.zkConfigProvider, {
    coinPublicKey: providers.walletProvider.getCoinPublicKey(),
    signingKey: Buffer.from(AMM_BATCHER_SECRET).toString("hex"),
  })

  const exec = ContractExecutable.make(compiled)

  const circuitIds: string[] = exec.getProvableCircuitIds()

  equal(circuitIds.length, CircuitNames.length, "Unexpected AMM circuit count")

  for (const operation of CircuitNames) {
    ok(circuitIds.includes(operation), `Missing compiled AMM operation ${operation}`)
  }

  const contractResult = await runtime.runPromise(
    exec.initialize(undefined, AMM_FEE_BPS, treasury, xColor, yColor),
  )

  const fullState = ContractState.deserialize(contractResult.public.contractState.serialize())
  const deployState = new ContractState()
  deployState.data = new ChargedState(fullState.data.state)
  deployState.balance = new Map(fullState.balance)
  deployState.maintenanceAuthority = new ContractMaintenanceAuthority(
    [...fullState.maintenanceAuthority.committee],
    fullState.maintenanceAuthority.threshold,
    fullState.maintenanceAuthority.counter,
  )

  const contractDeploy = new ContractDeploy(deployState)

  const batchSigningKey = signingKeyFromBip340(AMM_BATCHER_SECRET)
  await submitTx(providers, {
    unprovenTx: Transaction.fromParts(
      "undeployed",
      undefined,
      undefined,
      Intent.new(new Date(Date.now() + 60 * 60 * 1000)).addDeploy(contractDeploy),
    ),
  })

  const circuitBatches: string[][] = batchesOf(circuitIds, AMM_DEPLOY_CIRCUIT_BATCH_SIZE)

  const contractAddress: ContractAddress = contractDeploy.address

  console.log(`[integ] AMM deploy: contract address ${contractAddress}`)
  console.log(`[integ] AMM deploy: ${circuitIds.length} provable circuits total`)

  for (const [batchIndex, circuitBatch] of circuitBatches.entries()) {
    const contractState = await providers.publicDataProvider.queryContractState(contractAddress)
    if (!contractState) {
      throw new Error(`Missing on-chain contract state for ${contractAddress}`)
    }

    const verifierKeyInserts: VerifierKeyInsert[] = []

    for (const circuitId of circuitBatch) {
      if (contractState.operation(circuitId) != null) {
        continue
      }

      const verifierKey = await providers.zkConfigProvider.getVerifierKey(circuitId)

      verifierKeyInserts.push(
        new VerifierKeyInsert(
          circuitId,
          new ContractOperationVersionedVerifierKey("v3", verifierKey),
        ),
      )
    }

    if (verifierKeyInserts.length === 0) {
      continue
    }

    const maintenanceUpdate = new MaintenanceUpdate(
      contractAddress,
      verifierKeyInserts,
      contractState.maintenanceAuthority.counter,
    )

    const signedMaintenanceUpdate = maintenanceUpdate.addSignature(
      0n,
      signData(batchSigningKey, maintenanceUpdate.dataToSign),
    )

    await submitTx(providers, {
      unprovenTx: Transaction.fromParts(
        "undeployed",
        undefined,
        undefined,
        Intent.new(new Date(Date.now() + 60 * 60 * 1000)).addMaintenanceUpdate(
          signedMaintenanceUpdate,
        ),
      ),
    })

    console.log(
      `[integ] AMM deploy: submitted maintenance batch ${batchIndex + 1}/${circuitBatches.length}`,
    )
  }

  return contractAddress
}

function batchesOf<T>(items: readonly T[], batchSize: number): T[][] {
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize))
  }
  return batches
}

function withDustOnlyWalletBalancing(providers: MidnightProviders): MidnightProviders {
  const walletProvider = providers.walletProvider as WalletProviderWithTokenKindBalancing

  return {
    ...providers,
    walletProvider: {
      getCoinPublicKey: () => walletProvider.getCoinPublicKey(),
      getEncryptionPublicKey: () => walletProvider.getEncryptionPublicKey(),
      balanceTx: (tx, ttl) => walletProvider.balanceTx(tx, ttl, ["dust"]),
    },
  }
}

export async function make(props: AmmProps, providers: MidnightProviders) {
  const compiled = compile()

  const address = await deploy(compiled, props, providers)

  const circuitCallProviders = withDustOnlyWalletBalancing(providers)
  const endpoints = createCircuitCallTxInterface<AmmInstance>(
    circuitCallProviders as ContractProviders<AmmInstance>,
    compiled,
    address,
    undefined,
  )

  const state = async () => {
    const states = await getPublicStates(providers.publicDataProvider, address)

    return ledger(states.contractState.data)
  }

  const sentCoinNonceAt = async (position: bigint) => {
    const s = await state()
    return nonceEvolve(s.coins.lookup(position).nonce)
  }
  async function placeOrderTx(
    slot: bigint,
    orderKind: number,
    xAmount: bigint,
    yAmount: bigint,
    circuitId: CircuitId.CircuitId,
  ): Promise<UnsubmittedCallTxData<AmmInstance, "AmmPlaceOrder">> {
    const initialStates = await getPublicStates(providers.publicDataProvider, address)
    return await createUnprovenCallTxFromInitialStates(
      providers.zkConfigProvider,
      {
        compiledContract: compiled,
        contractAddress: address,
        circuitId: "AmmPlaceOrder",
        args: [slot, orderKind, xAmount, yAmount, circuitId],
        coinPublicKey: providers.walletProvider.getCoinPublicKey(),
        initialContractState: initialStates.contractState,
        initialZswapChainState: initialStates.zswapChainState,
        ledgerParameters: initialStates.ledgerParameters,
        initialPrivateState: undefined,
      },
      providers.walletProvider.getEncryptionPublicKey(),
    )
  }

  return {
    address,
    compiled,
    state,
    sentCoinNonceAt,
    circuitIds: (fundOrder: CircuitName, fundOrderAlt: CircuitName = fundOrder): CircuitIds => {
      return {
        address: { bytes: fromHex(address) },
        placeOrder: fromHex(entryPointHash("AmmPlaceOrder" satisfies CircuitName)),
        fundOrder: fromHex(entryPointHash(fundOrder)),
        fundOrderAlt: fromHex(entryPointHash(fundOrderAlt)),
        clearOrder: fromHex(entryPointHash("AmmClearOrder" satisfies CircuitName)),
      }
    },
    lpColor: Tokens.color(Tokens.encodeName("Pulse LP Token"), address),
    initXYLiq: endpoints.AmmInitXYLiq,
    placeOrder: endpoints.AmmPlaceOrder,
    placeOrderTx,
    fundOrderTx: async (fundCircuit: FundCircuit, slot: bigint, nonce: Uint8Array) => {
      const initialStates = await getPublicStates(providers.publicDataProvider, address)
      return await createUnprovenCallTxFromInitialStates(
        providers.zkConfigProvider,
        {
          compiledContract: compiled,
          contractAddress: address,
          circuitId: fundCircuit,
          args: [slot, nonce],
          coinPublicKey: providers.walletProvider.getCoinPublicKey(),
          initialContractState: initialStates.contractState,
          initialZswapChainState: initialStates.zswapChainState,
          ledgerParameters: initialStates.ledgerParameters,
          initialPrivateState: undefined,
        },
        providers.walletProvider.getEncryptionPublicKey(),
      )
    },
    activateOrder: endpoints.AmmActivateOrder,
    validateDepositXYLiq: endpoints.AmmValidateDepositXYLiq,
    validateDepositXLiq: endpoints.AmmValidateDepositXLiq,
    validateDepositYLiq: endpoints.AmmValidateDepositYLiq,
    validateSwapXToY: endpoints.AmmValidateSwapXToY,
    validateSwapYToX: endpoints.AmmValidateSwapYToX,
    validateWithdrawXYLiq: endpoints.AmmValidateWithdrawXYLiq,
    validateWithdrawXLiq: endpoints.AmmValidateWithdrawXLiq,
    validateWithdrawYLiq: endpoints.AmmValidateWithdrawYLiq,
    mintLp: endpoints.AmmMintLp,
    splitX: endpoints.AmmSplitX,
    splitY: endpoints.AmmSplitY,
    payTx: async (payCircuit: PayCircuit, slot: bigint, calleeOpening: bigint) => {
      const initialStates = await getPublicStates(providers.publicDataProvider, address)
      return await createUnprovenCallTxFromInitialStates(
        providers.zkConfigProvider,
        {
          compiledContract: compiled,
          contractAddress: address,
          circuitId: payCircuit,
          args: [slot, calleeOpening],
          coinPublicKey: providers.walletProvider.getCoinPublicKey(),
          initialContractState: initialStates.contractState,
          initialZswapChainState: initialStates.zswapChainState,
          ledgerParameters: initialStates.ledgerParameters,
          initialPrivateState: undefined as CompactContract.PrivateState<AmmInstance>,
        },
        providers.walletProvider.getEncryptionPublicKey(),
      )
    },
    clearOrderTx: async (
      slot: bigint,
    ): Promise<UnsubmittedCallTxData<AmmInstance, "AmmClearOrder">> => {
      const initialStates = await getPublicStates(providers.publicDataProvider, address)
      return await createUnprovenCallTxFromInitialStates(
        providers.zkConfigProvider,
        {
          compiledContract: compiled,
          contractAddress: address,
          circuitId: "AmmClearOrder",
          args: [slot],
          coinPublicKey: providers.walletProvider.getCoinPublicKey(),
          initialContractState: initialStates.contractState,
          initialZswapChainState: initialStates.zswapChainState,
          ledgerParameters: initialStates.ledgerParameters,
          initialPrivateState: undefined as CompactContract.PrivateState<AmmInstance>,
        },
        providers.walletProvider.getEncryptionPublicKey(),
      )
    },
  }
}

export function calcInitLpOut(xLiq: bigint, yLiq: bigint) {
  return BigInt(Math.floor(Math.sqrt(Number(xLiq) * Number(yLiq))))
}

export type Contract = Awaited<ReturnType<typeof make>>
