import { describe, expect, it } from "bun:test";
import {
    ammClearOrderCircuitHash,
    ammContractAddress,
    ammFundOrderXCircuitHash,
    ammPlaceOrderCircuitHash,
    coinColor,
    coinValue,
    encodedAmmContractAddress,
    MarketOrderSimulator,
    otherSecret,
    otherUser,
    owner,
    returnColor,
    returnedValue,
} from "./MarketOrderSimulator";

describe("MarketOrder", () => {
    it("rejects actions in the wrong state", () => {
        const simulator = new MarketOrderSimulator();

        expect(() => simulator.sendToAmm()).toThrow(/Unexpected MarketOrder state/);
        expect(() => simulator.receiveFromAmm()).toThrow(/Unexpected MarketOrder state/);
        expect(() => simulator.close()).toThrow(/Can only be performed by the order owner/);

        simulator.openOrder();
        expect(() => simulator.openOrder()).toThrow(/MarketOrder slot already occupied/);
        expect(() => simulator.receiveFromAmm()).toThrow(/Unexpected MarketOrder state/);
    });

    it("opens, reserves, sends, receives, and closes", () => {
        const simulator = new MarketOrderSimulator();
        simulator.openOrder();

        let ledger = simulator.currentLedger();
        expect(ledger.state).toBe(1);
        expect(ledger.order.amountSent).toBe(coinValue);
        expect(ledger.order.colorSent).toEqual(coinColor);
        expect(ledger.order.colorReturned).toEqual(returnColor);
        expect(ledger.order.returnsTo.bytes).toEqual(owner.bytes);
        expect(ledger.order.amm.address.bytes).toEqual(encodedAmmContractAddress.bytes);
        expect(ledger.coins.lookup(0n).value).toBe(coinValue);

        const sent = simulator.sendToAmm();
        ledger = simulator.currentLedger();
        expect(ledger.state).toBe(3);
        expect(ledger.ammSlot).toBe(1n);
        expect(ledger.coins.isEmpty()).toBe(true);
        const calls = sent.context.currentQueryContext.effects.claimedContractCalls;
        expect(calls.every((call) => call[1] === ammContractAddress)).toBe(true);
        expect(calls.map((call) => call[2])).toContain(Buffer.from(ammFundOrderXCircuitHash).toString("hex"));

        simulator.receiveFromAmm();
        expect(simulator.currentLedger().coins.lookup(0n).value).toBe(returnedValue);

        expect(() => simulator.close({ sender: otherUser, secret: otherSecret }))
            .toThrow(/Can only be performed by the order owner/);

        const closed = simulator.close();
        expect(simulator.currentLedger().state).toBe(0);
        expect(simulator.currentLedger().coins.isEmpty()).toBe(true);
        expect(closed.context.currentZswapLocalState.outputs[0].recipient.left.bytes).toEqual(owner.bytes);
        expect(closed.context.currentZswapLocalState.outputs[0].coinInfo.value).toBe(returnedValue);
        expect(closed.context.currentQueryContext.effects.claimedContractCalls.map((call) => call[2]))
            .toContain(Buffer.from(ammClearOrderCircuitHash).toString("hex"));
        expect(Buffer.from(ammPlaceOrderCircuitHash).length).toBe(32);
    });

    it("requires spam return coins to be merged before close", () => {
        const simulator = new MarketOrderSimulator();
        simulator.openOrder();
        simulator.sendToAmm();
        simulator.receiveFromAmm();
        simulator.receiveFromAmm({ amount: 1n, coinIndex: 1n });

        expect(() => simulator.receiveFromAmm({ amount: 1n, coinIndex: 1n }))
            .toThrow(/Second pos already occupied/);
        expect(() => simulator.close()).toThrow(/Spam coin not merged/);
    });
});
