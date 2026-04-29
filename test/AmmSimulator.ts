import {
    createCircuitContext,
    createConstructorContext,
    emptyZswapLocalState,
    encodeContractAddress,
    entryPointHash,
} from "@midnight-ntwrk/compact-runtime";
import { Contract, ledger } from "../dist/amm/contract/index.js";
import { type Address } from "./addresses.js";

type CoinInfo = {
    nonce: Uint8Array;
    color: Uint8Array;
    value: bigint;
    mt_index: bigint;
};

type Sender = { bytes: Uint8Array };

const contractAddress = "33".repeat(32);
const defaultSender: Sender = { bytes: new Uint8Array(32).fill(2) };
const batcherSecret = new Uint8Array(32).fill(4);
const returnContractAddress = "44".repeat(32);
const defaultReturnCircuit = {
    address: { bytes: encodeContractAddress(returnContractAddress) },
    hash: Uint8Array.from(Buffer.from(entryPointHash("return"), "hex")),
};
const defaultRecipient: Address = {
    is_left: true,
    left: defaultSender,
    right: { bytes: new Uint8Array(32) },
};

export class AmmSimulator {
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

    constructor(treasury: Address, { fee = 10n, secret = batcherSecret }: { fee?: bigint; secret?: Uint8Array } = {}) {
        const xColor = new Uint8Array(32).fill(9);
        const yColor = new Uint8Array(32).fill(10);

        this.contract = AmmSimulator.makeContract(secret as Uint8Array<ArrayBuffer>);

        const { currentContractState, currentPrivateState } = this.contract.initialState(
            createConstructorContext({}, defaultSender),
            fee,
            treasury,
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

    static makeContract(secret = batcherSecret) {
        return new Contract({
            batcherSecret: (context) => [context.privateState, secret],
        });
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
        const { xLiquidity } = this.currentLedger();
        this.contract.circuits.AmmXLiq(this.makeContext(), xLiquidity);

        return xLiquidity;
    }

    getXRewards(): bigint {
        return this.currentLedger().xRewards;
    }

    getYColor(): Uint8Array {
        return this.currentLedger().yColor;
    }

    getYLiquidity(): bigint {
        const { yLiquidity } = this.currentLedger();
        this.contract.circuits.AmmYLiq(this.makeContext(), yLiquidity);

        return yLiquidity;
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
            const { context } = this.contract.circuits.AmmInitXYLiq(
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

            let result = this.contract.circuits.AmmDepositXYLiq(
                this.makeContext([
                    this.makeIncomingOutput(this.xReserves.color, xIn, nonce),
                    this.makeIncomingOutput(this.yReserves.color, yIn, nonce),
                ]),
                xIn,
                yIn,
                nonce,
                nonce,
                defaultReturnCircuit,
            );
            this.commit(result.context);

            result = this.contract.circuits.AmmValidateDepositXYLiq(this.makeContext(), lpOut, this.makeNonce());
            this.commit(result.context);

            result = this.contract.circuits.AmmMintLp(this.makeContext(), this.makeNonce(), 0n);
            this.commit(result.context);

            if (this.currentLedger().coins.member(1n)) {
                result = this.contract.circuits.AmmMergeXLiq(this.makeContext());
                this.commit(result.context);
            }

            if (this.currentLedger().coins.member(3n)) {
                result = this.contract.circuits.AmmMergeYLiq(this.makeContext());
                this.commit(result.context);
            }
        });
    }

    removeLiquidity({ lpIn, xOut, yOut }: { lpIn: bigint; xOut: bigint; yOut: bigint }) {
        this.runAtomically(() => {
            const nonce = this.makeNonce();

            let result = this.contract.circuits.AmmWithdrawXYLiq(
                this.makeContext([this.makeIncomingOutput(this.lpReserves.color, lpIn, nonce)]),
                lpIn,
                nonce,
                defaultReturnCircuit,
            );
            this.commit(result.context);

            result = this.contract.circuits.AmmValidateWithdrawXYLiq(this.makeContext(), xOut, yOut);
            this.commit(result.context);

            result = this.contract.circuits.AmmSendX(this.makeContext(), 0n);
            this.commit(result.context);

            if (this.currentLedger().slot.is_some) {
                result = this.contract.circuits.AmmSendY(this.makeContext(), 0n);
                this.commit(result.context);
            }
        });
    }

    swapXToY({ xIn, xFee, yOut }: { xIn: bigint; xFee?: bigint; yOut?: bigint }) {
        this.runAtomically(() => {
            xFee = xFee ?? this.calcSwapXToYFee(xIn);
            yOut = yOut ?? this.calcSwapXToYOut(xIn, xFee);

            const nonce = this.makeNonce();

            let result = this.contract.circuits.AmmSwapXToY(
                this.makeContext([this.makeIncomingOutput(this.xReserves.color, xIn, nonce)]),
                xIn,
                nonce,
                defaultReturnCircuit,
            );
            this.commit(result.context);

            result = this.contract.circuits.AmmValidateSwapXToY(this.makeContext(), xFee, yOut);
            this.commit(result.context);

            result = this.contract.circuits.AmmSendY(this.makeContext(), 0n);
            this.commit(result.context);

            if (this.currentLedger().coins.member(1n)) {
                result = this.contract.circuits.AmmMergeXLiq(this.makeContext());
                this.commit(result.context);
            }
        });
    }

    swapYToX({ yIn, xFee, xOut }: { yIn: bigint; xFee?: bigint; xOut?: bigint }) {
        this.runAtomically(() => {
            xOut = xOut ?? this.calcSwapYToXOut(yIn);
            xFee = xFee ?? this.calcSwapYToXFee(xOut);

            const nonce = this.makeNonce();

            let result = this.contract.circuits.AmmSwapYToX(
                this.makeContext([this.makeIncomingOutput(this.yReserves.color, yIn, nonce)]),
                yIn,
                nonce,
                defaultReturnCircuit,
            );
            this.commit(result.context);

            result = this.contract.circuits.AmmValidateSwapYToX(this.makeContext(), xFee, xOut);
            this.commit(result.context);

            result = this.contract.circuits.AmmSendX(this.makeContext(), 0n);
            this.commit(result.context);

            if (this.currentLedger().coins.member(3n)) {
                result = this.contract.circuits.AmmMergeYLiq(this.makeContext());
                this.commit(result.context);
            }
        });
    }

    zapInX({ xIn, xSwap, xFee, ySwap, lpOut }: { xIn: bigint; xSwap: bigint; xFee: bigint; ySwap: bigint; lpOut: bigint }) {
        this.runAtomically(() => {
            const nonce = this.makeNonce();

            let result = this.contract.circuits.AmmDepositXLiq(
                this.makeContext([this.makeIncomingOutput(this.xReserves.color, xIn, nonce)]),
                xIn,
                nonce,
                defaultReturnCircuit,
            );
            this.commit(result.context);

            result = this.contract.circuits.AmmValidateDepositXLiq(this.makeContext(), xSwap, xFee, ySwap, lpOut);
            this.commit(result.context);

            result = this.contract.circuits.AmmMintLp(this.makeContext(), this.makeNonce(), 0n);
            this.commit(result.context);

            if (this.currentLedger().coins.member(1n)) {
                result = this.contract.circuits.AmmMergeXLiq(this.makeContext());
                this.commit(result.context);
            }
        });
    }

    zapInY({ yIn, ySwap, xFee, xSwap, lpOut }: { yIn: bigint; ySwap: bigint; xFee: bigint; xSwap: bigint; lpOut: bigint }) {
        this.runAtomically(() => {
            const nonce = this.makeNonce();

            let result = this.contract.circuits.AmmDepositYLiq(
                this.makeContext([this.makeIncomingOutput(this.yReserves.color, yIn, nonce)]),
                yIn,
                nonce,
                defaultReturnCircuit,
            );
            this.commit(result.context);

            result = this.contract.circuits.AmmValidateDepositYLiq(this.makeContext(), ySwap, xFee, xSwap, lpOut);
            this.commit(result.context);

            result = this.contract.circuits.AmmMintLp(this.makeContext(), this.makeNonce(), 0n);
            this.commit(result.context);

            if (this.currentLedger().coins.member(3n)) {
                result = this.contract.circuits.AmmMergeYLiq(this.makeContext());
                this.commit(result.context);
            }
        });
    }

    zapOutX({ lpIn, xOut, ySwap, xFee, xSwap }: { lpIn: bigint; xOut: bigint; ySwap: bigint; xFee: bigint; xSwap: bigint }) {
        this.runAtomically(() => {
            const nonce = this.makeNonce();

            let result = this.contract.circuits.AmmWithdrawXLiq(
                this.makeContext([this.makeIncomingOutput(this.lpReserves.color, lpIn, nonce)]),
                lpIn,
                nonce,
                defaultReturnCircuit,
            );
            this.commit(result.context);

            result = this.contract.circuits.AmmValidateWithdrawXLiq(this.makeContext(), xOut, ySwap, xFee, xSwap);
            this.commit(result.context);

            result = this.contract.circuits.AmmSendX(this.makeContext(), 0n);
            this.commit(result.context);
        });
    }

    zapOutY({ lpIn, yOut, xSwap, xFee, ySwap }: { lpIn: bigint; yOut: bigint; xSwap: bigint; xFee: bigint; ySwap: bigint }) {
        this.runAtomically(() => {
            const nonce = this.makeNonce();

            let result = this.contract.circuits.AmmWithdrawYLiq(
                this.makeContext([this.makeIncomingOutput(this.lpReserves.color, lpIn, nonce)]),
                lpIn,
                nonce,
                defaultReturnCircuit,
            );
            this.commit(result.context);

            result = this.contract.circuits.AmmValidateWithdrawYLiq(this.makeContext(), yOut, xSwap, xFee, ySwap);
            this.commit(result.context);

            result = this.contract.circuits.AmmSendY(this.makeContext(), 0n);
            this.commit(result.context);
        });
    }

    rewardTreasury() {
        const { context } = this.contract.circuits.AmmReward(this.makeContext());

        this.commit(context);
    }

    update({ fee, treasury, secret = batcherSecret }: { fee: bigint; treasury: Address; secret?: Uint8Array }) {
        const contract = secret === batcherSecret ? this.contract : AmmSimulator.makeContract(secret as Uint8Array<ArrayBuffer>);
        const { context } = contract.circuits.AmmUpdate(this.makeContext(), fee, treasury);

        this.commit(context);
    }

    startDepositXY({ xIn, yIn }: { xIn: bigint; yIn: bigint }) {
        const xNonce = this.makeNonce();
        const yNonce = this.makeNonce();
        const { context } = this.contract.circuits.AmmDepositXYLiq(
            this.makeContext([
                this.makeIncomingOutput(this.xReserves.color, xIn, xNonce),
                this.makeIncomingOutput(this.yReserves.color, yIn, yNonce),
            ]),
            xIn,
            yIn,
            xNonce,
            yNonce,
            defaultReturnCircuit,
        );

        this.commit(context);
    }

    startDepositX({ xIn }: { xIn: bigint }) {
        const nonce = this.makeNonce();
        const { context } = this.contract.circuits.AmmDepositXLiq(
            this.makeContext([this.makeIncomingOutput(this.xReserves.color, xIn, nonce)]),
            xIn,
            nonce,
            defaultReturnCircuit,
        );

        this.commit(context);
    }

    startDepositY({ yIn }: { yIn: bigint }) {
        const nonce = this.makeNonce();
        const { context } = this.contract.circuits.AmmDepositYLiq(
            this.makeContext([this.makeIncomingOutput(this.yReserves.color, yIn, nonce)]),
            yIn,
            nonce,
            defaultReturnCircuit,
        );

        this.commit(context);
    }

    startSwapXToY({ xIn }: { xIn: bigint }) {
        const nonce = this.makeNonce();
        const { context } = this.contract.circuits.AmmSwapXToY(
            this.makeContext([this.makeIncomingOutput(this.xReserves.color, xIn, nonce)]),
            xIn,
            nonce,
            defaultReturnCircuit,
        );

        this.commit(context);
    }

    startSwapYToX({ yIn }: { yIn: bigint }) {
        const nonce = this.makeNonce();
        const { context } = this.contract.circuits.AmmSwapYToX(
            this.makeContext([this.makeIncomingOutput(this.yReserves.color, yIn, nonce)]),
            yIn,
            nonce,
            defaultReturnCircuit,
        );

        this.commit(context);
    }

    startWithdrawXY({ lpIn }: { lpIn: bigint }) {
        const nonce = this.makeNonce();
        const { context } = this.contract.circuits.AmmWithdrawXYLiq(
            this.makeContext([this.makeIncomingOutput(this.lpReserves.color, lpIn, nonce)]),
            lpIn,
            nonce,
            defaultReturnCircuit,
        );

        this.commit(context);
    }

    startWithdrawX({ lpIn }: { lpIn: bigint }) {
        const nonce = this.makeNonce();
        const { context } = this.contract.circuits.AmmWithdrawXLiq(
            this.makeContext([this.makeIncomingOutput(this.lpReserves.color, lpIn, nonce)]),
            lpIn,
            nonce,
            defaultReturnCircuit,
        );

        this.commit(context);
    }

    startWithdrawY({ lpIn }: { lpIn: bigint }) {
        const nonce = this.makeNonce();
        const { context } = this.contract.circuits.AmmWithdrawYLiq(
            this.makeContext([this.makeIncomingOutput(this.lpReserves.color, lpIn, nonce)]),
            lpIn,
            nonce,
            defaultReturnCircuit,
        );

        this.commit(context);
    }

    validateDepositXY(lpOut: bigint) {
        const { context } = this.contract.circuits.AmmValidateDepositXYLiq(this.makeContext(), lpOut, this.makeNonce());

        this.commit(context);
    }

    validateDepositX({ xSwap, xFee, ySwap, lpOut }: { xSwap: bigint; xFee: bigint; ySwap: bigint; lpOut: bigint }) {
        const { context } = this.contract.circuits.AmmValidateDepositXLiq(this.makeContext(), xSwap, xFee, ySwap, lpOut);

        this.commit(context);
    }

    validateDepositY({ ySwap, xFee, xSwap, lpOut }: { ySwap: bigint; xFee: bigint; xSwap: bigint; lpOut: bigint }) {
        const { context } = this.contract.circuits.AmmValidateDepositYLiq(this.makeContext(), ySwap, xFee, xSwap, lpOut);

        this.commit(context);
    }

    validateSwapXToY({ xFee, yOut }: { xFee: bigint; yOut: bigint }) {
        const { context } = this.contract.circuits.AmmValidateSwapXToY(this.makeContext(), xFee, yOut);

        this.commit(context);
    }

    validateSwapYToX({ xFee, xOut }: { xFee: bigint; xOut: bigint }) {
        const { context } = this.contract.circuits.AmmValidateSwapYToX(this.makeContext(), xFee, xOut);

        this.commit(context);
    }

    validateWithdrawXY({ xOut, yOut }: { xOut: bigint; yOut: bigint }) {
        const { context } = this.contract.circuits.AmmValidateWithdrawXYLiq(this.makeContext(), xOut, yOut);

        this.commit(context);
    }

    validateWithdrawX({ xOut, ySwap, xFee, xSwap }: { xOut: bigint; ySwap: bigint; xFee: bigint; xSwap: bigint }) {
        const { context } = this.contract.circuits.AmmValidateWithdrawXLiq(this.makeContext(), xOut, ySwap, xFee, xSwap);

        this.commit(context);
    }

    validateWithdrawY({ yOut, xSwap, xFee, ySwap }: { yOut: bigint; xSwap: bigint; xFee: bigint; ySwap: bigint }) {
        const { context } = this.contract.circuits.AmmValidateWithdrawYLiq(this.makeContext(), yOut, xSwap, xFee, ySwap);

        this.commit(context);
    }

    mintLp() {
        const { context } = this.contract.circuits.AmmMintLp(this.makeContext(), this.makeNonce(), 0n);

        this.commit(context);
    }

    sendX() {
        const { context } = this.contract.circuits.AmmSendX(this.makeContext(), 0n);

        this.commit(context);
    }

    sendY() {
        const { context } = this.contract.circuits.AmmSendY(this.makeContext(), 0n);

        this.commit(context);
    }

    mergeX() {
        const { context } = this.contract.circuits.AmmMergeXLiq(this.makeContext());

        this.commit(context);
    }

    mergeY() {
        const { context } = this.contract.circuits.AmmMergeYLiq(this.makeContext());

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

    currentLedger() {
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
