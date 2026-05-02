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
  CircuitCallTxInterface,
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
type Compiled = CompiledContract.CompiledContract<AmmInstance, any, never>
type ExpectedOrder = {
  orderKind: number
  xAmount: bigint
  yAmount: bigint
}
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
  "AmmDeactivateOrder",
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
  compiled: Compiled,
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

export async function makeHelpers(props: AmmProps, providers: MidnightProviders) {
  const compiled = compile()

  const address = await deploy(compiled, props, providers)

  return new ContractHelpers(address, compiled, providers)
}

export class ContractHelpers {
  readonly address: ContractAddress
  readonly compiled: Compiled
  readonly endpoints: CircuitCallTxInterface<AmmInstance>
  readonly fullBalanceEndpoints: CircuitCallTxInterface<AmmInstance>
  readonly lpColor: Uint8Array
  expectedState: Parameters = {
    feeBps: AMM_FEE_BPS,
    xLiquidity: 0n,
    yLiquidity: 0n,
    xRewards: 0n,
    lpCirculatingSupply: 0n,
  }
  private activeOrderSlot: bigint | undefined
  private pendingLpMint = 0n
  private readonly providers: MidnightProviders
  private readonly expectedOrders = new Map<bigint, ExpectedOrder>()

  constructor(address: ContractAddress, compiled: Compiled, providers: MidnightProviders) {
    this.address = address
    this.compiled = compiled
    this.providers = providers

    const circuitCallProviders = withDustOnlyWalletBalancing(providers)
    this.endpoints = createCircuitCallTxInterface<AmmInstance>(
      circuitCallProviders as ContractProviders<AmmInstance>,
      compiled,
      address,
      undefined,
    )
    this.fullBalanceEndpoints = createCircuitCallTxInterface<AmmInstance>(
      providers as ContractProviders<AmmInstance>,
      compiled,
      address,
      undefined,
    )
    this.lpColor = Tokens.color(Tokens.encodeName("Pulse LP Token"), address)
  }

  async state(): Promise<Ledger> {
    const states = await this.publicStates()

    return ledger(states.contractState.data)
  }

  async sentCoinNonceAt(position: bigint) {
    const s = await this.state()
    return nonceEvolve(s.coins.lookup(position).nonce)
  }

  circuitIds(fundOrder: CircuitName, fundOrderAlt: CircuitName = fundOrder): CircuitIds {
    return {
      address: { bytes: fromHex(this.address) },
      placeOrder: fromHex(entryPointHash("AmmPlaceOrder" satisfies CircuitName)),
      fundOrder: fromHex(entryPointHash(fundOrder)),
      fundOrderAlt: fromHex(entryPointHash(fundOrderAlt)),
      clearOrder: fromHex(entryPointHash("AmmClearOrder" satisfies CircuitName)),
    }
  }

  async initXYLiq(xLiq: bigint, yLiq: bigint, lpOut: bigint, returnsTo: Addresses.Address) {
    const result = await this.fullBalanceEndpoints.AmmInitXYLiq(xLiq, yLiq, lpOut, returnsTo)
    this.expectedState = {
      ...this.expectedState,
      xLiquidity: this.expectedState.xLiquidity + xLiq,
      yLiquidity: this.expectedState.yLiquidity + yLiq,
      lpCirculatingSupply: this.expectedState.lpCirculatingSupply + lpOut,
    }
    return result
  }

  get placeOrder() {
    return this.endpoints.AmmPlaceOrder
  }

  async placeOrderTx(
    slot: bigint,
    orderKind: number,
    xAmount: bigint,
    yAmount: bigint,
    circuitId: CircuitId.CircuitId,
  ): Promise<UnsubmittedCallTxData<AmmInstance, "AmmPlaceOrder">> {
    const initialStates = await this.publicStates()
    const placeOrder = await createUnprovenCallTxFromInitialStates(
      this.providers.zkConfigProvider,
      {
        compiledContract: this.compiled,
        contractAddress: this.address,
        circuitId: "AmmPlaceOrder",
        args: [slot, orderKind, xAmount, yAmount, circuitId],
        coinPublicKey: this.providers.walletProvider.getCoinPublicKey(),
        initialContractState: initialStates.contractState,
        initialZswapChainState: initialStates.zswapChainState,
        ledgerParameters: initialStates.ledgerParameters,
        initialPrivateState: undefined,
      },
      this.providers.walletProvider.getEncryptionPublicKey(),
    )
    this.expectedOrders.set(slot, { orderKind, xAmount, yAmount })
    return placeOrder
  }

  async fundOrderTx(fundCircuit: FundCircuit, slot: bigint, nonce: Uint8Array) {
    const initialStates = await this.publicStates()
    return await createUnprovenCallTxFromInitialStates(
      this.providers.zkConfigProvider,
      {
        compiledContract: this.compiled,
        contractAddress: this.address,
        circuitId: fundCircuit,
        args: [slot, nonce],
        coinPublicKey: this.providers.walletProvider.getCoinPublicKey(),
        initialContractState: initialStates.contractState,
        initialZswapChainState: initialStates.zswapChainState,
        ledgerParameters: initialStates.ledgerParameters,
        initialPrivateState: undefined,
      },
      this.providers.walletProvider.getEncryptionPublicKey(),
    )
  }

  async activateOrder(slot: bigint) {
    const result = await this.endpoints.AmmActivateOrder(slot)
    this.activeOrderSlot = slot
    return result
  }

  async validateDepositXYLiq(lpOut: bigint) {
    const result = await this.endpoints.AmmValidateDepositXYLiq(lpOut)
    const order = this.activeExpectedOrder()
    this.expectedState = {
      ...this.expectedState,
      xLiquidity: this.expectedState.xLiquidity + order.xAmount,
      yLiquidity: this.expectedState.yLiquidity + order.yAmount,
    }
    this.pendingLpMint += lpOut
    return result
  }

  async validateDepositXLiq(xSwap: bigint, xFee: bigint, ySwap: bigint, lpOut: bigint) {
    const result = await this.endpoints.AmmValidateDepositXLiq(xSwap, xFee, ySwap, lpOut)
    const order = this.activeExpectedOrder()
    this.expectedState = {
      ...this.expectedState,
      xLiquidity: this.expectedState.xLiquidity + order.xAmount - xFee,
      xRewards: this.expectedState.xRewards + xFee,
    }
    this.pendingLpMint += lpOut
    return result
  }

  async validateDepositYLiq(ySwap: bigint, xFee: bigint, xSwap: bigint, lpOut: bigint) {
    const result = await this.endpoints.AmmValidateDepositYLiq(ySwap, xFee, xSwap, lpOut)
    const order = this.activeExpectedOrder()
    this.expectedState = {
      ...this.expectedState,
      xLiquidity: this.expectedState.xLiquidity - xFee,
      yLiquidity: this.expectedState.yLiquidity + order.yAmount,
      xRewards: this.expectedState.xRewards + xFee,
    }
    this.pendingLpMint += lpOut
    return result
  }

  async validateSwapXToY(xFee: bigint, yOut: bigint) {
    const result = await this.endpoints.AmmValidateSwapXToY(xFee, yOut)
    const order = this.activeExpectedOrder()
    this.expectedState = {
      ...this.expectedState,
      xLiquidity: this.expectedState.xLiquidity + order.xAmount - xFee,
      yLiquidity: this.expectedState.yLiquidity - yOut,
      xRewards: this.expectedState.xRewards + xFee,
    }
    return result
  }

  async validateSwapYToX(xFee: bigint, xOut: bigint) {
    const result = await this.endpoints.AmmValidateSwapYToX(xFee, xOut)
    const order = this.activeExpectedOrder()
    this.expectedState = {
      ...this.expectedState,
      xLiquidity: this.expectedState.xLiquidity - xOut - xFee,
      yLiquidity: this.expectedState.yLiquidity + order.yAmount,
      xRewards: this.expectedState.xRewards + xFee,
    }
    return result
  }

  async validateWithdrawXYLiq(xOut: bigint, yOut: bigint) {
    const result = await this.endpoints.AmmValidateWithdrawXYLiq(xOut, yOut)
    const order = this.activeExpectedOrder()
    this.expectedState = {
      ...this.expectedState,
      xLiquidity: this.expectedState.xLiquidity - xOut,
      yLiquidity: this.expectedState.yLiquidity - yOut,
      lpCirculatingSupply: this.expectedState.lpCirculatingSupply - order.xAmount,
    }
    return result
  }

  async validateWithdrawXLiq(xOut: bigint, ySwap: bigint, xFee: bigint, xSwap: bigint) {
    const result = await this.endpoints.AmmValidateWithdrawXLiq(xOut, ySwap, xFee, xSwap)
    const order = this.activeExpectedOrder()
    this.expectedState = {
      ...this.expectedState,
      xLiquidity: this.expectedState.xLiquidity - xOut - xFee,
      xRewards: this.expectedState.xRewards + xFee,
      lpCirculatingSupply: this.expectedState.lpCirculatingSupply - order.xAmount,
    }
    return result
  }

  async validateWithdrawYLiq(yOut: bigint, xSwap: bigint, xFee: bigint, ySwap: bigint) {
    const result = await this.endpoints.AmmValidateWithdrawYLiq(yOut, xSwap, xFee, ySwap)
    const order = this.activeExpectedOrder()
    this.expectedState = {
      ...this.expectedState,
      xLiquidity: this.expectedState.xLiquidity - xFee,
      yLiquidity: this.expectedState.yLiquidity - yOut,
      xRewards: this.expectedState.xRewards + xFee,
      lpCirculatingSupply: this.expectedState.lpCirculatingSupply - order.xAmount,
    }
    return result
  }

  async mintLp() {
    const result = await this.endpoints.AmmMintLp()
    this.expectedState = {
      ...this.expectedState,
      lpCirculatingSupply: this.expectedState.lpCirculatingSupply + this.pendingLpMint,
    }
    this.pendingLpMint = 0n
    return result
  }

  get splitX() {
    return this.endpoints.AmmSplitX
  }

  get splitY() {
    return this.endpoints.AmmSplitY
  }

  get deactivateOrder() {
    return this.endpoints.AmmDeactivateOrder
  }

  async payTx(payCircuit: PayCircuit, slot: bigint, calleeOpening: bigint) {
    const initialStates = await this.publicStates()
    return await createUnprovenCallTxFromInitialStates(
      this.providers.zkConfigProvider,
      {
        compiledContract: this.compiled,
        contractAddress: this.address,
        circuitId: payCircuit,
        args: [slot, calleeOpening],
        coinPublicKey: this.providers.walletProvider.getCoinPublicKey(),
        initialContractState: initialStates.contractState,
        initialZswapChainState: initialStates.zswapChainState,
        ledgerParameters: initialStates.ledgerParameters,
        initialPrivateState: undefined as CompactContract.PrivateState<AmmInstance>,
      },
      this.providers.walletProvider.getEncryptionPublicKey(),
    )
  }

  async deactivateOrderTx(): Promise<UnsubmittedCallTxData<AmmInstance, "AmmDeactivateOrder">> {
    const initialStates = await this.publicStates()
    return await createUnprovenCallTxFromInitialStates(
      this.providers.zkConfigProvider,
      {
        compiledContract: this.compiled,
        contractAddress: this.address,
        circuitId: "AmmDeactivateOrder",
        coinPublicKey: this.providers.walletProvider.getCoinPublicKey(),
        initialContractState: initialStates.contractState,
        initialZswapChainState: initialStates.zswapChainState,
        ledgerParameters: initialStates.ledgerParameters,
        initialPrivateState: undefined as CompactContract.PrivateState<AmmInstance>,
      },
      this.providers.walletProvider.getEncryptionPublicKey(),
    )
  }

  async clearOrderTx(slot: bigint): Promise<UnsubmittedCallTxData<AmmInstance, "AmmClearOrder">> {
    const initialStates = await this.publicStates()
    return await createUnprovenCallTxFromInitialStates(
      this.providers.zkConfigProvider,
      {
        compiledContract: this.compiled,
        contractAddress: this.address,
        circuitId: "AmmClearOrder",
        args: [slot],
        coinPublicKey: this.providers.walletProvider.getCoinPublicKey(),
        initialContractState: initialStates.contractState,
        initialZswapChainState: initialStates.zswapChainState,
        ledgerParameters: initialStates.ledgerParameters,
        initialPrivateState: undefined as CompactContract.PrivateState<AmmInstance>,
      },
      this.providers.walletProvider.getEncryptionPublicKey(),
    )
  }

  private async publicStates() {
    return await getPublicStates(this.providers.publicDataProvider, this.address)
  }

  private activeExpectedOrder(): ExpectedOrder {
    if (this.activeOrderSlot === undefined) {
      throw new Error("No active AMM order slot recorded")
    }

    const order = this.expectedOrders.get(this.activeOrderSlot)
    if (order === undefined) {
      throw new Error(`No expected AMM order recorded for slot ${this.activeOrderSlot}`)
    }
    return order
  }
}

export type Contract = ContractHelpers

export function calcInitLpOut(xLiq: bigint, yLiq: bigint) {
  return BigInt(Math.floor(Math.sqrt(Number(xLiq) * Number(yLiq))))
}

export function calcSwapXToY(
  state: Pick<Parameters, "feeBps" | "xLiquidity" | "yLiquidity">,
  xIn: bigint,
) {
  const xFee = (xIn * state.feeBps + 9999n) / 10000n
  const yOut =
    state.yLiquidity -
    (state.xLiquidity * state.yLiquidity + (state.xLiquidity + xIn - xFee) - 1n) /
      (state.xLiquidity + xIn - xFee)
  return { xFee, yOut }
}

export function calcSwapYToX(
  state: Pick<Parameters, "feeBps" | "xLiquidity" | "yLiquidity">,
  yIn: bigint,
) {
  const xOutAndFee =
    state.xLiquidity -
    (state.xLiquidity * state.yLiquidity + (state.yLiquidity + yIn) - 1n) / (state.yLiquidity + yIn)
  const xOut = (xOutAndFee * (10000n - state.feeBps)) / 10000n
  const xFee = xOutAndFee - xOut
  return { xFee, xOut }
}

export function calcLpOut(state: Parameters, xIn: bigint, yIn: bigint) {
  const byX = (xIn * state.lpCirculatingSupply) / state.xLiquidity
  const byY = (yIn * state.lpCirculatingSupply) / state.yLiquidity
  return byX < byY ? byX : byY
}

export function calcWithdrawXY(state: Parameters, lpIn: bigint) {
  return {
    xOut: (lpIn * state.xLiquidity) / state.lpCirculatingSupply,
    yOut: (lpIn * state.yLiquidity) / state.lpCirculatingSupply,
  }
}

export function findZapInX(state: Parameters, xIn: bigint) {
  for (let xSwap = 1n; xSwap < xIn; xSwap += 1n) {
    const { xFee, yOut: ySwap } = calcSwapXToY(state, xSwap)
    const xLiqAfterSwap = state.xLiquidity + xSwap - xFee
    const yLiqAfterSwap = state.yLiquidity - ySwap
    const xAdded = xIn - xSwap
    const yAdded = ySwap
    if (
      xAdded * yLiqAfterSwap > yAdded * xLiqAfterSwap ||
      (xAdded + 1n) * yLiqAfterSwap < yAdded * xLiqAfterSwap
    ) {
      continue
    }
    const lpOut = (xAdded * state.lpCirculatingSupply) / xLiqAfterSwap
    if (
      lpOut * xLiqAfterSwap <= xAdded * state.lpCirculatingSupply &&
      (lpOut + 1n) * xLiqAfterSwap >= xAdded * state.lpCirculatingSupply
    ) {
      return { xSwap, xFee, ySwap, lpOut }
    }
  }
  throw new Error("Failed to derive X zap-in validation args")
}

export function findZapInY(state: Parameters, yIn: bigint) {
  for (let ySwap = 1n; ySwap < yIn; ySwap += 1n) {
    const { xFee, xOut: xSwap } = calcSwapYToX(state, ySwap)
    const xLiqAfterSwap = state.xLiquidity - xSwap - xFee
    const yLiqAfterSwap = state.yLiquidity + ySwap
    const xAdded = xSwap
    const yAdded = yIn - ySwap
    if (
      yAdded * xLiqAfterSwap > xAdded * yLiqAfterSwap ||
      (yAdded + 1n) * xLiqAfterSwap < xAdded * yLiqAfterSwap
    ) {
      continue
    }
    const lpOut = (yAdded * state.lpCirculatingSupply) / yLiqAfterSwap
    if (
      lpOut * yLiqAfterSwap <= yAdded * state.lpCirculatingSupply &&
      (lpOut + 1n) * yLiqAfterSwap >= yAdded * state.lpCirculatingSupply
    ) {
      return { ySwap, xFee, xSwap, lpOut }
    }
  }
  throw new Error("Failed to derive Y zap-in validation args")
}

export function findZapOutX(state: Parameters, lpIn: bigint) {
  const maxX = (lpIn * state.xLiquidity) / state.lpCirculatingSupply + 1n
  const maxY = (lpIn * state.yLiquidity) / state.lpCirculatingSupply + 1n
  for (let xRemoved = 0n; xRemoved <= maxX; xRemoved += 1n) {
    for (let yRemoved = 0n; yRemoved <= maxY; yRemoved += 1n) {
      if (
        xRemoved * state.lpCirculatingSupply > lpIn * state.xLiquidity ||
        (xRemoved + 1n) * state.lpCirculatingSupply < lpIn * state.xLiquidity ||
        yRemoved * state.lpCirculatingSupply > lpIn * state.yLiquidity ||
        (yRemoved + 1n) * state.lpCirculatingSupply < lpIn * state.yLiquidity
      ) {
        continue
      }
      const reduced = {
        ...state,
        xLiquidity: state.xLiquidity - xRemoved,
        yLiquidity: state.yLiquidity - yRemoved,
      }
      const { xFee, xOut: xSwap } = calcSwapYToX(reduced, yRemoved)
      return { xOut: xRemoved + xSwap, ySwap: yRemoved, xFee, xSwap }
    }
  }
  throw new Error("Failed to derive X zap-out validation args")
}

export function findZapOutY(state: Parameters, lpIn: bigint) {
  const maxX = (lpIn * state.xLiquidity) / state.lpCirculatingSupply + 1n
  const maxY = (lpIn * state.yLiquidity) / state.lpCirculatingSupply + 1n
  for (let xRemoved = 0n; xRemoved <= maxX; xRemoved += 1n) {
    for (let yRemoved = 0n; yRemoved <= maxY; yRemoved += 1n) {
      if (
        xRemoved * state.lpCirculatingSupply > lpIn * state.xLiquidity ||
        (xRemoved + 1n) * state.lpCirculatingSupply < lpIn * state.xLiquidity ||
        yRemoved * state.lpCirculatingSupply > lpIn * state.yLiquidity ||
        (yRemoved + 1n) * state.lpCirculatingSupply < lpIn * state.yLiquidity
      ) {
        continue
      }
      const reduced = {
        ...state,
        xLiquidity: state.xLiquidity - xRemoved,
        yLiquidity: state.yLiquidity - yRemoved,
      }
      const { xFee, yOut: ySwap } = calcSwapXToY(reduced, xRemoved)
      return { yOut: yRemoved + ySwap, xSwap: xRemoved, xFee, ySwap }
    }
  }
  throw new Error("Failed to derive Y zap-out validation args")
}
