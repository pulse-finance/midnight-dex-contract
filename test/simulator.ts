import {
    createCircuitContext,
    createConstructorContext,
    emptyZswapLocalState,
    encodeContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import { Contract, ledger } from "../dist/amm/contract/index.js";
import { type Address } from "./addresses";

type CoinInfo = {
    nonce: Uint8Array;
    color: Uint8Array;
    value: bigint;
    mt_index: bigint;
};

type Sender = { bytes: Uint8Array };

const contractAddress = "33".repeat(32);
const defaultSender: Sender = { bytes: new Uint8Array(32).fill(2) };
const defaultRecipient: Address = {
    is_left: true,
    left: defaultSender,
    right: { bytes: new Uint8Array(32) },
};

export class Simulator {
    private contract: Contract;
    private currentContractState: any;
    private currentPrivateState: any;
    private nextNonceId = 1;
    readonly address: string;
    private readonly contractRecipient = {
        is_left: false,
        left: { bytes: new Uint8Array(32) },
        right: { bytes: encodeContractAddress(contractAddress) },
    };
    lpReserves: CoinInfo;
    xReserves: CoinInfo;
    yReserves: CoinInfo;

    constructor(treasury: Address) {
        const fee = 10n;
        const xColor = new Uint8Array(32).fill(9);
        const yColor = new Uint8Array(32).fill(10);

        this.contract = new Contract({});

        const { currentContractState, currentPrivateState } = this.contract.initialState(
            createConstructorContext({}, defaultSender),
            fee,
            treasury,
            defaultSender,
            xColor,
            yColor,
        );

        this.currentContractState = currentContractState;
        this.currentPrivateState = currentPrivateState;
        this.address = contractAddress;

        this.lpReserves = {
            nonce: new Uint8Array(32),
            color: new Uint8Array(32),
            value: 0n,
            mt_index: 0n,
        };

        this.xReserves = {
            nonce: new Uint8Array(32),
            color: xColor,
            value: 0n,
            mt_index: 0n,
        };

        this.yReserves = {
            nonce: new Uint8Array(32),
            color: yColor,
            value: 0n,
            mt_index: 0n,
        };
    }

    getFeeBps(): bigint {
        return this.currentLedger().feeBps;
    }

    getLPCirculatingSupply(): bigint {
        return this.currentLedger().lpCirculatingSupply;
    }

    getXColor(): Uint8Array {
        return this.currentLedger().xColor;
    }

    getXLiquidity(): bigint {
        const { result } = this.contract.circuits.AMM_getX(this.makeContext());

        return result;
    }

    getXRewards(): bigint {
        return this.currentLedger().xRewards;
    }

    getYColor(): Uint8Array {
        return this.currentLedger().yColor;
    }

    getYLiquidity(): bigint {
        const { result } = this.contract.circuits.AMM_getY(this.makeContext());

        return result;
    }

    initLiquidity({ xIn, yIn, lpOut }: { xIn: bigint; yIn: bigint; lpOut?: bigint }) {
        this.runAtomically(() => {
            const userDefinedLPOut = lpOut !== undefined;

            lpOut = lpOut ?? BigInt(Math.round(Math.sqrt(Number(xIn) * Number(yIn))));

            if (!userDefinedLPOut) {
                while (lpOut * lpOut > xIn * yIn) {
                    lpOut -= 1n;
                }
            }

            const nonce = this.makeNonce();
            const { context } = this.contract.circuits.AMM_initLiquidity(
                this.makeContext([
                    this.makeIncomingOutput(this.xReserves.color, xIn, nonce),
                    this.makeIncomingOutput(this.yReserves.color, yIn, nonce),
                ]),
                xIn,
                yIn,
                lpOut,
                defaultRecipient,
                nonce,
            );

            this.commit(context);
        });
    }

    addLiquidity({ xIn, yIn, lpOut }: { xIn: bigint; yIn: bigint; lpOut?: bigint }) {
        this.runAtomically(() => {
            lpOut = lpOut ?? BigInt(Math.round(Math.sqrt(Number(xIn) * Number(yIn))));

            const nonce = this.makeNonce();

            let result = this.contract.circuits.AMM_receiveXY(
                this.makeContext([
                    this.makeIncomingOutput(this.xReserves.color, xIn, nonce),
                    this.makeIncomingOutput(this.yReserves.color, yIn, nonce),
                ]),
                xIn,
                yIn,
                defaultRecipient,
                nonce,
            );
            this.commit(result.context);

            result = this.contract.circuits.AMM_validateXYToLP(this.makeContext(), lpOut, this.makeNonce());
            this.commit(result.context);

            result = this.contract.circuits.AMM_mintLP(this.makeContext(), this.makeNonce());
            this.commit(result.context);

            if (this.currentLedger().coins.member(1n)) {
                result = this.contract.circuits.AMM_mergeX(this.makeContext());
                this.commit(result.context);
            }

            if (this.currentLedger().coins.member(3n)) {
                result = this.contract.circuits.AMM_mergeY(this.makeContext());
                this.commit(result.context);
            }
        });
    }

    removeLiquidity({ lpIn, xOut, yOut }: { lpIn: bigint; xOut: bigint; yOut: bigint }) {
        this.runAtomically(() => {
            const nonce = this.makeNonce();

            let result = this.contract.circuits.AMM_burnLP(
                this.makeContext([this.makeIncomingOutput(this.lpReserves.color, lpIn, nonce)]),
                lpIn,
                defaultRecipient,
                nonce,
            );
            this.commit(result.context);

            result = this.contract.circuits.AMM_validateLPToXY(this.makeContext(), xOut, yOut);
            this.commit(result.context);

            result = this.contract.circuits.AMM_sendX(this.makeContext());
            this.commit(result.context);

            if (this.currentLedger().pendingOrder.is_some) {
                result = this.contract.circuits.AMM_sendY(this.makeContext());
                this.commit(result.context);
            }
        });
    }

    swapXToY({ xIn, xFee, yOut }: { xIn: bigint; xFee?: bigint; yOut?: bigint }) {
        this.runAtomically(() => {
            xFee = xFee ?? this.calcSwapXToYFee(xIn);
            yOut = yOut ?? this.calcSwapXToYOut(xIn, xFee);

            const nonce = this.makeNonce();

            let result = this.contract.circuits.AMM_receiveX(
                this.makeContext([this.makeIncomingOutput(this.xReserves.color, xIn, nonce)]),
                xIn,
                defaultRecipient,
                nonce,
            );
            this.commit(result.context);

            result = this.contract.circuits.AMM_validateXToY(this.makeContext(), xFee, yOut);
            this.commit(result.context);

            result = this.contract.circuits.AMM_sendY(this.makeContext());
            this.commit(result.context);

            if (this.currentLedger().coins.member(1n)) {
                result = this.contract.circuits.AMM_mergeX(this.makeContext());
                this.commit(result.context);
            }
        });
    }

    swapYToX({ yIn, xFee, xOut }: { yIn: bigint; xFee?: bigint; xOut?: bigint }) {
        this.runAtomically(() => {
            xOut = xOut ?? this.calcSwapYToXOut(yIn);
            xFee = xFee ?? this.calcSwapYToXFee(xOut);

            const nonce = this.makeNonce();

            let result = this.contract.circuits.AMM_receiveY(
                this.makeContext([this.makeIncomingOutput(this.yReserves.color, yIn, nonce)]),
                yIn,
                defaultRecipient,
                nonce,
            );
            this.commit(result.context);

            result = this.contract.circuits.AMM_validateYToX(this.makeContext(), xFee, xOut);
            this.commit(result.context);

            result = this.contract.circuits.AMM_sendX(this.makeContext());
            this.commit(result.context);

            if (this.currentLedger().coins.member(3n)) {
                result = this.contract.circuits.AMM_mergeY(this.makeContext());
                this.commit(result.context);
            }
        });
    }

    zapInX({ xIn, xSwap, xFee, ySwap, lpOut }: { xIn: bigint; xSwap: bigint; xFee: bigint; ySwap: bigint; lpOut: bigint }) {
        this.runAtomically(() => {
            const nonce = this.makeNonce();

            let result = this.contract.circuits.AMM_zapInX(
                this.makeContext([this.makeIncomingOutput(this.xReserves.color, xIn, nonce)]),
                xIn,
                defaultRecipient,
                nonce,
            );
            this.commit(result.context);

            result = this.contract.circuits.AMM_validateXToLP(this.makeContext(), xSwap, xFee, ySwap, lpOut);
            this.commit(result.context);

            result = this.contract.circuits.AMM_mintLP(this.makeContext(), this.makeNonce());
            this.commit(result.context);

            if (this.currentLedger().coins.member(1n)) {
                result = this.contract.circuits.AMM_mergeX(this.makeContext());
                this.commit(result.context);
            }
        });
    }

    zapInY({ yIn, ySwap, xFee, xSwap, lpOut }: { yIn: bigint; ySwap: bigint; xFee: bigint; xSwap: bigint; lpOut: bigint }) {
        this.runAtomically(() => {
            const nonce = this.makeNonce();

            let result = this.contract.circuits.AMM_zapInY(
                this.makeContext([this.makeIncomingOutput(this.yReserves.color, yIn, nonce)]),
                yIn,
                defaultRecipient,
                nonce,
            );
            this.commit(result.context);

            result = this.contract.circuits.AMM_validateYToLP(this.makeContext(), ySwap, xFee, xSwap, lpOut);
            this.commit(result.context);

            result = this.contract.circuits.AMM_mintLP(this.makeContext(), this.makeNonce());
            this.commit(result.context);

            if (this.currentLedger().coins.member(3n)) {
                result = this.contract.circuits.AMM_mergeY(this.makeContext());
                this.commit(result.context);
            }
        });
    }

    zapOutX({ lpIn, xOut, ySwap, xFee, xSwap }: { lpIn: bigint; xOut: bigint; ySwap: bigint; xFee: bigint; xSwap: bigint }) {
        this.runAtomically(() => {
            const nonce = this.makeNonce();

            let result = this.contract.circuits.AMM_zapOutX(
                this.makeContext([this.makeIncomingOutput(this.lpReserves.color, lpIn, nonce)]),
                lpIn,
                defaultRecipient,
                nonce,
            );
            this.commit(result.context);

            result = this.contract.circuits.AMM_validateLPToX(this.makeContext(), xOut, ySwap, xFee, xSwap);
            this.commit(result.context);

            result = this.contract.circuits.AMM_sendX(this.makeContext());
            this.commit(result.context);
        });
    }

    zapOutY({ lpIn, yOut, xSwap, xFee, ySwap }: { lpIn: bigint; yOut: bigint; xSwap: bigint; xFee: bigint; ySwap: bigint }) {
        this.runAtomically(() => {
            const nonce = this.makeNonce();

            let result = this.contract.circuits.AMM_zapOutY(
                this.makeContext([this.makeIncomingOutput(this.lpReserves.color, lpIn, nonce)]),
                lpIn,
                defaultRecipient,
                nonce,
            );
            this.commit(result.context);

            result = this.contract.circuits.AMM_validateLPToY(this.makeContext(), yOut, xSwap, xFee, ySwap);
            this.commit(result.context);

            result = this.contract.circuits.AMM_sendY(this.makeContext());
            this.commit(result.context);
        });
    }

    rewardTreasury() {
        const { context } = this.contract.circuits.AMM_reward(this.makeContext());

        this.commit(context);
    }

    private calcSwapXToYFee(xIn: bigint): bigint {
        const feeBps = this.getFeeBps();
        let xFee = BigInt(Math.round((Number(xIn) * Number(feeBps)) / 10000));

        while (xFee * 10000n < feeBps * xIn) {
            xFee += 1n;
        }

        return xFee;
    }

    private calcSwapXToYOut(xIn: bigint, xFee: bigint): bigint {
        const initialK = this.xReserves.value * this.yReserves.value;

        let yOut = this.yReserves.value - BigInt(Math.round(Number(initialK) / Number(this.xReserves.value + xIn - xFee)));

        while (initialK > (this.yReserves.value - yOut) * (this.xReserves.value + xIn - xFee)) {
            yOut -= 1n;
        }

        return yOut;
    }

    private calcSwapYToXFee(xOut: bigint): bigint {
        const feeBps = this.getFeeBps();
        let xFee = BigInt(Math.round((Number(xOut) * Number(feeBps)) / (10000 - Number(feeBps))));

        while (xFee * (10000n - feeBps) < feeBps * xOut) {
            xFee += 1n;
        }

        return xFee;
    }

    private calcSwapYToXOut(yIn: bigint): bigint {
        const initialK = this.xReserves.value * this.yReserves.value;

        let xOutWithoutFee = this.xReserves.value - BigInt(Math.round(Number(initialK) / Number(this.yReserves.value + yIn)));

        while (initialK > (this.xReserves.value - xOutWithoutFee) * (this.yReserves.value + yIn)) {
            xOutWithoutFee -= 1n;
        }

        const xFee = this.calcSwapXToYFee(xOutWithoutFee);

        return xOutWithoutFee - xFee;
    }

    private currentLedger() {
        return ledger(this.currentContractState.data ?? this.currentContractState);
    }

    private makeContext(outputs: Array<{ coinInfo: Omit<CoinInfo, "mt_index">; recipient: Address }> = []) {
        return createCircuitContext(
            this.address,
            {
                ...emptyZswapLocalState(defaultSender),
                outputs,
            },
            this.currentContractState,
            this.currentPrivateState,
        );
    }

    private makeIncomingOutput(color: Uint8Array, value: bigint, nonce: Uint8Array) {
        return {
            coinInfo: {
                nonce,
                color,
                value,
            },
            recipient: this.contractRecipient,
        };
    }

    private makeNonce() {
        const nonce = new Uint8Array(32);
        let value = this.nextNonceId++;

        for (let i = 31; i >= 0 && value > 0; i -= 1) {
            nonce[i] = value & 0xff;
            value >>= 8;
        }

        return nonce;
    }

    private commit(context: ReturnType<typeof createCircuitContext>) {
        this.currentContractState = context.currentQueryContext.state;
        this.currentPrivateState = context.currentPrivateState;
        this.syncReserves(context.currentZswapLocalState.outputs);
    }

    private runAtomically(callback: () => void) {
        const snapshot = {
            currentContractState: this.currentContractState,
            currentPrivateState: this.currentPrivateState,
            nextNonceId: this.nextNonceId,
            lpReserves: this.lpReserves,
            xReserves: this.xReserves,
            yReserves: this.yReserves,
        };

        try {
            callback();
        } catch (error) {
            this.currentContractState = snapshot.currentContractState;
            this.currentPrivateState = snapshot.currentPrivateState;
            this.nextNonceId = snapshot.nextNonceId;
            this.lpReserves = snapshot.lpReserves;
            this.xReserves = snapshot.xReserves;
            this.yReserves = snapshot.yReserves;
            throw error;
        }
    }

    private syncReserves(outputs: Array<{ coinInfo: Omit<CoinInfo, "mt_index">; recipient: Address }>) {
        const currentLedger = this.currentLedger();

        if (currentLedger.coins.member(0n)) {
            this.xReserves = currentLedger.coins.lookup(0n);
        } else {
            this.xReserves = { ...this.xReserves, value: 0n, mt_index: 0n, nonce: new Uint8Array(32) };
        }

        if (currentLedger.coins.member(2n)) {
            this.yReserves = currentLedger.coins.lookup(2n);
        } else {
            this.yReserves = { ...this.yReserves, value: 0n, mt_index: 0n, nonce: new Uint8Array(32) };
        }

        const mintedLP = outputs.find((output) => {
            return (
                output.recipient.is_left &&
                output.recipient.left.bytes.every((byte, index) => byte === defaultRecipient.left.bytes[index]) &&
                !this.sameBytes(output.coinInfo.color, this.xReserves.color) &&
                !this.sameBytes(output.coinInfo.color, this.yReserves.color)
            );
        });

        if (mintedLP) {
            this.lpReserves = {
                ...mintedLP.coinInfo,
                mt_index: 0n,
            };
        }
    }

    private sameBytes(left: Uint8Array, right: Uint8Array) {
        return left.length === right.length && left.every((byte, index) => byte === right[index]);
    }
}
