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
  Contract as MintLpOrderContract,
  type Ledger,
  ledger,
  type Witnesses as MintLpOrderWitnesses,
} from "../../../dist/mintlporder/contract"
import { fileURLToPath } from "node:url"
import { dirname } from "node:path"
import { ORDER_OWNER_SECRET } from "../Constants"
import { bytes32, nonceEvolve } from "../integ-support"
import * as Amm from "./Amm"
import * as CircuitId from "./CircuitId"
import * as CrossContract from "./CrossContract"
import * as Witnesses from "./Witnesses"
import { mergeContractCallTxs } from "../merge"
import { submitUnprovenTx } from "../Providers/MidnightProviders"

export { type Ledger }

type MintLpOrderInstance = MintLpOrderContract<undefined, MintLpOrderWitnesses<undefined>>
type Compiled = CompiledContract.CompiledContract<MintLpOrderInstance, any, never>

function compile() {
  const withWitnesses = CompiledContract.withWitnesses(
    CompiledContract.make("MintLpOrder", MintLpOrderContract),
    {
      newNonce: Witnesses.newNonce(2_000),
      ownerSecret: Witnesses.actorSecret(ORDER_OWNER_SECRET),
    },
  )

  return CompiledContract.withCompiledFileAssets(
    withWitnesses,
    dirname(fileURLToPath(import.meta.resolve("../../../dist/mintlporder"))),
  )
}

async function deploy(
  compiled: Compiled,
  providers: MidnightProviders,
): Promise<ContractAddress> {
  const deployed = await deployContract(providers as ContractProviders<MintLpOrderInstance>, {
    compiledContract: compiled,
    args: [fromHex(entryPointHash("MintLpOrderReceiveFromAmm"))],
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
  readonly endpoints: ReturnType<typeof createCircuitCallTxInterface<MintLpOrderInstance>>
  private readonly providers: MidnightProviders

  constructor(address: ContractAddress, compiled: Compiled, providers: MidnightProviders) {
    this.address = address
    this.compiled = compiled
    this.endpoints = createCircuitCallTxInterface<MintLpOrderInstance>(
      providers as ContractProviders<MintLpOrderInstance>,
      compiled,
      address,
      undefined,
    )
    this.providers = providers
  }

  get open() {
    return this.endpoints.MintLpOrderOpen
  }

  async state(): Promise<Ledger> {
    const states = await this.publicStates()
    return ledger(states.contractState.data)
  }

  circuitId(circuitName: keyof typeof this.endpoints) {
    return CircuitId.circuitId(this.address, circuitName)
  }

  async reserveAmmSlot(amm: Amm.ContractHelpers, slot: bigint, xAmount: bigint, yAmount: bigint) {
    const placeOrder = await amm.placeOrderTx(
      slot,
      Amm.OrderKind.DepositXYLiq,
      xAmount,
      yAmount,
      this.circuitId("MintLpOrderReceiveFromAmm"),
    )

    const initialStates = await this.publicStates()
    const reserveCall = await createUnprovenCallTxFromInitialStates(
      this.providers.zkConfigProvider,
      {
        compiledContract: this.compiled,
        contractAddress: this.address,
        circuitId: "MintLpOrderReserveAmmSlot",
        args: [slot, CrossContract.commOpening(placeOrder)],
        coinPublicKey: this.providers.walletProvider.getCoinPublicKey(),
        initialContractState: initialStates.contractState,
        initialZswapChainState: initialStates.zswapChainState,
        ledgerParameters: initialStates.ledgerParameters,
        initialPrivateState: undefined as CompactContract.PrivateState<MintLpOrderInstance>,
      },
      this.providers.walletProvider.getEncryptionPublicKey(),
    )

    await submitUnprovenTx(this.providers, mergeContractCallTxs(reserveCall, placeOrder), {
      tokenKindsToBalance: ["dust"],
    })
  }

  async sendXCoinToAmm(amm: Amm.ContractHelpers, slot: bigint) {
    const fund = await amm.fundOrderTx("AmmFundOrderX", slot, await this.sentCoinNonceAt(0n))

    const initialStates = await this.publicStates()
    const send = await createUnprovenCallTxFromInitialStates(
      this.providers.zkConfigProvider,
      {
        compiledContract: this.compiled,
        contractAddress: this.address,
        circuitId: "MintLpOrderSendXCoinToAmm",
        args: [CrossContract.commOpening(fund)],
        coinPublicKey: this.providers.walletProvider.getCoinPublicKey(),
        initialContractState: initialStates.contractState,
        initialZswapChainState: initialStates.zswapChainState,
        ledgerParameters: initialStates.ledgerParameters,
        initialPrivateState: undefined as CompactContract.PrivateState<MintLpOrderInstance>,
      },
      this.providers.walletProvider.getEncryptionPublicKey(),
    )

    await submitUnprovenTx(this.providers, mergeContractCallTxs(send, fund), {
      tokenKindsToBalance: ["dust"],
    })
  }

  async sendYCoinToAmm(amm: Amm.ContractHelpers, slot: bigint) {
    const fund = await amm.fundOrderTx("AmmFundOrderY", slot, await this.sentCoinNonceAt(2n))

    const initialStates = await this.publicStates()
    const send = await createUnprovenCallTxFromInitialStates(
      this.providers.zkConfigProvider,
      {
        compiledContract: this.compiled,
        contractAddress: this.address,
        circuitId: "MintLpOrderSendYCoinToAmm",
        args: [CrossContract.commOpening(fund)],
        coinPublicKey: this.providers.walletProvider.getCoinPublicKey(),
        initialContractState: initialStates.contractState,
        initialZswapChainState: initialStates.zswapChainState,
        ledgerParameters: initialStates.ledgerParameters,
        initialPrivateState: undefined as CompactContract.PrivateState<MintLpOrderInstance>,
      },
      this.providers.walletProvider.getEncryptionPublicKey(),
    )

    await submitUnprovenTx(this.providers, mergeContractCallTxs(send, fund), {
      tokenKindsToBalance: ["dust"],
    })
  }

  async receiveFromAmm(
    amm: Amm.ContractHelpers,
    slot: bigint,
    returnKind: bigint,
    amount: bigint,
  ) {
    const initialStates = await this.publicStates()
    const receiveCall = await createUnprovenCallTxFromInitialStates(
      this.providers.zkConfigProvider,
      {
        compiledContract: this.compiled,
        contractAddress: this.address,
        circuitId: "MintLpOrderReceiveFromAmm",
        args: [returnKind, amount, bytes32(await amm.sentCoinNonceAt(4n * slot))],
        coinPublicKey: this.providers.walletProvider.getCoinPublicKey(),
        initialContractState: initialStates.contractState,
        initialZswapChainState: initialStates.zswapChainState,
        ledgerParameters: initialStates.ledgerParameters,
        initialPrivateState: undefined as CompactContract.PrivateState<MintLpOrderInstance>,
      },
      this.providers.walletProvider.getEncryptionPublicKey(),
    )

    const pay = await amm.payTx("AmmPayLp", slot, CrossContract.commOpening(receiveCall))

    await submitUnprovenTx(this.providers, mergeContractCallTxs(pay, receiveCall), {
      tokenKindsToBalance: ["dust"],
    })
  }

  async sentCoinNonceAt(position: bigint) {
    const s = await this.state()
    return nonceEvolve(s.coins.lookup(position).nonce)
  }

  private async publicStates() {
    return await getPublicStates(this.providers.publicDataProvider, this.address)
  }
}
