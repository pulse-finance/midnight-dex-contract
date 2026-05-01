import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import type { Contract as CompactContract } from "@midnight-ntwrk/compact-js/effect/Contract";
import { entryPointHash } from "@midnight-ntwrk/compact-runtime";
import { ContractAddress } from "@midnight-ntwrk/ledger-v8";
import { createCircuitCallTxInterface, createUnprovenCallTxFromInitialStates, deployContract, getPublicStates, type ContractProviders } from "@midnight-ntwrk/midnight-js-contracts";
import { MidnightProviders } from "@midnight-ntwrk/midnight-js-types";
import { fromHex } from "@midnight-ntwrk/midnight-js-utils";
import { Contract as BurnLpOrderContract, type Ledger, ledger, type Witnesses as BurnLpOrderWitnesses } from "../../../dist/burnlporder/contract"
import { ORDER_OWNER_SECRET } from "../Constants";
import { bytes32, submitUnprovenTx } from "../integ-support";
import type * as Amm from "./Amm";
import * as CircuitId from "./CircuitId"
import * as Witnesses from "./Witnesses"
import { mergeContractCallTxs } from "../merge";

export { type Ledger }

type BurnLpOrderInstance = BurnLpOrderContract<undefined, BurnLpOrderWitnesses<undefined>>

export const ReturnKind = {
  X: 0,
  Y: 1,
} as const;

function compile() {
  const withWitnesses = CompiledContract.withWitnesses(CompiledContract.make("BurnLpOrder", BurnLpOrderContract), {
    newNonce: Witnesses.newNonce(3_000),
    ownerSecret: Witnesses.actorSecret(ORDER_OWNER_SECRET),
  })

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
  providers: MidnightProviders
): Promise<ContractAddress> {
  const deployed = await deployContract(
    providers as ContractProviders<BurnLpOrderInstance>,
    {
      compiledContract: compiled,
      args: [
        fromHex(entryPointHash("BurnLpOrderReceiveCoinFromAmm")),
      ],
    },
  );

  return deployed.deployTxData.public.contractAddress;
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

  return {
    address,
    open: endpoints.BurnLpOrderOpen,
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
          circuitId: "BurnLpOrderReserveAmmSlot",
          args: [slot, opening],
          coinPublicKey: providers.walletProvider.getCoinPublicKey(),
          initialContractState: initialStates.contractState,
          initialZswapChainState: initialStates.zswapChainState,
          ledgerParameters: initialStates.ledgerParameters,
          initialPrivateState: undefined as CompactContract.PrivateState<BurnLpOrderInstance>,
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
            CircuitId.circuitId(address, "BurnLpOrderReceiveCoinFromAmm"),
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
    ) => {
      const initialStates = await getPublicStates(providers.publicDataProvider, address);
      const send = await createUnprovenCallTxFromInitialStates(
        providers.zkConfigProvider,
        {
          compiledContract: compiled,
          contractAddress: address,
          circuitId: "BurnLpOrderSendCoinToAmm",
          args: [opening],
          coinPublicKey: providers.walletProvider.getCoinPublicKey(),
          initialContractState: initialStates.contractState,
          initialZswapChainState: initialStates.zswapChainState,
          ledgerParameters: initialStates.ledgerParameters,
          initialPrivateState: undefined as CompactContract.PrivateState<BurnLpOrderInstance>,
        },
        providers.walletProvider.getEncryptionPublicKey(),
      );
      const forwarded = send.private.nextZswapLocalState.outputs.find((output) => !output.recipient.is_left && output.coinInfo.value === amount);
      if (!forwarded) {
        throw new Error("Missing output: burn forwarded LP");
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
          circuitId: "BurnLpOrderReceiveCoinFromAmm",
          args: [returnKind, amount, bytes32(returned.coinInfo.nonce)],
          coinPublicKey: providers.walletProvider.getCoinPublicKey(),
          initialContractState: initialStates.contractState,
          initialZswapChainState: initialStates.zswapChainState,
          ledgerParameters: initialStates.ledgerParameters,
          initialPrivateState: undefined as CompactContract.PrivateState<BurnLpOrderInstance>,
        },
        providers.walletProvider.getEncryptionPublicKey(),
      );

      await submitUnprovenTx(
        providers,
        mergeContractCallTxs(pay, { callTxData: receiveCall, zswapLocalState: receiveCall.private.nextZswapLocalState }),
        { tokenKindsToBalance: ["dust"] },
      );
    },
    closeX: async (amm: Amm.Contract, slot: bigint, opening: bigint) => {
      const initialStates = await getPublicStates(providers.publicDataProvider, address);
      const closeCall = await createUnprovenCallTxFromInitialStates(
        providers.zkConfigProvider,
        {
          compiledContract: compiled,
          contractAddress: address,
          circuitId: "BurnLpOrderCloseX",
          args: [opening],
          coinPublicKey: providers.walletProvider.getCoinPublicKey(),
          initialContractState: initialStates.contractState,
          initialZswapChainState: initialStates.zswapChainState,
          ledgerParameters: initialStates.ledgerParameters,
          initialPrivateState: undefined as CompactContract.PrivateState<BurnLpOrderInstance>,
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
    closeY: endpoints.BurnLpOrderCloseY,
    state: async () => {
      const states = await getPublicStates(providers.publicDataProvider, address);

      return ledger(states.contractState.data);
    }
  }
}

export type Contract = Awaited<ReturnType<typeof make>>
