import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { CompiledContract } from "@midnight-ntwrk/compact-js"
import type { Contract as CompactContract } from "@midnight-ntwrk/compact-js/effect/Contract"
import { entryPointHash } from "@midnight-ntwrk/compact-runtime"
import { ContractAddress } from "@midnight-ntwrk/ledger-v8"
import {
  createCircuitCallTxInterface,
  createUnprovenCallTxFromInitialStates,
  deployContract,
  getPublicStates,
  type ContractProviders,
} from "@midnight-ntwrk/midnight-js-contracts"
import { MidnightProviders } from "@midnight-ntwrk/midnight-js-types"
import { fromHex } from "@midnight-ntwrk/midnight-js-utils"
import {
  Contract as MarketOrderContract,
  type Ledger,
  ledger,
  type Witnesses as MarketOrderWitnesses,
} from "../../../dist/marketorder/contract"
import { ORDER_OWNER_SECRET } from "../Constants"
import { bytes32, nonceEvolve } from "../integ-support"
import type * as Amm from "./Amm"
import * as CircuitId from "./CircuitId"
import * as CrossContract from "./CrossContract"
import * as Witnesses from "./Witnesses"
import { mergeContractCallTxs } from "../merge"
import { submitUnprovenTx } from "../Providers/MidnightProviders"

export { type Ledger }

type MarketOrderInstance = MarketOrderContract<undefined, MarketOrderWitnesses<undefined>>
type Compiled = CompiledContract.CompiledContract<MarketOrderInstance, any, never>

function compile() {
  const withWitnesses = CompiledContract.withWitnesses(
    CompiledContract.make("MarketOrder", MarketOrderContract),
    {
      newNonce: Witnesses.newNonce(4_000),
      ownerSecret: Witnesses.actorSecret(ORDER_OWNER_SECRET),
    },
  )

  return CompiledContract.withCompiledFileAssets(
    withWitnesses,
    dirname(fileURLToPath(import.meta.resolve("../../../dist/marketorder"))),
  )
}

async function deploy(
  compiled: Compiled,
  providers: MidnightProviders,
): Promise<ContractAddress> {
  const deployed = await deployContract(providers as ContractProviders<MarketOrderInstance>, {
    compiledContract: compiled,
    args: [fromHex(entryPointHash("MarketOrderReceiveCoinFromAmm"))],
  })

  return deployed.deployTxData.public.contractAddress
}

export async function makeHelpers(providers: MidnightProviders) {
  const compiled = compile()

  const address = await deploy(compiled, providers)

  return new ContractHelpers(address, compiled, providers)
}

export class ContractHelpers {
  readonly address: ContractAddress
  readonly compiled: Compiled
  readonly endpoints: ReturnType<typeof createCircuitCallTxInterface<MarketOrderInstance>>
  private readonly providers: MidnightProviders

  constructor(address: ContractAddress, compiled: Compiled, providers: MidnightProviders) {
    this.address = address
    this.compiled = compiled
    this.endpoints = createCircuitCallTxInterface<MarketOrderInstance>(
      providers as ContractProviders<MarketOrderInstance>,
      compiled,
      address,
      undefined,
    )
    this.providers = providers
  }

  get open() {
    return this.endpoints.MarketOrderOpen
  }

  async state(): Promise<Ledger> {
    const states = await this.publicStates()
    return ledger(states.contractState.data)
  }

  circuitId(circuitName: keyof typeof this.endpoints) {
    return CircuitId.circuitId(this.address, circuitName)
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
      this.circuitId("MarketOrderReceiveCoinFromAmm"),
    )

    const initialStates = await this.publicStates()
    const reserveCall = await createUnprovenCallTxFromInitialStates(
      this.providers.zkConfigProvider,
      {
        compiledContract: this.compiled,
        contractAddress: this.address,
        circuitId: "MarketOrderReserveAmmSlot",
        args: [slot, CrossContract.commOpening(placeOrder)],
        coinPublicKey: this.providers.walletProvider.getCoinPublicKey(),
        initialContractState: initialStates.contractState,
        initialZswapChainState: initialStates.zswapChainState,
        ledgerParameters: initialStates.ledgerParameters,
        initialPrivateState: undefined as CompactContract.PrivateState<MarketOrderInstance>,
      },
      this.providers.walletProvider.getEncryptionPublicKey(),
    )

    await submitUnprovenTx(this.providers, mergeContractCallTxs(reserveCall, placeOrder), {
      tokenKindsToBalance: ["dust"],
    })
  }

  async sendCoinToAmm(amm: Amm.ContractHelpers, fundCircuit: Amm.FundCircuit, slot: bigint) {
    const fund = await amm.fundOrderTx(fundCircuit, slot, await this.sentCoinNonceAt(0n))

    const initialStates = await this.publicStates()
    const send = await createUnprovenCallTxFromInitialStates(
      this.providers.zkConfigProvider,
      {
        compiledContract: this.compiled,
        contractAddress: this.address,
        circuitId: "MarketOrderSendCoinToAmm",
        args: [CrossContract.commOpening(fund)],
        coinPublicKey: this.providers.walletProvider.getCoinPublicKey(),
        initialContractState: initialStates.contractState,
        initialZswapChainState: initialStates.zswapChainState,
        ledgerParameters: initialStates.ledgerParameters,
        initialPrivateState: undefined as CompactContract.PrivateState<MarketOrderInstance>,
      },
      this.providers.walletProvider.getEncryptionPublicKey(),
    )

    await submitUnprovenTx(this.providers, mergeContractCallTxs(send, fund), {
      tokenKindsToBalance: ["dust"],
    })
  }

  async receiveCoinFromAmm(
    amm: Amm.ContractHelpers,
    payCircuit: Amm.PayCircuit,
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
        circuitId: "MarketOrderReceiveCoinFromAmm",
        args: [
          returnKind,
          amount,
          bytes32(
            payCircuit == "AmmPayY"
              ? await amm.sentCoinNonceAt(slot * 4n + 2n)
              : await amm.sentCoinNonceAt(slot * 4n),
          ),
        ],
        coinPublicKey: this.providers.walletProvider.getCoinPublicKey(),
        initialContractState: initialStates.contractState,
        initialZswapChainState: initialStates.zswapChainState,
        ledgerParameters: initialStates.ledgerParameters,
        initialPrivateState: undefined as CompactContract.PrivateState<MarketOrderInstance>,
      },
      this.providers.walletProvider.getEncryptionPublicKey(),
    )

    const pay = await amm.payTx(payCircuit, slot, CrossContract.commOpening(receiveCall))
    await submitUnprovenTx(this.providers, mergeContractCallTxs(pay, receiveCall), {
      tokenKindsToBalance: ["dust"],
    })
  }

  async close(amm: Amm.ContractHelpers, slot: bigint) {
    const clearOrder = await amm.clearOrderTx(slot)

    const initialStates = await this.publicStates()
    const closeCall = await createUnprovenCallTxFromInitialStates(
      this.providers.zkConfigProvider,
      {
        compiledContract: this.compiled,
        contractAddress: this.address,
        circuitId: "MarketOrderClose",
        args: [CrossContract.commOpening(clearOrder)],
        coinPublicKey: this.providers.walletProvider.getCoinPublicKey(),
        initialContractState: initialStates.contractState,
        initialZswapChainState: initialStates.zswapChainState,
        ledgerParameters: initialStates.ledgerParameters,
        initialPrivateState: undefined as CompactContract.PrivateState<MarketOrderInstance>,
      },
      this.providers.walletProvider.getEncryptionPublicKey(),
    )

    await submitUnprovenTx(this.providers, mergeContractCallTxs(closeCall, clearOrder), {
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

export type Contract = ContractHelpers
