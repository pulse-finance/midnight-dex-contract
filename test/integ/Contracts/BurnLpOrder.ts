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

type BurnLpOrderInstance = BurnLpOrderContract<undefined, BurnLpOrderWitnesses<undefined>>

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
  privateStateId: string
}

async function deploy(
  compiled: CompiledContract.CompiledContract<BurnLpOrderContract<any, any>, any, never>,
  providers: MidnightProviders,
): Promise<ContractAddress> {
  const deployed = await deployContract(providers as ContractProviders<BurnLpOrderInstance>, {
    compiledContract: compiled,
    args: [fromHex(entryPointHash("BurnLpOrderReceiveCoinFromAmm"))],
  })

  return deployed.deployTxData.public.contractAddress
}

export async function make(_props: BurnLpOrderProps, providers: MidnightProviders) {
  const compiled = compile()

  const address = await deploy(compiled, providers)

  const endpoints = createCircuitCallTxInterface<BurnLpOrderInstance>(
    providers as ContractProviders<BurnLpOrderInstance>,
    compiled,
    address,
    undefined,
  )

  const sentCoinNonceAt = async (position: bigint) => {
    const states = await getPublicStates(providers.publicDataProvider, address)
    return nonceEvolve(ledger(states.contractState.data).coins.lookup(position).nonce)
  }

  return {
    address,
    open: endpoints.BurnLpOrderOpen,
    reserveAmmSlot: async (
      amm: Amm.Contract,
      slot: bigint,
      orderKind: number,
      xAmount: bigint,
      yAmount: bigint,
    ) => {
      const placeOrder = await amm.placeOrderTx(
        slot,
        orderKind,
        xAmount,
        yAmount,
        CircuitId.circuitId(address, "BurnLpOrderReceiveCoinFromAmm"),
      )

      const initialStates = await getPublicStates(providers.publicDataProvider, address)
      const reserveCall = await createUnprovenCallTxFromInitialStates(
        providers.zkConfigProvider,
        {
          compiledContract: compiled,
          contractAddress: address,
          circuitId: "BurnLpOrderReserveAmmSlot",
          args: [slot, CrossContract.commOpening(placeOrder)],
          coinPublicKey: providers.walletProvider.getCoinPublicKey(),
          initialContractState: initialStates.contractState,
          initialZswapChainState: initialStates.zswapChainState,
          ledgerParameters: initialStates.ledgerParameters,
          initialPrivateState: undefined as CompactContract.PrivateState<BurnLpOrderInstance>,
        },
        providers.walletProvider.getEncryptionPublicKey(),
      )

      await submitUnprovenTx(providers, mergeContractCallTxs(reserveCall, placeOrder), {
        tokenKindsToBalance: ["dust"],
      })
    },
    sendCoinToAmm: async (amm: Amm.Contract, slot: bigint) => {
      const fund = await amm.fundOrderTx("AmmFundOrderLp", slot, await sentCoinNonceAt(0n))

      const initialStates = await getPublicStates(providers.publicDataProvider, address)
      const send = await createUnprovenCallTxFromInitialStates(
        providers.zkConfigProvider,
        {
          compiledContract: compiled,
          contractAddress: address,
          circuitId: "BurnLpOrderSendCoinToAmm",
          args: [CrossContract.commOpening(fund)],
          coinPublicKey: providers.walletProvider.getCoinPublicKey(),
          initialContractState: initialStates.contractState,
          initialZswapChainState: initialStates.zswapChainState,
          ledgerParameters: initialStates.ledgerParameters,
          initialPrivateState: undefined as CompactContract.PrivateState<BurnLpOrderInstance>,
        },
        providers.walletProvider.getEncryptionPublicKey(),
      )

      await submitUnprovenTx(providers, mergeContractCallTxs(send, fund), {
        tokenKindsToBalance: ["dust"],
      })
    },
    receiveXCoinFromAmm: async (
      amm: Amm.Contract,
      slot: bigint,
      returnKind: number,
      amount: bigint,
    ) => {
      const initialStates = await getPublicStates(providers.publicDataProvider, address)
      const receiveCall = await createUnprovenCallTxFromInitialStates(
        providers.zkConfigProvider,
        {
          compiledContract: compiled,
          contractAddress: address,
          circuitId: "BurnLpOrderReceiveCoinFromAmm",
          args: [returnKind, amount, bytes32(await amm.sentCoinNonceAt(slot * 4n))],
          coinPublicKey: providers.walletProvider.getCoinPublicKey(),
          initialContractState: initialStates.contractState,
          initialZswapChainState: initialStates.zswapChainState,
          ledgerParameters: initialStates.ledgerParameters,
          initialPrivateState: undefined as CompactContract.PrivateState<BurnLpOrderInstance>,
        },
        providers.walletProvider.getEncryptionPublicKey(),
      )

      const pay = await amm.payTx("AmmPayX", slot, CrossContract.commOpening(receiveCall))

      await submitUnprovenTx(providers, mergeContractCallTxs(pay, receiveCall), {
        tokenKindsToBalance: ["dust"],
      })
    },
    receiveYCoinFromAmm: async (
      amm: Amm.Contract,
      slot: bigint,
      returnKind: number,
      amount: bigint,
    ) => {
      const initialStates = await getPublicStates(providers.publicDataProvider, address)
      const receiveCall = await createUnprovenCallTxFromInitialStates(
        providers.zkConfigProvider,
        {
          compiledContract: compiled,
          contractAddress: address,
          circuitId: "BurnLpOrderReceiveCoinFromAmm",
          args: [returnKind, amount, bytes32(await amm.sentCoinNonceAt(slot * 4n + 2n))],
          coinPublicKey: providers.walletProvider.getCoinPublicKey(),
          initialContractState: initialStates.contractState,
          initialZswapChainState: initialStates.zswapChainState,
          ledgerParameters: initialStates.ledgerParameters,
          initialPrivateState: undefined as CompactContract.PrivateState<BurnLpOrderInstance>,
        },
        providers.walletProvider.getEncryptionPublicKey(),
      )

      const pay = await amm.payTx("AmmPayY", slot, CrossContract.commOpening(receiveCall))

      await submitUnprovenTx(providers, mergeContractCallTxs(pay, receiveCall), {
        tokenKindsToBalance: ["dust"],
      })
    },
    closeX: async (amm: Amm.Contract, slot: bigint) => {
      const clearOrder = await amm.clearOrderTx(slot)

      const initialStates = await getPublicStates(providers.publicDataProvider, address)
      const closeCall = await createUnprovenCallTxFromInitialStates(
        providers.zkConfigProvider,
        {
          compiledContract: compiled,
          contractAddress: address,
          circuitId: "BurnLpOrderCloseX",
          args: [CrossContract.commOpening(clearOrder)],
          coinPublicKey: providers.walletProvider.getCoinPublicKey(),
          initialContractState: initialStates.contractState,
          initialZswapChainState: initialStates.zswapChainState,
          ledgerParameters: initialStates.ledgerParameters,
          initialPrivateState: undefined as CompactContract.PrivateState<BurnLpOrderInstance>,
        },
        providers.walletProvider.getEncryptionPublicKey(),
      )

      await submitUnprovenTx(providers, mergeContractCallTxs(closeCall, clearOrder), {
        tokenKindsToBalance: ["dust"],
      })
    },
    closeY: endpoints.BurnLpOrderCloseY,
    state: async () => {
      const states = await getPublicStates(providers.publicDataProvider, address)

      return ledger(states.contractState.data)
    },
  }
}

export type Contract = Awaited<ReturnType<typeof make>>
