import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import type { Contract as CompactContract } from "@midnight-ntwrk/compact-js/effect/Contract";
import { entryPointHash } from "@midnight-ntwrk/compact-runtime";
import { ContractAddress } from "@midnight-ntwrk/ledger-v8";
import { createCircuitCallTxInterface, createUnprovenCallTxFromInitialStates, deployContract, getPublicStates, type ContractProviders } from "@midnight-ntwrk/midnight-js-contracts";
import { MidnightProviders } from "@midnight-ntwrk/midnight-js-types";
import { fromHex } from "@midnight-ntwrk/midnight-js-utils";
import { Contract as MarketOrderContract, type Ledger, ledger, type Witnesses as MarketOrderWitnesses } from "../../../dist/marketorder/contract"
import { ORDER_OWNER_SECRET } from "../Constants";
import { bytes32, submitUnprovenTx } from "../integ-support";
import type * as Amm from "./Amm";
import * as CircuitId from "./CircuitId"
import * as Witnesses from "./Witnesses"
import { mergeContractCallTxs } from "../merge";

export { type Ledger }

type MarketOrderInstance = MarketOrderContract<undefined, MarketOrderWitnesses<undefined>>

export const ReturnKind = {
  X: 0,
  Y: 1,
  Lp: 2,
} as const;

function compile() {
  const withWitnesses = CompiledContract.withWitnesses(CompiledContract.make("MarketOrder", MarketOrderContract), {
    newNonce: Witnesses.newNonce(4_000),
    ownerSecret: Witnesses.actorSecret(ORDER_OWNER_SECRET),
  })

  return CompiledContract.withCompiledFileAssets(
    withWitnesses,
    dirname(fileURLToPath(import.meta.resolve("../../../dist/marketorder"))),
  )
}

type MarketOrderProps = {
  privateStateId: string
}

async function deploy(
  compiled: CompiledContract.CompiledContract<MarketOrderContract<any, any>, any, never>,
  providers: MidnightProviders
): Promise<ContractAddress> {
  const deployed = await deployContract(
    providers as ContractProviders<MarketOrderInstance>,
    {
      compiledContract: compiled,
      args: [fromHex(entryPointHash("MarketOrderReceiveCoinFromAmm"))],
    },
  );

  return deployed.deployTxData.public.contractAddress;
}

export async function make(_props: MarketOrderProps, providers: MidnightProviders) {
  const compiled = compile()

  const address = await deploy(compiled, providers)

  const endpoints = createCircuitCallTxInterface<MarketOrderInstance>(
    providers as ContractProviders<MarketOrderInstance>,
    compiled,
    address,
    undefined,
  )

  return {
    address,
    open: endpoints.MarketOrderOpen,
    reserveAmmSlot: async (
      amm: Amm.Contract,
      slot: bigint,
      orderKind: number,
      xAmount: bigint,
      yAmount: bigint,
      opening: bigint,
    ) => {
      const initialStates = await getPublicStates(providers.publicDataProvider, address);
      const reserveCall = await createUnprovenCallTxFromInitialStates(
        providers.zkConfigProvider,
        {
          compiledContract: compiled,
          contractAddress: address,
          circuitId: "MarketOrderReserveAmmSlot",
          args: [slot, opening],
          coinPublicKey: providers.walletProvider.getCoinPublicKey(),
          initialContractState: initialStates.contractState,
          initialZswapChainState: initialStates.zswapChainState,
          ledgerParameters: initialStates.ledgerParameters,
          initialPrivateState: undefined as CompactContract.PrivateState<MarketOrderInstance>,
        },
        providers.walletProvider.getEncryptionPublicKey(),
      );
      const placeOrderStates = await getPublicStates(providers.publicDataProvider, amm.address);
      const placeOrder = await createUnprovenCallTxFromInitialStates(
        providers.zkConfigProvider,
        {
          compiledContract: amm.compiled,
          contractAddress: amm.address,
          circuitId: "AmmPlaceOrder",
          args: [
            slot,
            orderKind,
            xAmount,
            yAmount,
            CircuitId.circuitId(address, "MarketOrderReceiveCoinFromAmm"),
          ],
          coinPublicKey: providers.walletProvider.getCoinPublicKey(),
          initialContractState: placeOrderStates.contractState,
          initialZswapChainState: placeOrderStates.zswapChainState,
          ledgerParameters: placeOrderStates.ledgerParameters,
          initialPrivateState: undefined,
        },
        providers.walletProvider.getEncryptionPublicKey(),
      );

      await submitUnprovenTx(
        providers,
        mergeContractCallTxs(
          { callTxData: reserveCall, zswapLocalState: reserveCall.private.nextZswapLocalState },
          { callTxData: placeOrder, zswapLocalState: placeOrder.private.nextZswapLocalState },
        ),
        { tokenKindsToBalance: ["dust"] },
      );
    },
    sendCoinToAmm: async (
      amm: Amm.Contract,
      fundCircuit: Amm.FundCircuit,
      slot: bigint,
      opening: bigint,
      amount: bigint,
      description: string,
    ) => {
      const initialStates = await getPublicStates(providers.publicDataProvider, address);
      const send = await createUnprovenCallTxFromInitialStates(
        providers.zkConfigProvider,
        {
          compiledContract: compiled,
          contractAddress: address,
          circuitId: "MarketOrderSendCoinToAmm",
          args: [opening],
          coinPublicKey: providers.walletProvider.getCoinPublicKey(),
          initialContractState: initialStates.contractState,
          initialZswapChainState: initialStates.zswapChainState,
          ledgerParameters: initialStates.ledgerParameters,
          initialPrivateState: undefined as CompactContract.PrivateState<MarketOrderInstance>,
        },
        providers.walletProvider.getEncryptionPublicKey(),
      );
      const forwarded = send.private.nextZswapLocalState.outputs.find((output) => !output.recipient.is_left && output.coinInfo.value === amount);
      if (!forwarded) {
        throw new Error(`Missing output: ${description}`);
      }

      await submitUnprovenTx(
        providers,
        mergeContractCallTxs(
          { callTxData: send, zswapLocalState: send.private.nextZswapLocalState },
          await amm.fundOrder(fundCircuit, slot, bytes32(forwarded.coinInfo.nonce)),
        ),
        { tokenKindsToBalance: ["dust"] },
      );
    },
    receiveCoinFromAmm: async (
      amm: Amm.Contract,
      payCircuit: Amm.PayCircuit,
      slot: bigint,
      returnKind: number,
      amount: bigint,
      opening: bigint,
      description: string,
    ) => {
      const pay = await amm.pay(payCircuit, slot, opening);
      const returned = pay.zswapLocalState.outputs.find((output) => !output.recipient.is_left && output.coinInfo.value === amount);
      if (!returned) {
        throw new Error(`Missing output: ${description}`);
      }
      const initialStates = await getPublicStates(providers.publicDataProvider, address);
      const receiveCall = await createUnprovenCallTxFromInitialStates(
        providers.zkConfigProvider,
        {
          compiledContract: compiled,
          contractAddress: address,
          circuitId: "MarketOrderReceiveCoinFromAmm",
          args: [returnKind, amount, bytes32(returned.coinInfo.nonce)],
          coinPublicKey: providers.walletProvider.getCoinPublicKey(),
          initialContractState: initialStates.contractState,
          initialZswapChainState: initialStates.zswapChainState,
          ledgerParameters: initialStates.ledgerParameters,
          initialPrivateState: undefined as CompactContract.PrivateState<MarketOrderInstance>,
        },
        providers.walletProvider.getEncryptionPublicKey(),
      );

      await submitUnprovenTx(
        providers,
        mergeContractCallTxs(pay, { callTxData: receiveCall, zswapLocalState: receiveCall.private.nextZswapLocalState }),
        { tokenKindsToBalance: ["dust"] },
      );
    },
    close: async (amm: Amm.Contract, slot: bigint, opening: bigint) => {
      const initialStates = await getPublicStates(providers.publicDataProvider, address);
      const closeCall = await createUnprovenCallTxFromInitialStates(
        providers.zkConfigProvider,
        {
          compiledContract: compiled,
          contractAddress: address,
          circuitId: "MarketOrderClose",
          args: [opening],
          coinPublicKey: providers.walletProvider.getCoinPublicKey(),
          initialContractState: initialStates.contractState,
          initialZswapChainState: initialStates.zswapChainState,
          ledgerParameters: initialStates.ledgerParameters,
          initialPrivateState: undefined as CompactContract.PrivateState<MarketOrderInstance>,
        },
        providers.walletProvider.getEncryptionPublicKey(),
      );

      await submitUnprovenTx(
        providers,
        mergeContractCallTxs(
          { callTxData: closeCall, zswapLocalState: closeCall.private.nextZswapLocalState },
          await amm.clearOrder(slot),
        ),
        { tokenKindsToBalance: ["dust"] },
      );
    },
    state: async () => {
      const states = await getPublicStates(providers.publicDataProvider, address);

      return ledger(states.contractState.data);
    }
  }
}

export type Contract = Awaited<ReturnType<typeof make>>
