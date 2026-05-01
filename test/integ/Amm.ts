import { MidnightProviders } from "@midnight-ntwrk/midnight-js-types";
import { getPublicStates } from "@midnight-ntwrk/midnight-js-contracts";
import { type Ledger, ledger } from "../../dist/amm/contract"
import { entryPointHash } from "@midnight-ntwrk/compact-runtime";
import { fromHex } from "@midnight-ntwrk/midnight-js-utils";

export { type Ledger }

export type Parameters = Omit<Ledger, "treasury" | "batcherCommitment" | "xColor" | "yColor" | "slots" | "active" | "coins">

export type CircuitId = { address: { bytes: Uint8Array }, hash: Uint8Array };
export type CircuitIds = {
  address: { bytes: Uint8Array };
  placeOrder: Uint8Array;
  fundOrder: Uint8Array;
  fundOrderAlt: Uint8Array;
  clearOrder: Uint8Array;
};

export const OrderKind = {
  DepositXYLiq: 0,
  DepositXLiq: 1,
  DepositYLiq: 2,
  SwapXToY: 3,
  SwapYToX: 4,
  WithdrawXYLiq: 5,
  WithdrawXLiq: 6,
  WithdrawYLiq: 7,
} as const;

export const Operations = [
  "AmmXLiq",
  "AmmYLiq",
  "AmmInitXYLiq",
  "AmmPlaceOrder",
  "AmmFundOrderX",
  "AmmFundOrderY",
  "AmmFundOrderLp",
  "AmmMergeCoins",
  "AmmActivateOrder",
  "AmmValidateDepositXYLiq",
  "AmmValidateDepositXLiq",
  "AmmValidateDepositYLiq",
  "AmmValidateSwapXToY",
  "AmmValidateSwapYToX",
  "AmmValidateWithdrawXYLiq",
  "AmmValidateWithdrawXLiq",
  "AmmValidateWithdrawYLiq",
  "AmmMintLp",
  "AmmSplitX",
  "AmmSplitY",
  "AmmPayX",
  "AmmPayY",
  "AmmPayLp",
  "AmmClearOrder",
  "AmmReward",
  "AmmUpdate",
] as const;

export function circuitId(contractAddress: string, entrypoint: string): CircuitId {
  return {
    address: { bytes: fromHex(contractAddress) },
    hash: fromHex(entryPointHash(entrypoint)),
  };
}

export function circuitIds(contractAddress: string, fundOrder: string, fundOrderAlt = fundOrder): CircuitIds {
  return {
    address: { bytes: fromHex(contractAddress) },
    placeOrder: fromHex(entryPointHash("AmmPlaceOrder")),
    fundOrder: fromHex(entryPointHash(fundOrder)),
    fundOrderAlt: fromHex(entryPointHash(fundOrderAlt)),
    clearOrder: fromHex(entryPointHash("AmmClearOrder")),
  };
}

export async function readState(
  providers: MidnightProviders,
  contractAddress: string,
): Promise<Ledger> {
  const states = await getPublicStates(providers.publicDataProvider, contractAddress);

  return ledger(states.contractState.data);
}
