import { CompiledContract } from "@midnight-ntwrk/compact-js";
import type { Contract as CompactContract } from "@midnight-ntwrk/compact-js/effect/Contract";
import { entryPointHash } from "@midnight-ntwrk/compact-runtime";
import { ContractAddress } from "@midnight-ntwrk/ledger-v8";
import { createCircuitCallTxInterface, createUnprovenCallTxFromInitialStates, deployContract, getPublicStates, type ContractProviders } from "@midnight-ntwrk/midnight-js-contracts";
import { MidnightProviders } from "@midnight-ntwrk/midnight-js-types";
import { fromHex } from "@midnight-ntwrk/midnight-js-utils";
import { Contract as MintLpOrderContract, type Ledger, ledger, type Witnesses as MintLpOrderWitnesses } from "../../../dist/mintlporder/contract"
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { ORDER_OWNER_SECRET } from "../Constants";
import { bytes32, littleEndianHexToField, submitUnprovenTx } from "../integ-support";
import * as Amm from "./Amm";
import * as CircuitId from "./CircuitId"
import * as CrossContract from "./CrossContract"
import * as Witnesses from "./Witnesses"
import { mergeContractCallTxs } from "../merge";


export { type Ledger }

type MintLpOrderInstance = MintLpOrderContract<undefined, MintLpOrderWitnesses<undefined>>
function compile() {
  const withWitnesses = CompiledContract.withWitnesses(CompiledContract.make("MintLpOrder", MintLpOrderContract), {
    newNonce: Witnesses.newNonce(2_000),
    ownerSecret: Witnesses.actorSecret(ORDER_OWNER_SECRET),
  })

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
  providers: MidnightProviders
): Promise<ContractAddress> {
  const deployed = await deployContract(
    providers as ContractProviders<MintLpOrderInstance>,
    {
      compiledContract: compiled,
      args: [fromHex(entryPointHash("MintLpOrderReceiveFromAmm"))],
    },
  );

  return deployed.deployTxData.public.contractAddress;
}

export async function make(_props: MintLpOrderProps, providers: MidnightProviders) {
  const compiled = compile()

  const address = await deploy(compiled, providers);

  const endpoints = createCircuitCallTxInterface<MintLpOrderInstance>(
    providers as ContractProviders<MintLpOrderInstance>,
    compiled,
    address,
    undefined,
  )

  return {
    address,
    open: endpoints.MintLpOrderOpen,
    reserveAmmSlot: async (
      amm: Amm.Contract,
      slot: bigint,
      xAmount: bigint,
      yAmount: bigint,
    ) => {
       const placeOrder = await amm.placeOrder(
            slot,
            Amm.OrderKind.DepositXYLiq,
            xAmount,
            yAmount,
            CircuitId.circuitId(address, "MintLpOrderReceiveFromAmm" satisfies keyof typeof endpoints),
       );

      const reserveCall = await endpoints.MintLpOrderReserveAmmSlot(
        slot, 
        CrossContract.commOpening(placeOrder)
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
    sendXCoinToAmm: async (amm: Amm.Contract, slot: bigint, opening: bigint, amount: bigint) => {
      const initialStates = await getPublicStates(providers.publicDataProvider, address);
      const send = await createUnprovenCallTxFromInitialStates(
        providers.zkConfigProvider,
        {
          compiledContract: compiled,
          contractAddress: address,
          circuitId: "MintLpOrderSendXCoinToAmm",
          args: [opening],
          coinPublicKey: providers.walletProvider.getCoinPublicKey(),
          initialContractState: initialStates.contractState,
          initialZswapChainState: initialStates.zswapChainState,
          ledgerParameters: initialStates.ledgerParameters,
          initialPrivateState: undefined as CompactContract.PrivateState<MintLpOrderInstance>,
        },
        providers.walletProvider.getEncryptionPublicKey(),
      );
      const forwarded = send.private.nextZswapLocalState.outputs.find((output) => !output.recipient.is_left && output.coinInfo.value === amount);
      if (!forwarded) {
        throw new Error("Missing output: mint forwarded X");
      }

      await submitUnprovenTx(
        providers,
        mergeContractCallTxs(
          { callTxData: send, zswapLocalState: send.private.nextZswapLocalState },
          await amm.fundOrder("AmmFundOrderX", slot, bytes32(forwarded.coinInfo.nonce)),
        ),
        { tokenKindsToBalance: ["dust"] },
      );
    },
    sendYCoinToAmm: async (amm: Amm.Contract, slot: bigint, opening: bigint, amount: bigint) => {
      const initialStates = await getPublicStates(providers.publicDataProvider, address);
      const send = await createUnprovenCallTxFromInitialStates(
        providers.zkConfigProvider,
        {
          compiledContract: compiled,
          contractAddress: address,
          circuitId: "MintLpOrderSendYCoinToAmm",
          args: [opening],
          coinPublicKey: providers.walletProvider.getCoinPublicKey(),
          initialContractState: initialStates.contractState,
          initialZswapChainState: initialStates.zswapChainState,
          ledgerParameters: initialStates.ledgerParameters,
          initialPrivateState: undefined as CompactContract.PrivateState<MintLpOrderInstance>,
        },
        providers.walletProvider.getEncryptionPublicKey(),
      );
      const forwarded = send.private.nextZswapLocalState.outputs.find((output) => !output.recipient.is_left && output.coinInfo.value === amount);
      if (!forwarded) {
        throw new Error("Missing output: mint forwarded Y");
      }

      await submitUnprovenTx(
        providers,
        mergeContractCallTxs(
          { callTxData: send, zswapLocalState: send.private.nextZswapLocalState },
          await amm.fundOrder("AmmFundOrderY", slot, bytes32(forwarded.coinInfo.nonce)),
        ),
        { tokenKindsToBalance: ["dust"] },
      );
    },
    receiveFromAmm: async (
      amm: Amm.Contract,
      slot: bigint,
      returnKind: bigint,
      amount: bigint,
      opening: bigint,
    ) => {
      const pay = await amm.pay("AmmPayLp", slot, opening);
      const returned = pay.zswapLocalState.outputs.find((output) => !output.recipient.is_left && output.coinInfo.value === amount);
      if (!returned) {
        throw new Error("Missing output: mint paid LP");
      }
      const initialStates = await getPublicStates(providers.publicDataProvider, address);
      const receiveCall = await createUnprovenCallTxFromInitialStates(
        providers.zkConfigProvider,
        {
          compiledContract: compiled,
          contractAddress: address,
          circuitId: "MintLpOrderReceiveFromAmm",
          args: [returnKind, amount, bytes32(returned.coinInfo.nonce)],
          coinPublicKey: providers.walletProvider.getCoinPublicKey(),
          initialContractState: initialStates.contractState,
          initialZswapChainState: initialStates.zswapChainState,
          ledgerParameters: initialStates.ledgerParameters,
          initialPrivateState: undefined as CompactContract.PrivateState<MintLpOrderInstance>,
        },
        providers.walletProvider.getEncryptionPublicKey(),
      );

      await submitUnprovenTx(
        providers,
        mergeContractCallTxs(pay, { callTxData: receiveCall, zswapLocalState: receiveCall.private.nextZswapLocalState }),
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
