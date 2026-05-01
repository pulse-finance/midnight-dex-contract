import { MidnightProviders } from "@midnight-ntwrk/midnight-js-types";
import { getPublicStates } from "@midnight-ntwrk/midnight-js-contracts";
import { type Ledger, ledger } from "../../dist/mintlporder/contract"

export { type Ledger }

export async function readState(
  providers: MidnightProviders,
  contractAddress: string,
): Promise<Ledger> {
  const states = await getPublicStates(providers.publicDataProvider, contractAddress);

  return ledger(states.contractState.data);
}