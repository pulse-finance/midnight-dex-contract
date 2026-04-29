import { describe, expect, it } from "bun:test";
import {
    burnLpAmmCircuit,
    burnLpAmmContractAddress,
    burnLpAmmTickCircuitHash,
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
    it("rejects empty-slot actions, duplicate opens, and a third AMM return coin", () => {
        const simulator = new BurnLpOrderSimulator();

        expect(() => simulator.sendToAmm()).toThrow(/BurnLpOrder slot is empty/);
        expect(() => simulator.close()).toThrow(/BurnLpOrder slot is empty/);

        simulator.openOrder();

        expect(() => simulator.openOrder()).toThrow(/BurnLpOrder slot already occupied/);
    });

    it("rejects AMM return coins when no order is active", () => {
        const simulator = new BurnLpOrderSimulator();

        expect(() => simulator.receiveXFromAmm({ amount: 10n }))
            .toThrow(/BurnLpOrder slot is empty/);
    });

    it("rejects AMM return coins before the order has been sent and rejects unexpected return kinds", () => {
        const simulator = new BurnLpOrderSimulator();
        simulator.openOrder();

        expect(() => simulator.receiveXFromAmm())
            .toThrow(/BurnLpOrder has not been sent to AMM/);

        simulator.sendToAmm();

        expect(() => simulator.receiveUnexpectedFromAmm())
            .toThrow(/Unexpected return kind/);
    });

    it("opens one order with an LP coin and only the owner secret can close it", () => {
        const simulator = new BurnLpOrderSimulator();
        simulator.openOrder();

        const openedLedger = simulator.currentLedger();
        expect(openedLedger.slot.is_some).toBe(true);
        expect(openedLedger.slot.value.ownerCommitment).toEqual(simulator.ownerCommitment());
        expect(openedLedger.slot.value.amountSent).toBe(burnLpValue);
        expect(openedLedger.slot.value.calls.address.bytes).toEqual(encodedBurnLpAmmContractAddress.bytes);
        expect(openedLedger.slot.value.calls.hash).toEqual(burnLpAmmCircuit.hash);
        expect(openedLedger.slot.value.returnsTo.bytes).toEqual(burnLpOwner.bytes);
        expect(openedLedger.slot.value.xColorReturned).toEqual(burnLpXReturnColor);
        expect(openedLedger.slot.value.yColorReturned).toEqual(burnLpYReturnColor);
        expect(openedLedger.coins.member(0n)).toBe(true);
        expect(openedLedger.coins.lookup(0n).value).toBe(burnLpValue);
        expect(openedLedger.coins.lookup(0n).color).toEqual(burnLpColor);

        expect(() => simulator.close({ sender: burnLpOtherUser, secret: burnLpOtherSecret }))
            .toThrow(/Can only be performed by the order owner/);

        const closed = simulator.close();
        expect(simulator.currentLedger().slot.is_some).toBe(false);
        expect(simulator.currentLedger().coins.isEmpty()).toBe(true);
        expect(closed.context.currentZswapLocalState.outputs).toHaveLength(1);
        expect(closed.context.currentZswapLocalState.outputs[0].recipient.left.bytes)
            .toEqual(burnLpOwner.bytes);
        expect(closed.context.currentZswapLocalState.outputs[0].coinInfo.value).toBe(burnLpValue);
    });

    it("sends the stored LP coin to the AMM and records the contract call", () => {
        const simulator = new BurnLpOrderSimulator();
        simulator.openOrder();

        const sent = simulator.sendToAmm();
        expect(simulator.currentLedger().slot.is_some).toBe(true);
        expect(simulator.currentLedger().coins.isEmpty()).toBe(true);
        expect(sent.context.currentZswapLocalState.outputs).toHaveLength(1);
        expect(sent.context.currentZswapLocalState.outputs[0].recipient.is_left).toBe(false);
        expect(sent.context.currentZswapLocalState.outputs[0].recipient.right.bytes)
            .toEqual(encodedBurnLpAmmContractAddress.bytes);
        expect(sent.context.currentZswapLocalState.outputs[0].coinInfo.value).toBe(burnLpValue);
        expect(sent.context.currentQueryContext.effects.claimedContractCalls).toHaveLength(2);
        const claimedHashes = sent.context.currentQueryContext.effects.claimedContractCalls.map((call) => call[2]);
        expect(sent.context.currentQueryContext.effects.claimedContractCalls.every((call) => call[1] === burnLpAmmContractAddress))
            .toBe(true);
        expect(claimedHashes).toContain(Buffer.from(burnLpAmmCircuit.hash).toString("hex"));
        expect(claimedHashes).toContain(Buffer.from(burnLpAmmTickCircuitHash).toString("hex"));
    });

    it("receives X and Y return coins and closes them to the owner", () => {
        const simulator = new BurnLpOrderSimulator();
        simulator.openOrder();
        simulator.sendToAmm();

        simulator.receiveXFromAmm();
        let receivedLedger = simulator.currentLedger();
        expect(receivedLedger.slot.is_some).toBe(true);
        expect(receivedLedger.coins.member(0n)).toBe(true);
        expect(receivedLedger.coins.lookup(0n).value).toBe(burnLpXReturnedValue);
        expect(receivedLedger.coins.lookup(0n).color).toEqual(burnLpXReturnColor);

        simulator.receiveYFromAmm();
        receivedLedger = simulator.currentLedger();
        expect(receivedLedger.coins.member(1n)).toBe(true);
        expect(receivedLedger.coins.lookup(1n).value).toBe(burnLpYReturnedValue);
        expect(receivedLedger.coins.lookup(1n).color).toEqual(burnLpYReturnColor);

        const closed = simulator.close();
        expect(simulator.currentLedger().slot.is_some).toBe(false);
        expect(simulator.currentLedger().coins.isEmpty()).toBe(true);
        expect(closed.context.currentZswapLocalState.outputs).toHaveLength(2);
        expect(closed.context.currentZswapLocalState.outputs[0].recipient.left.bytes)
            .toEqual(burnLpOwner.bytes);
        expect(closed.context.currentZswapLocalState.outputs[0].coinInfo.value).toBe(burnLpXReturnedValue);
        expect(closed.context.currentZswapLocalState.outputs[1].coinInfo.value).toBe(burnLpYReturnedValue);
    });

    it("does not close a sent order until the AMM tick has advanced", () => {
        const simulator = new BurnLpOrderSimulator();
        simulator.openOrder();
        simulator.sendToAmm({ ammTick: 3n });
        simulator.receiveXFromAmm();

        expect(() => simulator.close({ ammTick: 3n })).toThrow(/AMM process not complete/);

        const closed = simulator.close({ ammTick: 4n });
        expect(closed.context.currentZswapLocalState.outputs[0].coinInfo.value).toBe(burnLpXReturnedValue);
    });
});
