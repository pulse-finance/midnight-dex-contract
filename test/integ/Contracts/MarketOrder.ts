import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { entryPointHash } from "@midnight-ntwrk/compact-runtime";
import { ContractAddress } from "@midnight-ntwrk/ledger-v8";
import { deployContract, getPublicStates, type ContractProviders } from "@midnight-ntwrk/midnight-js-contracts";
import { MidnightProviders } from "@midnight-ntwrk/midnight-js-types";
import { fromHex } from "@midnight-ntwrk/midnight-js-utils";
import { Contract as MarketOrderContract, type Ledger, ledger, type Witnesses as MarketOrderWitnesses } from "../../../dist/marketorder/contract"
import { ORDER_OWNER_SECRET } from "../Constants";
import * as Witnesses from "./Witnesses"

export { type Ledger }

type MarketOrderInstance = MarketOrderContract<undefined, MarketOrderWitnesses<undefined>>

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
  {privateStateId}: MarketOrderProps,
  providers: MidnightProviders
): Promise<ContractAddress> {
  const deployed = await deployContract(
    providers as ContractProviders<MarketOrderInstance>,
    {
      compiledContract: compiled,
      args: [fromHex(entryPointHash("MarketOrderReceiveCoinFromAmm"))],
      privateStateId,
      initialPrivateState: undefined,
    },
  );

  return deployed.deployTxData.public.contractAddress;
}

export async function make(props: MarketOrderProps, providers: MidnightProviders) {
  const compiled = compile()

  const address = await deploy(compiled, props, providers)

  return {
    address,
    state: async () => {
      const states = await getPublicStates(providers.publicDataProvider, address);

      return ledger(states.contractState.data);
    }
  }
}
