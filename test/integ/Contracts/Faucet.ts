import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { CompiledContract } from "@midnight-ntwrk/compact-js"
import { ContractAddress, rawTokenType } from "@midnight-ntwrk/ledger-v8"
import {
  createCircuitCallTxInterface,
  deployContract,
  type ContractProviders,
} from "@midnight-ntwrk/midnight-js-contracts"
import { MidnightProviders } from "@midnight-ntwrk/midnight-js-types"
import {
  Contract as FaucetContract,
  type Witnesses as FaucetWitnesses,
} from "../../../dist/faucet/contract"
import * as Addresses from "./Addresses"
import * as Tokens from "./Tokens"

type FaucetInstance = FaucetContract<undefined, FaucetWitnesses<undefined>>

function compile() {
  const withWitnesses = CompiledContract.withVacantWitnesses(
    CompiledContract.make("Faucet", FaucetContract),
  )

  return CompiledContract.withCompiledFileAssets(
    withWitnesses,
    dirname(fileURLToPath(import.meta.resolve("../../../dist/faucet"))),
  )
}

async function deploy(
  compiled: CompiledContract.CompiledContract<FaucetContract<any, any>, any, never>,
  providers: MidnightProviders,
): Promise<ContractAddress> {
  const deployed = await deployContract(providers as ContractProviders<FaucetInstance>, {
    compiledContract: compiled,
    privateStateId: "faucet",
    initialPrivateState: undefined,
  })

  return deployed.deployTxData.public.contractAddress
}

export async function make(providers: MidnightProviders) {
  const compiled = compile()

  const address = await deploy(compiled, providers)

  const endpoints = createCircuitCallTxInterface<FaucetInstance>(
    providers as ContractProviders<FaucetInstance>,
    compiled,
    address,
    undefined,
  )

  return {
    address,
    color: (tokenName: Uint8Array) => Tokens.color(tokenName, address),
    mintShielded: endpoints.FaucetMintShielded,
  }
}
