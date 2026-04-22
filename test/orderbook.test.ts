import { describe, expect, it } from "bun:test";
import {
    createCircuitContext,
    createConstructorContext,
    encodeCoinPublicKey,
    encodeContractAddress,
    emptyZswapLocalState,
} from "@midnight-ntwrk/compact-runtime";
import { Contract, ledger } from "../dist/orderbook/contract/index.js";

const ownerPublicKey = "11".repeat(32);
const otherUserPublicKey = "22".repeat(32);
const contractAddress = "33".repeat(32);
const ammContractAddress = "44".repeat(32);

const owner = { bytes: encodeCoinPublicKey(ownerPublicKey) };
const otherUser = { bytes: encodeCoinPublicKey(otherUserPublicKey) };
const encodedContractAddress = { bytes: encodeContractAddress(contractAddress) };
const ammContract = { bytes: encodeContractAddress(ammContractAddress) };
const shieldedRecipient = {
    is_left: true,
    left: { bytes: encodeCoinPublicKey("55".repeat(32)) },
    right: { bytes: new Uint8Array(32) },
};
const circuitName = new Uint8Array(32).fill(6);
const ammNonce = new Uint8Array(32).fill(7);
const coinColor = new Uint8Array(32).fill(8);
const coinNonce = new Uint8Array(32).fill(9);
const coinValue = 123n;

function withIncomingCoin(sender: { bytes: Uint8Array }) {
    const zswapState = emptyZswapLocalState(sender);

    return {
        ...zswapState,
        outputs: [
            {
                coinInfo: {
                    nonce: coinNonce,
                    color: coinColor,
                    value: coinValue,
                },
                recipient: {
                    is_left: false,
                    left: { bytes: new Uint8Array(32) },
                    right: encodedContractAddress,
                },
            },
        ],
    };
}

function nextTx(previousContext: any, sender: { bytes: Uint8Array }) {
    return {
        ...previousContext,
        currentZswapLocalState: emptyZswapLocalState(sender),
    };
}

describe("OrderBook", () => {
    it("stores one order and only lets the owner cancel it", () => {
        const contract = new Contract({});
        const { currentContractState, currentPrivateState } = contract.initialState(
            createConstructorContext({}, owner),
        );

        const placeContext = createCircuitContext(
            contractAddress,
            withIncomingCoin(owner),
            currentContractState,
            currentPrivateState,
        );

        const placed = contract.circuits.placeOrder(
            placeContext,
            owner,
            shieldedRecipient,
            ammContract,
            circuitName,
            11n,
            22n,
            33n,
            ammNonce,
            coinColor,
            coinValue,
            coinNonce,
        );

        const placedLedger = ledger(placed.context.currentQueryContext.state);
        expect(placedLedger.order.is_some).toBe(true);
        expect(placedLedger.order.value.owner.bytes).toEqual(owner.bytes);
        expect(placedLedger.order.value.ammCall.ammContract.bytes).toEqual(ammContract.bytes);
        expect(placedLedger.coins.member(0n)).toBe(true);
        expect(placedLedger.coins.lookup(0n).value).toBe(coinValue);

        expect(() =>
            contract.circuits.cancel(nextTx(placed.context, otherUser)),
        ).toThrow(/Only the order owner can cancel/);

        const cancelled = contract.circuits.cancel(nextTx(placed.context, owner));
        const cancelledLedger = ledger(cancelled.context.currentQueryContext.state);
        expect(cancelledLedger.order.is_some).toBe(false);
        expect(cancelledLedger.coins.isEmpty()).toBe(true);
        expect(cancelled.context.currentZswapLocalState.outputs).toHaveLength(1);
        expect(cancelled.context.currentZswapLocalState.outputs[0].recipient.is_left).toBe(true);
        expect(cancelled.context.currentZswapLocalState.outputs[0].recipient.left.bytes).toEqual(owner.bytes);
        expect(cancelled.context.currentZswapLocalState.outputs[0].coinInfo.value).toBe(coinValue);
    });

    it("fulfills by forwarding the stored coin to the recorded AMM contract", () => {
        const contract = new Contract({});
        const { currentContractState, currentPrivateState } = contract.initialState(
            createConstructorContext({}, owner),
        );

        const placeContext = createCircuitContext(
            contractAddress,
            withIncomingCoin(owner),
            currentContractState,
            currentPrivateState,
        );

        const placed = contract.circuits.placeOrder(
            placeContext,
            owner,
            shieldedRecipient,
            ammContract,
            circuitName,
            44n,
            55n,
            66n,
            ammNonce,
            coinColor,
            coinValue,
            coinNonce,
        );

        const fulfilled = contract.circuits.fulfill(nextTx(placed.context, otherUser));
        const fulfilledLedger = ledger(fulfilled.context.currentQueryContext.state);
        expect(fulfilledLedger.order.is_some).toBe(false);
        expect(fulfilledLedger.coins.isEmpty()).toBe(true);
        expect(fulfilled.context.currentZswapLocalState.outputs).toHaveLength(1);
        expect(fulfilled.context.currentZswapLocalState.outputs[0].recipient.is_left).toBe(false);
        expect(fulfilled.context.currentZswapLocalState.outputs[0].recipient.right.bytes).toEqual(ammContract.bytes);
        expect(fulfilled.context.currentZswapLocalState.outputs[0].coinInfo.value).toBe(coinValue);
    });
});
