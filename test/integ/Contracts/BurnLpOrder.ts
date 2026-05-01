import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { CompiledContract } from "@midnight-ntwrk/compact-js"
import type { Contract as CompactContract } from "@midnight-ntwrk/compact-js/effect/Contract"
import { entryPointHash } from "@midnight-ntwrk/compact-runtime"
import { ContractAddress } from "@midnight-ntwrk/ledger-v8"
import {
  CircuitCallTxInterface,
  createCircuitCallTxInterface,
  createUnprovenCallTxFromInitialStates,
  deployContract,
  getPublicStates,
  type ContractProviders,
} from "@midnight-ntwrk/midnight-js-contracts"
import { MidnightProvider, MidnightProviders } from "@midnight-ntwrk/midnight-js-types"
import { fromHex } from "@midnight-ntwrk/midnight-js-utils"
import {
  Contract as BurnLpOrderContract,
  type Ledger,
  ledger,
  type Witnesses as BurnLpOrderWitnesses,
} from "../../../dist/burnlporder/contract"
import { ORDER_OWNER_SECRET } from "../Constants"
import { bytes32, nonceEvolve } from "../integ-support"
import type * as Amm from "./Amm"
import * as CircuitId from "./CircuitId"
import * as CrossContract from "./CrossContract"
import * as Witnesses from "./Witnesses"
import { mergeContractCallTxs } from "../merge"
import { submitUnprovenTx } from "../Providers/MidnightProviders"

export { type Ledger }

type Instance = BurnLpOrderContract<undefined, BurnLpOrderWitnesses<undefined>>
type Compiled = CompiledContract.CompiledContract<Instance, any, never>

export const ReturnKind = {
  X: 0,
  Y: 1,
} as const

function compile() {
  const withWitnesses = CompiledContract.withWitnesses(
    CompiledContract.make("BurnLpOrder", BurnLpOrderContract),
    {
      newNonce: Witnesses.newNonce(3_000),
      ownerSecret: Witnesses.actorSecret(ORDER_OWNER_SECRET),
    },
  )

  return CompiledContract.withCompiledFileAssets(
    withWitnesses,
    dirname(fileURLToPath(import.meta.resolve("../../../dist/burnlporder"))),
  )
}

type BurnLpOrderProps = {
}

async function deploy(
  compiled: Compiled,
  providers: MidnightProviders,
): Promise<ContractAddress> {
  const deployed = await deployContract(providers as ContractProviders<Instance>, {
    compiledContract: compiled,
    args: [fromHex(entryPointHash("BurnLpOrderReceiveCoinFromAmm"))],
  })

  return deployed.deployTxData.public.contractAddress
}

export async function makeHelpers(_props: BurnLpOrderProps, providers: MidnightProviders) {
  const compiled = compile()

  const address = await deploy(compiled, providers)

  return new ContractHelpers(address, compiled, providers)
}

export class ContractHelpers {
  readonly address: ContractAddress
  readonly compiled: Compiled
  readonly endpoints: CircuitCallTxInterface<Instance>
  private readonly providers: MidnightProviders

  constructor(address: ContractAddress, compiled: Compiled, providers: MidnightProviders) {
    this.address = address
    this.compiled = compiled
    this.endpoints = createCircuitCallTxInterface<Instance>(
      providers as ContractProviders<Instance>,
      compiled,
      address,
      undefined,
    )
    this.providers = providers
  }

  async state(): Promise<Ledger> {
    const states = await getPublicStates(this.providers.publicDataProvider, this.address)
    return ledger(states.contractState.data)
  }

  circuitId(circuitName: keyof CircuitCallTxInterface<Instance>) {
    return CircuitId.circuitId(this.address, circuitName)
  }

  async closeX(amm: Amm.ContractHelpers, slot: bigint): Promise<void> {
    const clearOrder = await amm.clearOrderTx(slot)

    const initialStates = await this.publicStates()
    const closeCall = await createUnprovenCallTxFromInitialStates(
      this.providers.zkConfigProvider,
      {
        compiledContract: this.compiled,
        contractAddress: this.address,
        circuitId: "BurnLpOrderCloseX",
        args: [CrossContract.commOpening(clearOrder)],
        coinPublicKey: this.providers.walletProvider.getCoinPublicKey(),
        initialContractState: initialStates.contractState,
        initialZswapChainState: initialStates.zswapChainState,
        ledgerParameters: initialStates.ledgerParameters,
        initialPrivateState: undefined,
      },
      this.providers.walletProvider.getEncryptionPublicKey(),
    )

    await submitUnprovenTx(this.providers, mergeContractCallTxs(closeCall, clearOrder), {
      tokenKindsToBalance: ["dust"],
    })
  }

  get closeY() {
    return this.endpoints.BurnLpOrderCloseY
  }

  get open() {
    return this.endpoints.BurnLpOrderOpen
  }

  async receiveXCoinFromAmm(
    amm: Amm.ContractHelpers,
    slot: bigint,
    returnKind: number,
    amount: bigint,
  ) {
    const initialStates = await this.publicStates()
    const receiveCall = await createUnprovenCallTxFromInitialStates(
      this.providers.zkConfigProvider,
      {
        compiledContract: this.compiled,
        contractAddress: this.address,
        circuitId: "BurnLpOrderReceiveCoinFromAmm",
        args: [returnKind, amount, bytes32(await amm.sentCoinNonceAt(slot * 4n))],
        coinPublicKey: this.providers.walletProvider.getCoinPublicKey(),
        initialContractState: initialStates.contractState,
        initialZswapChainState: initialStates.zswapChainState,
        ledgerParameters: initialStates.ledgerParameters,
        initialPrivateState: undefined as CompactContract.PrivateState<Instance>,
      },
      this.providers.walletProvider.getEncryptionPublicKey(),
    )

    const pay = await amm.payTx("AmmPayX", slot, CrossContract.commOpening(receiveCall))

    await submitUnprovenTx(this.providers, mergeContractCallTxs(pay, receiveCall), {
      tokenKindsToBalance: ["dust"],
    })
  }

  async receiveYCoinFromAmm(
    amm: Amm.ContractHelpers,
    slot: bigint,
    returnKind: number,
    amount: bigint,
  ) {
    const initialStates = await this.publicStates()
    const receiveCall = await createUnprovenCallTxFromInitialStates(
      this.providers.zkConfigProvider,
      {
        compiledContract: this.compiled,
        contractAddress: this.address,
        circuitId: "BurnLpOrderReceiveCoinFromAmm",
        args: [returnKind, amount, bytes32(await amm.sentCoinNonceAt(slot * 4n + 2n))],
        coinPublicKey: this.providers.walletProvider.getCoinPublicKey(),
        initialContractState: initialStates.contractState,
        initialZswapChainState: initialStates.zswapChainState,
        ledgerParameters: initialStates.ledgerParameters,
        initialPrivateState: undefined as CompactContract.PrivateState<Instance>,
      },
      this.providers.walletProvider.getEncryptionPublicKey(),
    )

    const pay = await amm.payTx("AmmPayY", slot, CrossContract.commOpening(receiveCall))

    await submitUnprovenTx(this.providers, mergeContractCallTxs(pay, receiveCall), {
      tokenKindsToBalance: ["dust"],
    })
  }

  async reserveAmmSlot(
    amm: Amm.ContractHelpers,
    slot: bigint,
    orderKind: number,
    xAmount: bigint,
    yAmount: bigint,
  ) {
    const placeOrder = await amm.placeOrderTx(
      slot,
      orderKind,
      xAmount,
      yAmount,
      this.circuitId("BurnLpOrderReceiveCoinFromAmm")
    )

    const initialStates = await this.publicStates()
    const reserveCall = await createUnprovenCallTxFromInitialStates(
      this.providers.zkConfigProvider,
      {
        compiledContract: this.compiled,
        contractAddress: this.address,
        circuitId: "BurnLpOrderReserveAmmSlot",
        args: [slot, CrossContract.commOpening(placeOrder)],
        coinPublicKey: this.providers.walletProvider.getCoinPublicKey(),
        initialContractState: initialStates.contractState,
        initialZswapChainState: initialStates.zswapChainState,
        ledgerParameters: initialStates.ledgerParameters,
        initialPrivateState: undefined as CompactContract.PrivateState<Instance>,
      },
      this.providers.walletProvider.getEncryptionPublicKey(),
    )

    await submitUnprovenTx(this.providers, mergeContractCallTxs(reserveCall, placeOrder), {
      tokenKindsToBalance: ["dust"],
    })
  }

  async sendCoinToAmm(amm: Amm.ContractHelpers, slot: bigint) {
    const fund = await amm.fundOrderTx("AmmFundOrderLp", slot, await this.sentCoinNonceAt(0n))

    const initialStates = await this.publicStates()
    const send = await createUnprovenCallTxFromInitialStates(
      this.providers.zkConfigProvider,
      {
        compiledContract: this.compiled,
        contractAddress: this.address,
        circuitId: "BurnLpOrderSendCoinToAmm",
        args: [CrossContract.commOpening(fund)],
        coinPublicKey: this.providers.walletProvider.getCoinPublicKey(),
        initialContractState: initialStates.contractState,
        initialZswapChainState: initialStates.zswapChainState,
        ledgerParameters: initialStates.ledgerParameters,
        initialPrivateState: undefined as CompactContract.PrivateState<Instance>,
      },
      this.providers.walletProvider.getEncryptionPublicKey(),
    )

    await submitUnprovenTx(this.providers, mergeContractCallTxs(send, fund), {
      tokenKindsToBalance: ["dust"],
    })
  }

  async sentCoinNonceAt(position: bigint) {
    const states = await this.publicStates()
    return nonceEvolve(ledger(states.contractState.data).coins.lookup(position).nonce)
  }

  private async publicStates() {
    return await getPublicStates(this.providers.publicDataProvider, this.address)
  }
}
