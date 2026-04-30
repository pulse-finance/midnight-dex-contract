import {
    createCircuitContext,
    createConstructorContext,
    encodeCoinPublicKey,
    encodeContractAddress,
    emptyZswapLocalState,
    entryPointHash,
} from "@midnight-ntwrk/compact-runtime";
import { Contract, ledger, type Witnesses } from "../../dist/mintlporder/contract/index.js";

type CoinInfo = {
    nonce: Uint8Array;
    color: Uint8Array;
    value: bigint;
};

type Sender = { bytes: Uint8Array };

export const mintLpOwnerPublicKey = "11".repeat(32);
export const mintLpOtherUserPublicKey = "22".repeat(32);
export const mintLpContractAddress = "55".repeat(32);
export const mintLpAmmContractAddress = "44".repeat(32);

export const mintLpOwner = { bytes: encodeCoinPublicKey(mintLpOwnerPublicKey) };
export const mintLpOtherUser = { bytes: encodeCoinPublicKey(mintLpOtherUserPublicKey) };
export const encodedMintLpContractAddress = { bytes: encodeContractAddress(mintLpContractAddress) };
export const encodedMintLpAmmContractAddress = { bytes: encodeContractAddress(mintLpAmmContractAddress) };
export const mintLpOwnerSecret = new Uint8Array(32).fill(5);
export const mintLpOtherSecret = new Uint8Array(32).fill(6);
export const mintLpReceiveCircuitHash = mintLpHashBytes("MintLpOrderReceiveFromAmm");
export const mintLpAmmTickCircuitHash = mintLpHashBytes("AmmTick");
export const mintLpAmmCircuit = {
    address: encodedMintLpAmmContractAddress,
    hash: mintLpHashBytes("AmmDepositXYLiq"),
};
export const mintLpXColor = new Uint8Array(32).fill(8);
export const mintLpYColor = new Uint8Array(32).fill(9);
export const mintLpReturnColor = new Uint8Array(32).fill(10);
export const mintLpNonce = new Uint8Array(32).fill(11);
export const mintLpReturnedNonce = new Uint8Array(32).fill(12);
export const mintLpXValue = 123n;
export const mintLpYValue = 456n;
export const mintLpReturnedValue = 77n;
export const mintLpCallOpening = 13n;
export const mintLpTickCallOpening = 14n;

export function mintLpHashBytes(circuitName: string) {
    return Uint8Array.from(Buffer.from(entryPointHash(circuitName), "hex"));
}

export class MintLpOrderSimulator {
    readonly contract: Contract;
    private currentContractState: any;
    private currentPrivateState: any;
    private nextCoinIndex = 0n;
    private nextCoinColor: Uint8Array = mintLpReturnColor;

    constructor(secret = mintLpOwnerSecret) {
        this.contract = new Contract({
            ownerSecret: (context: Parameters<Witnesses<any>["ownerSecret"]>[0]) => [context.privateState, secret],
            coinIndex: (context: { privateState: any }) => [context.privateState, this.nextCoinIndex],
            coinColor: (context: { privateState: any }) => [context.privateState, this.nextCoinColor],
        });

        const { currentContractState, currentPrivateState } = this.contract.initialState(
            createConstructorContext({}, mintLpOwner),
            mintLpReceiveCircuitHash,
            mintLpAmmTickCircuitHash,
        );

        this.currentContractState = currentContractState;
        this.currentPrivateState = currentPrivateState;
    }

    static makeContract(secret = mintLpOwnerSecret) {
        return new Contract({
            ownerSecret: (context: Parameters<Witnesses<any>["ownerSecret"]>[0]) => [context.privateState, secret],
            coinIndex: (context: { privateState: any }) => [context.privateState, 0n],
            coinColor: (context: { privateState: any }) => [context.privateState, mintLpReturnColor],
        });
    }

    ownerCommitment() {
        return (this.contract as Contract & {
            _persistentHash_1(value: [Uint8Array, Uint8Array]): Uint8Array;
        })._persistentHash_1([
            encodeContractAddress(mintLpContractAddress),
            mintLpOwnerSecret,
        ]);
    }

    currentLedger() {
        return ledger(this.currentContractState.data ?? this.currentContractState);
    }

    openOrder({
        xAmount = mintLpXValue,
        xColor = mintLpXColor,
        yAmount = mintLpYValue,
        yColor = mintLpYColor,
        calls = mintLpAmmCircuit,
        returnsTo = mintLpOwner,
        colorReturned = mintLpReturnColor,
        nonce = mintLpNonce,
        sender = mintLpOwner,
    } = {}) {
        const result = this.contract.circuits.MintLpOrderOpen(
            this.makeContext(sender, [
                this.makeIncomingCoin(xColor, xAmount, nonce),
                this.makeIncomingCoin(yColor, yAmount, nonce),
            ]),
            this.ownerCommitment(),
            xAmount,
            xColor,
            yAmount,
            yColor,
            calls,
            returnsTo,
            colorReturned,
            nonce,
        );

        this.commit(result.context);
        return result;
    }

    sendToAmm({ sender = mintLpOtherUser, calleeRnd = mintLpCallOpening, ammTick = 0n, ammTickRnd = mintLpTickCallOpening } = {}) {
        const result = this.contract.circuits.MintLpOrderSendToAmm(
            this.makeContext(sender),
            calleeRnd,
            ammTick,
            ammTickRnd,
        );

        this.commit(result.context);
        return result;
    }

    receiveFromAmm({
        amount = mintLpReturnedValue,
        color = mintLpReturnColor,
        nonce = mintLpReturnedNonce,
        sender = mintLpOtherUser,
        returnKind = 2n,
        coinIndex = 0n,
    } = {}) {
        this.nextCoinIndex = coinIndex;
        this.nextCoinColor = color;

        const result = this.contract.circuits.MintLpOrderReceiveFromAmm(
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

    close({ sender = mintLpOwner, secret = mintLpOwnerSecret, ammTick = 1n, ammTickRnd = mintLpTickCallOpening } = {}) {
        const contract = secret === mintLpOwnerSecret
            ? this.contract
            : MintLpOrderSimulator.makeContract(secret);
        const result = contract.circuits.MintLpOrderClose(this.makeContext(sender), ammTick, ammTickRnd);

        this.commit(result.context);
        return result;
    }

    private makeContext(sender: Sender, outputs: Array<{ coinInfo: CoinInfo; recipient: any }> = []) {
        return createCircuitContext(
            mintLpContractAddress,
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
                right: encodedMintLpContractAddress,
            },
        };
    }

    private commit(context: ReturnType<typeof createCircuitContext>) {
        this.currentContractState = context.currentQueryContext.state;
        this.currentPrivateState = context.currentPrivateState;
    }
}
