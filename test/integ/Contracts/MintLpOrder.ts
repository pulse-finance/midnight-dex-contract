import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { entryPointHash } from "@midnight-ntwrk/compact-runtime";
import { ContractAddress } from "@midnight-ntwrk/ledger-v8";
import { createCircuitCallTxInterface, deployContract, getPublicStates, type ContractProviders } from "@midnight-ntwrk/midnight-js-contracts";
import { MidnightProviders } from "@midnight-ntwrk/midnight-js-types";
import { fromHex } from "@midnight-ntwrk/midnight-js-utils";
import { Contract as MintLpOrderContract, type Ledger, ledger, type Witnesses as MintLpOrderWitnesses } from "../../../dist/mintlporder/contract"
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { ORDER_OWNER_SECRET } from "../Constants";
import * as Witnesses from "./Witnesses"


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
  {privateStateId}: MintLpOrderProps,
  providers: MidnightProviders
): Promise<ContractAddress> {
  const deployed = await deployContract(
    providers as ContractProviders<MintLpOrderInstance>,
    {
      compiledContract: compiled,
      args: [fromHex(entryPointHash("MintLpOrderReceiveFromAmm"))],
      privateStateId,
      initialPrivateState: undefined,
    },
  );

  return deployed.deployTxData.public.contractAddress;
}

export async function make(props: MintLpOrderProps, providers: MidnightProviders) {
  const compiled = compile()

  const address = await deploy(compiled, props, providers);

  const endpoints = createCircuitCallTxInterface<MintLpOrderInstance>(
    providers as ContractProviders<MintLpOrderInstance>,
    compiled,
    address,
    props.privateStateId
  )
  
  return {
    address,
    open: endpoints.MintLpOrderOpen,
    state: async () => {
      const states = await getPublicStates(providers.publicDataProvider, address);

      return ledger(states.contractState.data);
    }
  }
}
