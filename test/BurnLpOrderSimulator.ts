import {
    createCircuitContext,
    createConstructorContext,
    encodeCoinPublicKey,
    encodeContractAddress,
    emptyZswapLocalState,
    entryPointHash,
} from "@midnight-ntwrk/compact-runtime";
import { Contract, ledger } from "../dist/burnlporder/contract/index.js";

type CoinInfo = {
    nonce: Uint8Array;
    color: Uint8Array;
    value: bigint;
};

type Sender = { bytes: Uint8Array };

export const burnLpOwnerPublicKey = "11".repeat(32);
export const burnLpOtherUserPublicKey = "22".repeat(32);
export const burnLpContractAddress = "66".repeat(32);
export const burnLpAmmContractAddress = "44".repeat(32);

export const burnLpOwner = { bytes: encodeCoinPublicKey(burnLpOwnerPublicKey) };
export const burnLpOtherUser = { bytes: encodeCoinPublicKey(burnLpOtherUserPublicKey) };
export const encodedBurnLpContractAddress = { bytes: encodeContractAddress(burnLpContractAddress) };
export const encodedBurnLpAmmContractAddress = { bytes: encodeContractAddress(burnLpAmmContractAddress) };
export const burnLpOwnerSecret = new Uint8Array(32).fill(5);
export const burnLpOtherSecret = new Uint8Array(32).fill(6);
export const burnLpReceiveCircuitHash = burnLpHashBytes("BurnLpOrderReceiveFromAmm");
export const burnLpAmmTickCircuitHash = burnLpHashBytes("AmmTick");
export const burnLpAmmCircuit = {
    address: encodedBurnLpAmmContractAddress,
    hash: burnLpHashBytes("AmmWithdrawXYLiq"),
};
export const burnLpColor = new Uint8Array(32).fill(7);
export const burnLpXReturnColor = new Uint8Array(32).fill(8);
export const burnLpYReturnColor = new Uint8Array(32).fill(9);
export const burnLpNonce = new Uint8Array(32).fill(10);
export const burnLpXReturnedNonce = new Uint8Array(32).fill(11);
export const burnLpYReturnedNonce = new Uint8Array(32).fill(12);
export const burnLpValue = 123n;
export const burnLpXReturnedValue = 77n;
export const burnLpYReturnedValue = 88n;
export const burnLpCallOpening = 13n;
export const burnLpTickCallOpening = 14n;

export function burnLpHashBytes(circuitName: string) {
    return Uint8Array.from(Buffer.from(entryPointHash(circuitName), "hex"));
}

export class BurnLpOrderSimulator {
    readonly contract: Contract;
    private currentContractState: any;
    private currentPrivateState: any;
    private nextCoinIndex = 0n;
    private nextCoinColor = burnLpXReturnColor;

    constructor(secret = burnLpOwnerSecret) {
        this.contract = new Contract({
            ownerSecret: (context) => [context.privateState, secret],
            coinIndex: (context) => [context.privateState, this.nextCoinIndex],
            coinColor: (context) => [context.privateState, this.nextCoinColor],
        });

        const { currentContractState, currentPrivateState } = this.contract.initialState(
            createConstructorContext({}, burnLpOwner),
            burnLpReceiveCircuitHash,
            burnLpAmmTickCircuitHash,
        );

        this.currentContractState = currentContractState;
        this.currentPrivateState = currentPrivateState;
    }

    static makeContract(secret = burnLpOwnerSecret) {
        return new Contract({
            ownerSecret: (context) => [context.privateState, secret],
            coinIndex: (context) => [context.privateState, 0n],
            coinColor: (context) => [context.privateState, burnLpXReturnColor],
        });
    }

    ownerCommitment() {
        return this.contract._persistentHash_1([
            encodeContractAddress(burnLpContractAddress),
            burnLpOwnerSecret,
        ]);
    }

    currentLedger() {
        return ledger(this.currentContractState.data ?? this.currentContractState);
    }

    openOrder({
        amount = burnLpValue,
        colorSent = burnLpColor,
        calls = burnLpAmmCircuit,
        returnsTo = burnLpOwner,
        xColorReturned = burnLpXReturnColor,
        yColorReturned = burnLpYReturnColor,
        nonce = burnLpNonce,
        sender = burnLpOwner,
    } = {}) {
        const result = this.contract.circuits.BurnLpOrderOpen(
            this.makeContext(sender, [
                this.makeIncomingCoin(colorSent, amount, nonce),
            ]),
            this.ownerCommitment(),
            amount,
            colorSent,
            calls,
            returnsTo,
            xColorReturned,
            yColorReturned,
            nonce,
        );

        this.commit(result.context);
        return result;
    }

    sendToAmm({ sender = burnLpOtherUser, calleeRnd = burnLpCallOpening, ammTick = 0n, ammTickRnd = burnLpTickCallOpening } = {}) {
        const result = this.contract.circuits.BurnLpOrderSendToAmm(
            this.makeContext(sender),
            calleeRnd,
            ammTick,
            ammTickRnd,
        );

        this.commit(result.context);
        return result;
    }

    receiveXFromAmm({
        amount = burnLpXReturnedValue,
        color = burnLpXReturnColor,
        nonce = burnLpXReturnedNonce,
        sender = burnLpOtherUser,
        coinIndex = 0n,
    } = {}) {
        return this.receiveFromAmm({ amount, color, nonce, sender, returnKind: 0n, coinIndex });
    }

    receiveYFromAmm({
        amount = burnLpYReturnedValue,
        color = burnLpYReturnColor,
        nonce = burnLpYReturnedNonce,
        sender = burnLpOtherUser,
        coinIndex = 1n,
    } = {}) {
        return this.receiveFromAmm({ amount, color, nonce, sender, returnKind: 1n, coinIndex });
    }

    close({ sender = burnLpOwner, secret = burnLpOwnerSecret, ammTick = 1n, ammTickRnd = burnLpTickCallOpening } = {}) {
        const contract = secret === burnLpOwnerSecret
            ? this.contract
            : BurnLpOrderSimulator.makeContract(secret);
        const result = contract.circuits.BurnLpOrderClose(this.makeContext(sender), ammTick, ammTickRnd);

        this.commit(result.context);
        return result;
    }

    private receiveFromAmm({
        amount,
        color,
        nonce,
        sender,
        returnKind,
        coinIndex,
    }: { amount: bigint; color: Uint8Array; nonce: Uint8Array; sender: Sender; returnKind: bigint; coinIndex: bigint }) {
        this.nextCoinIndex = coinIndex;
        this.nextCoinColor = color;

        const result = this.contract.circuits.BurnLpOrderReceiveFromAmm(
            this.makeContext(sender, [
                this.makeIncomingCoin(color, amount, nonce),
            ]),
            returnKind,
            amount,
            nonce,
        );

        this.commit(result.context);
        return result;
    }

    private makeContext(sender: Sender, outputs: Array<{ coinInfo: CoinInfo; recipient: any }> = []) {
        return createCircuitContext(
            burnLpContractAddress,
            {
                ...emptyZswapLocalState(sender),
                outputs,
            },
            this.currentContractState,
            this.currentPrivateState,
        );
    }

    private makeIncomingCoin(color: Uint8Array, value: bigint, nonce: Uint8Array) {
        return {
            coinInfo: {
                nonce,
                color,
                value,
            },
            recipient: {
                is_left: false,
                left: { bytes: new Uint8Array(32) },
                right: encodedBurnLpContractAddress,
            },
        };
    }

    private commit(context: ReturnType<typeof createCircuitContext>) {
        this.currentContractState = context.currentQueryContext.state;
        this.currentPrivateState = context.currentPrivateState;
    }
}
