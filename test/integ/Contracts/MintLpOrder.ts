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

type MintLpOrderProps = {
  privateStateId: string
}

async function deploy(
  compiled: CompiledContract.CompiledContract<MintLpOrderContract<any, any>, any, never>,
  providers: MidnightProviders,
): Promise<ContractAddress> {
  const deployed = await deployContract(providers as ContractProviders<MintLpOrderInstance>, {
    compiledContract: compiled,
    args: [fromHex(entryPointHash("MintLpOrderReceiveFromAmm"))],
  })

  return deployed.deployTxData.public.contractAddress
}

export async function make(_props: MintLpOrderProps, providers: MidnightProviders) {
  const compiled = compile()

  const address = await deploy(compiled, providers)

  const endpoints = createCircuitCallTxInterface<MintLpOrderInstance>(
    providers as ContractProviders<MintLpOrderInstance>,
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

  return {
    address,
    state,
    sentCoinNonceAt,
    open: endpoints.MintLpOrderOpen,
    reserveAmmSlot: async (amm: Amm.Contract, slot: bigint, xAmount: bigint, yAmount: bigint) => {
      const placeOrder = await amm.placeOrderTx(
        slot,
        Amm.OrderKind.DepositXYLiq,
        xAmount,
        yAmount,
        CircuitId.circuitId(address, "MintLpOrderReceiveFromAmm"),
      )

      const initialStates = await getPublicStates(providers.publicDataProvider, address)
      const reserveCall = await createUnprovenCallTxFromInitialStates(
        providers.zkConfigProvider,
        {
          compiledContract: compiled,
          contractAddress: address,
          circuitId: "MintLpOrderReserveAmmSlot",
          args: [slot, CrossContract.commOpening(placeOrder)],
          coinPublicKey: providers.walletProvider.getCoinPublicKey(),
          initialContractState: initialStates.contractState,
          initialZswapChainState: initialStates.zswapChainState,
          ledgerParameters: initialStates.ledgerParameters,
          initialPrivateState: undefined,
        },
        providers.walletProvider.getEncryptionPublicKey(),
      )

      await submitUnprovenTx(providers, mergeContractCallTxs(reserveCall, placeOrder), {
        tokenKindsToBalance: ["dust"],
      })
    },
    sendXCoinToAmm: async (amm: Amm.Contract, slot: bigint) => {
      const fund = await amm.fundOrderTx("AmmFundOrderX", slot, bytes32(await sentCoinNonceAt(0n)))

      const initialStates = await getPublicStates(providers.publicDataProvider, address)
      const send = await createUnprovenCallTxFromInitialStates(
        providers.zkConfigProvider,
        {
          compiledContract: compiled,
          contractAddress: address,
          circuitId: "MintLpOrderSendXCoinToAmm",
          args: [CrossContract.commOpening(fund)],
          coinPublicKey: providers.walletProvider.getCoinPublicKey(),
          initialContractState: initialStates.contractState,
          initialZswapChainState: initialStates.zswapChainState,
          ledgerParameters: initialStates.ledgerParameters,
          initialPrivateState: undefined,
        },
        providers.walletProvider.getEncryptionPublicKey(),
      )

      await submitUnprovenTx(providers, mergeContractCallTxs(send, fund), {
        tokenKindsToBalance: ["dust"],
      })
    },
    sendYCoinToAmm: async (amm: Amm.Contract, slot: bigint) => {
      const fund = await amm.fundOrderTx("AmmFundOrderY", slot, bytes32(await sentCoinNonceAt(2n)))

      const initialStates = await getPublicStates(providers.publicDataProvider, address)
      const send = await createUnprovenCallTxFromInitialStates(
        providers.zkConfigProvider,
        {
          compiledContract: compiled,
          contractAddress: address,
          circuitId: "MintLpOrderSendYCoinToAmm",
          args: [CrossContract.commOpening(fund)],
          coinPublicKey: providers.walletProvider.getCoinPublicKey(),
          initialContractState: initialStates.contractState,
          initialZswapChainState: initialStates.zswapChainState,
          ledgerParameters: initialStates.ledgerParameters,
          initialPrivateState: undefined,
        },
        providers.walletProvider.getEncryptionPublicKey(),
      )

      await submitUnprovenTx(providers, mergeContractCallTxs(send, fund), {
        tokenKindsToBalance: ["dust"],
      })
    },
    receiveFromAmm: async (amm: Amm.Contract, slot: bigint, returnKind: bigint, amount: bigint) => {
      const initialStates = await getPublicStates(providers.publicDataProvider, address)
      const receiveCall = await createUnprovenCallTxFromInitialStates(
        providers.zkConfigProvider,
        {
          compiledContract: compiled,
          contractAddress: address,
          circuitId: "MintLpOrderReceiveFromAmm",
          args: [returnKind, amount, bytes32(await amm.sentCoinNonceAt(4n * slot))],
          coinPublicKey: providers.walletProvider.getCoinPublicKey(),
          initialContractState: initialStates.contractState,
          initialZswapChainState: initialStates.zswapChainState,
          ledgerParameters: initialStates.ledgerParameters,
          initialPrivateState: undefined,
        },
        providers.walletProvider.getEncryptionPublicKey(),
      )

      const pay = await amm.payTx("AmmPayLp", slot, CrossContract.commOpening(receiveCall))

      await submitUnprovenTx(providers, mergeContractCallTxs(pay, receiveCall), {
        tokenKindsToBalance: ["dust"],
      })
    },
  }
}

export type Contract = Awaited<ReturnType<typeof make>>
