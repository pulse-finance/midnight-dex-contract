import { CircuitContext, constructorContext, emptyZswapLocalState, EncodedCoinInfo, EncodedQualifiedCoinInfo, QueryContext, sampleContractAddress } from "@midnight-ntwrk/compact-runtime"
import { Contract } from "../dist/contract/index.cjs"
import { type Address } from "./addresses"

const dummyTxSender = "0".repeat(64)

export class Simulator {
    private contract: Contract<unknown, {}>;
    readonly address: string;
    private circuitContext: CircuitContext<unknown>
    lpReserves: EncodedQualifiedCoinInfo
    xReserves: EncodedQualifiedCoinInfo
    yReserves: EncodedQualifiedCoinInfo

    constructor(treasury: Address) {
        const fee = 10n
        const xColor = new Uint8Array(32).fill(9)
        const yColor = new Uint8Array(32).fill(10)
        const nonce0 = new Uint8Array(32)

        this.contract = new Contract({})

        const { currentPrivateState, currentContractState, currentZswapLocalState} = this.contract.initialState(
            constructorContext({
                xRewards: 0n,
                xLiquidity: 0n,
                yLiquidity: 0n,
            }, dummyTxSender),
            fee,
            treasury,
            xColor,
            yColor,
            nonce0
        )

        this.address = sampleContractAddress()

        this.circuitContext = {
            currentPrivateState,
            currentZswapLocalState,
            originalState: currentContractState,
            transactionContext: new QueryContext(
                currentContractState.data,
                this.address
            )
        }

        this.lpReserves = {
            nonce: new Uint8Array(32),
            color: this.contract.circuits.getLPTokenColor(this.circuitContext).result, // TODO: how to determine LP token color?
            value: 0n,
            mt_index: 0n
        }

        this.xReserves = {
            nonce: new Uint8Array(32),
            color: xColor,
            value: 0n,
            mt_index: 0n
        }

        this.yReserves = {
            nonce: new Uint8Array(32),
            color: yColor,
            value: 0n,
            mt_index: 0n
        }
    }

    getFeeBps(): bigint {
        const { result } = this.contract.circuits.getFeeBps(this.circuitContext)

        return result
    }

    getLPCirculatingSupply(): bigint {
        const { result } = this.contract.circuits.getLPCirculatingSupply(this.circuitContext)

        return result
    }

    getXColor(): Uint8Array {
        const { result } = this.contract.circuits.getXColor(this.circuitContext)

        return result
    }

    getXLiquidity(): bigint {
        const { result } = this.contract.circuits.getXLiquidity(this.circuitContext)

        return result
    }

    getXRewards(): bigint {
        const { result } = this.contract.circuits.getXRewards(this.circuitContext)

        return result
    }

    getYColor(): Uint8Array {
        const { result } = this.contract.circuits.getYColor(this.circuitContext)

        return result
    }

    getYLiquidity(): bigint {
        const { result } = this.contract.circuits.getYLiquidity(this.circuitContext)

        return result
    }

    initLiquidity({xIn, yIn, lpOut}: {xIn: bigint, yIn: bigint, lpOut?: bigint}) {
        const userDefinedLPOut = !!lpOut

        lpOut = lpOut ?? BigInt(Math.round(Math.sqrt(Number(xIn)*Number(yIn))))

        if (!userDefinedLPOut) {
            while(lpOut*lpOut > xIn*yIn) {
                lpOut -= 1n
            }
        }

        const { context } = this.contract.circuits.initLiquidity(
            this.circuitContext, 
            this.lpReserves,
            xIn, 
            yIn, 
            lpOut
        )

        this.syncCircuitContext(context)
    }

    addLiquidity({xIn, yIn, lpOut}: {xIn: bigint, yIn: bigint, lpOut?: bigint}) {
        lpOut = lpOut ?? BigInt(Math.round(Math.sqrt(Number(xIn)*Number(yIn))))

        const { context } = this.contract.circuits.addLiquidity(
            this.circuitContext,
            this.xReserves,
            this.yReserves,
            this.lpReserves,
            xIn,
            yIn, 
            lpOut
        )

        this.syncCircuitContext(context)
    }

    removeLiquidity({lpIn, xOut, yOut}: {lpIn: bigint, xOut: bigint, yOut: bigint}) {
        const { context } = this.contract.circuits.removeLiquidity(
            this.circuitContext,
            this.xReserves,
            this.yReserves,
            this.lpReserves,
            lpIn,
            xOut,
            yOut
        )

        this.syncCircuitContext(context)
    }

    swapXToY({xIn, xFee, yOut}: {xIn: bigint, xFee?: bigint, yOut?: bigint}) {
        xFee = xFee ?? this.calcSwapXToYFee(xIn)
        yOut = yOut ?? this.calcSwapXToYOut(xIn, xFee)
        
        const { context } = this.contract.circuits.swapXToY(
            this.circuitContext,
            this.xReserves,
            this.yReserves,
            xIn,
            xFee,
            yOut
        )

        this.syncCircuitContext(context)
    }

    swapYToX({yIn, xFee, xOut}: {yIn: bigint, xFee?: bigint, xOut?: bigint}) {
        xOut = xOut ?? this.calcSwapYToXOut(yIn)
        xFee = xFee ?? this.calcSwapYToXFee(xOut)

        const { context } = this.contract.circuits.swapYToX(
            this.circuitContext,
            this.xReserves,
            this.yReserves,
            yIn,
            xFee,
            xOut
        )

        this.syncCircuitContext(context)
    }

    rewardTreasury() {
        const { context } = this.contract.circuits.rewardTreasury(
            this.circuitContext,
            this.xReserves
        )

        this.syncCircuitContext(context)
    }

    private calcSwapXToYFee(xIn: bigint): bigint {
        const feeBps = this.getFeeBps()
        let xFee = BigInt(Math.round(Number(xIn)*Number(feeBps)/10000))

        while (xFee*10000n < feeBps*xIn) {
            xFee += 1n
        }

        return xFee
    }

    private calcSwapXToYOut(xIn: bigint, xFee: bigint): bigint {
        const initialK = this.xReserves.value*this.yReserves.value

        let yOut = this.yReserves.value - BigInt(Math.round(Number(initialK)/Number(this.xReserves.value + xIn - xFee)));

        while (initialK > (this.yReserves.value - yOut)*(this.xReserves.value + xIn - xFee)) {
            yOut -= 1n
        }

        return yOut
    }

    private calcSwapYToXFee(xOut: bigint): bigint {
        const feeBps = this.getFeeBps()
        let xFee = BigInt(Math.round(Number(xOut)*Number(feeBps)/(10000 - Number(feeBps))))

        while (xFee*(10000n - feeBps) < feeBps*xOut) {
            xFee += 1n
        }

        return xFee
    }

    private calcSwapYToXOut(yIn: bigint): bigint {
        const initialK = this.xReserves.value*this.yReserves.value

        let xOutWithoutFee = this.xReserves.value - BigInt(Math.round(Number(initialK)/Number(this.yReserves.value + yIn)));

        while (initialK > (this.xReserves.value - xOutWithoutFee)*(this.yReserves.value + yIn)) {
            xOutWithoutFee -= 1n
        }

        const xFee = this.calcSwapXToYFee(xOutWithoutFee)

        return xOutWithoutFee - xFee
    }

    private syncCircuitContext(context: CircuitContext<unknown>) {
        this.syncLPReserves(context)
        this.syncXReserves(context)
        this.syncYReserves(context)

        // delete the currentZswapLocalstate
        this.circuitContext = {
            ...context,
            currentZswapLocalState: emptyZswapLocalState(dummyTxSender)
        }
    }

    private syncLPReserves(context: CircuitContext<unknown>) {
         const newLPReserves = context.currentZswapLocalState.outputs.find(output => {
            return !output.recipient.is_left && 
                output.coinInfo.color.every((b, i) => b == this.lpReserves.color.at(i))
        })

        if (newLPReserves) {
            this.lpReserves = {...this.lpReserves, ...newLPReserves.coinInfo}
        }
    }

    private syncXReserves(context: CircuitContext<unknown>) {
        const newXReserves = context.currentZswapLocalState.outputs.find(output => {
            return !output.recipient.is_left && output.coinInfo.color.every((b, i) => b == this.xReserves.color.at(i))
        })

        if (newXReserves) {
            this.xReserves = {...this.xReserves, ...newXReserves.coinInfo}
        }
    }

    private syncYReserves(context: CircuitContext<unknown>) {1
        const newYReserves = context.currentZswapLocalState.outputs.find(output => {
            return !output.recipient.is_left && output.coinInfo.color.every((b, i) => b == this.yReserves.color.at(i))
        })

        if (newYReserves) {
            this.yReserves = {...this.yReserves, ...newYReserves.coinInfo}
        }
    }
}

