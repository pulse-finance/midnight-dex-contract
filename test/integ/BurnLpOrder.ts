import { MidnightProviders } from "@midnight-ntwrk/midnight-js-types";
import { getPublicStates } from "@midnight-ntwrk/midnight-js-contracts";
import { type Ledger, ledger } from "../../dist/burnlporder/contract"

export { type Ledger }

export const ReturnKind = {
  X: 0,
  Y: 1,
  Lp: 2,
} as const;

export async function readState(
  providers: MidnightProviders,
  contractAddress: string,
): Promise<Ledger> {
  const states = await getPublicStates(providers.publicDataProvider, contractAddress);

  return ledger(states.contractState.data);
}
