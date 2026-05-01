import { describe, expect, it } from "bun:test";
import {
    burnLpAmmClearOrderCircuitHash,
    burnLpAmmContractAddress,
    burnLpAmmFundOrderLpCircuitHash,
    burnLpAmmPlaceOrderCircuitHash,
    burnLpColor,
    burnLpOtherSecret,
    burnLpOtherUser,
    burnLpOwner,
    BurnLpOrderSimulator,
    burnLpValue,
    burnLpXReturnedValue,
    burnLpXReturnColor,
    burnLpYReturnedValue,
    burnLpYReturnColor,
    encodedBurnLpAmmContractAddress,
} from "./BurnLpOrderSimulator";

describe("BurnLpOrder", () => {
    it("rejects actions in the wrong state", () => {
        const simulator = new BurnLpOrderSimulator();

        expect(() => simulator.sendToAmm()).toThrow(/Unexpected BurnLpOrder state/);
        expect(() => simulator.receiveXFromAmm()).toThrow(/Unexpected BurnLpOrder state/);
        expect(() => simulator.close()).toThrow(/Can only be performed by the order owner/);

        simulator.openOrder();
        expect(() => simulator.openOrder()).toThrow(/BurnLpOrder already occupied/);
        expect(() => simulator.receiveXFromAmm()).toThrow(/Unexpected BurnLpOrder state/);
    });

    it("opens, sends, receives X and Y, and closes", () => {
        const simulator = new BurnLpOrderSimulator();
        simulator.openOrder();

        let ledger = simulator.currentLedger();
        expect(ledger.state).toBe(1);
        expect(ledger.order.amountSent).toBe(burnLpValue);
        expect(ledger.order.colorSent).toEqual(burnLpColor);
        expect(ledger.order.xColorReturned).toEqual(burnLpXReturnColor);
        expect(ledger.order.yColorReturned).toEqual(burnLpYReturnColor);
        expect(ledger.order.returnsTo.bytes).toEqual(burnLpOwner.bytes);
        expect(ledger.order.amm.address.bytes).toEqual(encodedBurnLpAmmContractAddress.bytes);
        expect(ledger.coins.lookup(0n).value).toBe(burnLpValue);

        const sent = simulator.sendToAmm();
        ledger = simulator.currentLedger();
        expect(ledger.state).toBe(3);
        expect(ledger.ammSlot).toBe(1n);
        expect(ledger.coins.isEmpty()).toBe(true);
        const hashes = sent.context.currentQueryContext.effects.claimedContractCalls.map((call) => call[2]);
        expect(sent.context.currentQueryContext.effects.claimedContractCalls.every((call) => call[1] === burnLpAmmContractAddress))
            .toBe(true);
        expect(hashes).toContain(Buffer.from(burnLpAmmFundOrderLpCircuitHash).toString("hex"));
        expect(Buffer.from(burnLpAmmPlaceOrderCircuitHash).length).toBe(32);

        simulator.receiveXFromAmm();
        simulator.receiveYFromAmm();
        expect(simulator.currentLedger().coins.lookup(0n).value).toBe(burnLpXReturnedValue);
        expect(simulator.currentLedger().coins.lookup(2n).value).toBe(burnLpYReturnedValue);

        expect(() => simulator.close({ sender: burnLpOtherUser, secret: burnLpOtherSecret }))
            .toThrow(/Can only be performed by the order owner/);

        const closed = simulator.close();
        expect(simulator.currentLedger().state).toBe(0);
        expect(simulator.currentLedger().coins.isEmpty()).toBe(true);
        expect(closed.context.currentZswapLocalState.outputs[0].coinInfo.value).toBe(burnLpYReturnedValue);
        expect(Buffer.from(burnLpAmmClearOrderCircuitHash).length).toBe(32);
    });

    it("rejects unexpected return kinds and unmerged spam coins", () => {
        const simulator = new BurnLpOrderSimulator();
        simulator.openOrder();
        simulator.sendToAmm();

        expect(() => simulator.receiveUnexpectedFromAmm()).toThrow(/Unexpected return kind/);

        simulator.receiveXFromAmm();
        simulator.receiveXFromAmm({ amount: 1n, coinIndex: 1n });
        expect(() => simulator.receiveXFromAmm({ amount: 1n, coinIndex: 1n }))
            .toThrow(/Second pos already occupied/);
        expect(() => simulator.close()).toThrow(/Spam coin not merged/);
    });
});
