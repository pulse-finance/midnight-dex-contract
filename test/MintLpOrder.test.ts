import { describe, expect, it } from "bun:test";
import {
    encodedMintLpAmmContractAddress,
    mintLpAmmTickCircuitHash,
    mintLpAmmCircuit,
    mintLpAmmContractAddress,
    mintLpOtherSecret,
    mintLpOtherUser,
    mintLpOwner,
    mintLpReturnColor,
    mintLpReturnedValue,
    MintLpOrderSimulator,
    mintLpXColor,
    mintLpXValue,
    mintLpYColor,
    mintLpYValue,
} from "./MintLpOrderSimulator";

describe("MintLpOrder", () => {
    it("rejects empty-slot actions, duplicate opens, and occupied return slots", () => {
        const simulator = new MintLpOrderSimulator();

        expect(() => simulator.sendToAmm()).toThrow(/MintLpOrder slot is empty/);
        expect(() => simulator.close()).toThrow(/MintLpOrder slot is empty/);

        simulator.openOrder();

        expect(() => simulator.openOrder()).toThrow(/MintLpOrder slot already occupied/);
    });

    it("rejects AMM return coins when no order is active", () => {
        const simulator = new MintLpOrderSimulator();

        expect(() => simulator.receiveFromAmm({ amount: 10n }))
            .toThrow(/MintLpOrder slot is empty/);
    });

    it("opens one order with X and Y coins and only the owner secret can close it", () => {
        const simulator = new MintLpOrderSimulator();
        simulator.openOrder();

        const openedLedger = simulator.currentLedger();
        expect(openedLedger.slot.is_some).toBe(true);
        expect(openedLedger.slot.value.ownerCommitment).toEqual(simulator.ownerCommitment());
        expect(openedLedger.slot.value.xAmountSent).toBe(mintLpXValue);
        expect(openedLedger.slot.value.yAmountSent).toBe(mintLpYValue);
        expect(openedLedger.slot.value.calls.address.bytes).toEqual(encodedMintLpAmmContractAddress.bytes);
        expect(openedLedger.slot.value.calls.hash).toEqual(mintLpAmmCircuit.hash);
        expect(openedLedger.slot.value.returnsTo.bytes).toEqual(mintLpOwner.bytes);
        expect(openedLedger.slot.value.colorReturned).toEqual(mintLpReturnColor);
        expect(openedLedger.coins.member(0n)).toBe(true);
        expect(openedLedger.coins.member(1n)).toBe(true);
        expect(openedLedger.coins.lookup(0n).value).toBe(mintLpXValue);
        expect(openedLedger.coins.lookup(0n).color).toEqual(mintLpXColor);
        expect(openedLedger.coins.lookup(1n).value).toBe(mintLpYValue);
        expect(openedLedger.coins.lookup(1n).color).toEqual(mintLpYColor);

        expect(() => simulator.close({ sender: mintLpOtherUser, secret: mintLpOtherSecret }))
            .toThrow(/Can only be performed by the order owner/);

        const closed = simulator.close();
        expect(simulator.currentLedger().slot.is_some).toBe(false);
        expect(simulator.currentLedger().coins.isEmpty()).toBe(true);
        expect(closed.context.currentZswapLocalState.outputs).toHaveLength(2);
        expect(closed.context.currentZswapLocalState.outputs[0].recipient.left.bytes)
            .toEqual(mintLpOwner.bytes);
        expect(closed.context.currentZswapLocalState.outputs[0].coinInfo.value).toBe(mintLpXValue);
        expect(closed.context.currentZswapLocalState.outputs[1].coinInfo.value).toBe(mintLpYValue);
    });

    it("sends both stored coins to the AMM and records the contract call", () => {
        const simulator = new MintLpOrderSimulator();
        simulator.openOrder();

        const sent = simulator.sendToAmm();
        expect(simulator.currentLedger().slot.is_some).toBe(true);
        expect(simulator.currentLedger().coins.isEmpty()).toBe(true);
        expect(sent.context.currentZswapLocalState.outputs).toHaveLength(2);
        expect(sent.context.currentZswapLocalState.outputs[0].recipient.is_left).toBe(false);
        expect(sent.context.currentZswapLocalState.outputs[0].recipient.right.bytes)
            .toEqual(encodedMintLpAmmContractAddress.bytes);
        expect(sent.context.currentZswapLocalState.outputs[0].coinInfo.value).toBe(mintLpXValue);
        expect(sent.context.currentZswapLocalState.outputs[1].recipient.right.bytes)
            .toEqual(encodedMintLpAmmContractAddress.bytes);
        expect(sent.context.currentZswapLocalState.outputs[1].coinInfo.value).toBe(mintLpYValue);
        expect(sent.context.currentQueryContext.effects.claimedContractCalls).toHaveLength(2);
        const claimedHashes = sent.context.currentQueryContext.effects.claimedContractCalls.map((call) => call[2]);
        expect(sent.context.currentQueryContext.effects.claimedContractCalls.every((call) => call[1] === mintLpAmmContractAddress))
            .toBe(true);
        expect(claimedHashes).toContain(Buffer.from(mintLpAmmCircuit.hash).toString("hex"));
        expect(claimedHashes).toContain(Buffer.from(mintLpAmmTickCircuitHash).toString("hex"));
    });

    it("receives the minted LP coin and closes it to the owner", () => {
        const simulator = new MintLpOrderSimulator();
        simulator.openOrder();
        simulator.sendToAmm();

        simulator.receiveFromAmm();

        const receivedLedger = simulator.currentLedger();
        expect(receivedLedger.slot.is_some).toBe(true);
        expect(receivedLedger.coins.member(0n)).toBe(true);
        expect(receivedLedger.coins.lookup(0n).value).toBe(mintLpReturnedValue);
        expect(receivedLedger.coins.lookup(0n).color).toEqual(mintLpReturnColor);

        const closed = simulator.close();
        expect(simulator.currentLedger().slot.is_some).toBe(false);
        expect(simulator.currentLedger().coins.isEmpty()).toBe(true);
        expect(closed.context.currentZswapLocalState.outputs).toHaveLength(1);
        expect(closed.context.currentZswapLocalState.outputs[0].recipient.left.bytes)
            .toEqual(mintLpOwner.bytes);
        expect(closed.context.currentZswapLocalState.outputs[0].coinInfo.value).toBe(mintLpReturnedValue);
    });

    it("does not close a sent order until the AMM tick has advanced", () => {
        const simulator = new MintLpOrderSimulator();
        simulator.openOrder();
        simulator.sendToAmm({ ammTick: 3n });
        simulator.receiveFromAmm();

        expect(() => simulator.close({ ammTick: 3n })).toThrow(/AMM process not complete/);

        const closed = simulator.close({ ammTick: 4n });
        expect(closed.context.currentZswapLocalState.outputs[0].coinInfo.value).toBe(mintLpReturnedValue);
    });
});
