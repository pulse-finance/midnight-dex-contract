import { describe, expect, it } from "bun:test";
import {
    createCircuitContext,
    createConstructorContext,
    emptyZswapLocalState,
} from "@midnight-ntwrk/compact-runtime";
import { ledger as ammLedger, Contract as AMMContract } from "../../dist/amm/contract/index.js";
import {
    ammContractAddress,
    ammSwapCircuit,
    ammTickCircuitHash,
    callOpening,
    coinColor,
    coinValue,
    encodedAmmContractAddress,
    encodedMarketOrderContractAddress,
    MarketOrderSimulator,
    otherSecret,
    otherUser,
    owner,
    receiveCircuitHash,
    returnColor,
    returnedValue,
} from "./MarketOrderSimulator";

const batcherSecret = new Uint8Array(32).fill(7);

describe("MarketOrder", () => {
    it("rejects empty-slot actions and duplicate opens", () => {
        const simulator = new MarketOrderSimulator();

        expect(() => simulator.sendToAmm()).toThrow(/MarketOrder slot is empty/);
        expect(() => simulator.close()).toThrow(/MarketOrder slot is empty/);

        simulator.openOrder();

        expect(() => simulator.openOrder()).toThrow(/MarketOrder slot already occupied/);
    });

    it("rejects AMM return coins when no order is active", () => {
        const simulator = new MarketOrderSimulator();

        expect(() => simulator.receiveFromAmm({ amount: 10n }))
            .toThrow(/MarketOrder slot is empty/);
    });

    it("rejects AMM return coins before the order has been sent", () => {
        const simulator = new MarketOrderSimulator();
        simulator.openOrder();

        expect(() => simulator.receiveFromAmm())
            .toThrow(/MarketOrder has not been sent to AMM/);

        simulator.sendToAmm();

        simulator.receiveFromAmm();
    });

    it("opens one order and only the owner secret can close it", () => {
        const simulator = new MarketOrderSimulator();
        simulator.openOrder();

        const openedLedger = simulator.currentLedger();
        expect(openedLedger.slot.is_some).toBe(true);
        expect(openedLedger.slot.value.ownerCommitment).toEqual(simulator.ownerCommitment());
        expect(openedLedger.slot.value.returnsTo.bytes).toEqual(owner.bytes);
        expect(openedLedger.slot.value.calls.address.bytes).toEqual(encodedAmmContractAddress.bytes);
        expect(openedLedger.slot.value.calls.hash).toEqual(ammSwapCircuit.hash);
        expect(openedLedger.slot.value.amountSent).toBe(coinValue);
        expect(openedLedger.slot.value.colorReturned).toEqual(returnColor);
        expect(openedLedger.coins.member(0n)).toBe(true);
        expect(openedLedger.coins.lookup(0n).value).toBe(coinValue);

        expect(() => simulator.close({ sender: otherUser, secret: otherSecret }))
            .toThrow(/Can only be performed by the order owner/);

        const closed = simulator.close();
        const closedLedger = simulator.currentLedger();
        expect(closedLedger.slot.is_some).toBe(false);
        expect(closedLedger.coins.isEmpty()).toBe(true);
        expect(closed.context.currentZswapLocalState.outputs).toHaveLength(1);
        expect(closed.context.currentZswapLocalState.outputs[0].recipient.is_left).toBe(true);
        expect(closed.context.currentZswapLocalState.outputs[0].recipient.left.bytes).toEqual(owner.bytes);
        expect(closed.context.currentZswapLocalState.outputs[0].coinInfo.value).toBe(coinValue);
    });

    it("sends the stored coin to the AMM and records the contract call", () => {
        const simulator = new MarketOrderSimulator();
        simulator.openOrder();

        const sent = simulator.sendToAmm();
        const sentLedger = simulator.currentLedger();
        expect(sentLedger.slot.is_some).toBe(true);
        expect(sentLedger.coins.isEmpty()).toBe(true);
        expect(sent.context.currentZswapLocalState.outputs).toHaveLength(1);
        expect(sent.context.currentZswapLocalState.outputs[0].recipient.is_left).toBe(false);
        expect(sent.context.currentZswapLocalState.outputs[0].recipient.right.bytes)
            .toEqual(encodedAmmContractAddress.bytes);
        expect(sent.context.currentZswapLocalState.outputs[0].coinInfo.value).toBe(coinValue);
        expect(sent.context.currentQueryContext.effects.claimedContractCalls).toHaveLength(2);
        const claimedHashes = sent.context.currentQueryContext.effects.claimedContractCalls.map((call) => call[2]);
        expect(sent.context.currentQueryContext.effects.claimedContractCalls.every((call) => call[1] === ammContractAddress))
            .toBe(true);
        expect(claimedHashes).toContain(Buffer.from(ammSwapCircuit.hash).toString("hex"));
        expect(claimedHashes).toContain(Buffer.from(ammTickCircuitHash).toString("hex"));
    });

    it("receives the AMM return coin and closes it to the owner", () => {
        const simulator = new MarketOrderSimulator();
        simulator.openOrder();
        simulator.sendToAmm();

        simulator.receiveFromAmm();

        const receivedLedger = simulator.currentLedger();
        expect(receivedLedger.slot.is_some).toBe(true);
        expect(receivedLedger.coins.member(0n)).toBe(true);
        expect(receivedLedger.coins.lookup(0n).value).toBe(returnedValue);
        expect(receivedLedger.coins.lookup(0n).color).toEqual(returnColor);

        const closed = simulator.close();
        expect(simulator.currentLedger().slot.is_some).toBe(false);
        expect(closed.context.currentZswapLocalState.outputs[0].recipient.left.bytes).toEqual(owner.bytes);
        expect(closed.context.currentZswapLocalState.outputs[0].coinInfo.value).toBe(returnedValue);
    });

    it("does not close a sent order until the AMM tick has advanced", () => {
        const simulator = new MarketOrderSimulator();
        simulator.openOrder();
        simulator.sendToAmm({ ammTick: 3n });
        simulator.receiveFromAmm();

        expect(() => simulator.close({ ammTick: 3n })).toThrow(/AMM process not complete/);

        const closed = simulator.close({ ammTick: 4n });
        expect(closed.context.currentZswapLocalState.outputs[0].coinInfo.value).toBe(returnedValue);
    });

    it("can combine send-to-AMM with an AMM shielded receive using the returned nonce", () => {
        const simulator = new MarketOrderSimulator();
        simulator.openOrder();
        const sent = simulator.sendToAmm({ calleeRnd: callOpening });
        const forwardedCoin = sent.context.currentZswapLocalState.outputs[0].coinInfo;

        const amm = new AMMContract({
            batcherSecret: (context) => [context.privateState, batcherSecret],
        });
        const ammState = amm.initialState(
            createConstructorContext({}, owner),
            10n,
            {
                is_left: true,
                left: owner,
                right: { bytes: new Uint8Array(32) },
            },
            coinColor,
            returnColor,
        );

        const initNonce = new Uint8Array(32).fill(13);
        const initialized = amm.circuits.AmmInitXYLiq(
            createCircuitContext(
                ammContractAddress,
                {
                    ...emptyZswapLocalState(owner),
                    outputs: [
                        {
                            coinInfo: { nonce: initNonce, color: coinColor, value: 1_000n },
                            recipient: {
                                is_left: false,
                                left: { bytes: new Uint8Array(32) },
                                right: encodedAmmContractAddress,
                            },
                        },
                        {
                            coinInfo: { nonce: initNonce, color: returnColor, value: 1_000n },
                            recipient: {
                                is_left: false,
                                left: { bytes: new Uint8Array(32) },
                                right: encodedAmmContractAddress,
                            },
                        },
                    ],
                },
                ammState.currentContractState,
                ammState.currentPrivateState,
            ),
            1_000n,
            1_000n,
            1_000n,
            {
                is_left: true,
                left: owner,
                right: { bytes: new Uint8Array(32) },
            },
            initNonce,
        );

        const swapped = amm.circuits.AmmSwapXToY(
            createCircuitContext(
                ammContractAddress,
                {
                    ...emptyZswapLocalState(otherUser),
                    outputs: sent.context.currentZswapLocalState.outputs,
                },
                initialized.context.currentQueryContext.state,
                initialized.context.currentPrivateState,
            ),
            coinValue,
            forwardedCoin.nonce,
            {
                address: encodedMarketOrderContractAddress,
                hash: receiveCircuitHash,
            },
        );

        const swappedLedger = ammLedger(swapped.context.currentQueryContext.state);
        expect(swappedLedger.slot.is_some).toBe(true);
        expect(swappedLedger.slot.value.kind).toBe(3);
        expect(swappedLedger.slot.value.fstAmount).toBe(coinValue);
        expect(swappedLedger.coins.member(1n)).toBe(true);
        expect(swappedLedger.coins.lookup(1n).nonce).toEqual(forwardedCoin.nonce);
        expect(swappedLedger.coins.lookup(1n).value).toBe(coinValue);
    });

});
