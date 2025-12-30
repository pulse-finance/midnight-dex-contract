import { CircuitContext, constructorContext, emptyZswapLocalState, EncodedCoinInfo, EncodedQualifiedCoinInfo, QueryContext, sampleContractAddress } from "@midnight-ntwrk/compact-runtime"
import { Contract } from "../dist/contract/index.cjs"
import { type Address } from "./addresses"

const dummyTxSender = "0".repeat(64)

export class Simulator {
    private contract: Contract<unknown, {}>;
    readonly address: string;
    private circuitContext: CircuitContext<unknown>;
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

 

    getFee(): bigint {
        const { result } = this.contract.circuits.getFee(this.circuitContext)

        return result
    }

    getLPSupply(): bigint {
        const { result } = this.contract.circuits.getLPSupply(this.circuitContext)

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

    getYColor(): Uint8Array {
        const { result } = this.contract.circuits.getYColor(this.circuitContext)

        return result
    }

    getYLiquidity(): bigint {
        const { result } = this.contract.circuits.getYLiquidity(this.circuitContext)

        return result
    }

    initLiquidity({xIn, yIn, recipient, lpMinted}: {xIn: bigint, yIn: bigint, recipient: Address, lpMinted?: bigint}) {
        lpMinted = lpMinted ?? BigInt(Math.round(Math.sqrt(Number(xIn)*Number(yIn))))

        const { context } = this.contract.circuits.initLiquidity(this.circuitContext, xIn, yIn, lpMinted, recipient)

        this.syncCircuitContext(context)
    }

    addLiquidity({xIn, yIn, recipient, lpMinted}: {xIn: bigint, yIn: bigint, recipient: Address, lpMinted?: bigint}) {
        lpMinted = lpMinted ?? BigInt(Math.round(Math.sqrt(Number(xIn)*Number(yIn))))

        const { context } = this.contract.circuits.addLiquidity(
            this.circuitContext, 
            this.xReserves,
            this.yReserves,
            xIn, 
            yIn, 
            lpMinted, 
            recipient
        )

        this.syncCircuitContext(context)
    }

    removeLiquidity({lpBurned, xOut, yOut, recipient}: {lpBurned: bigint, xOut: bigint, yOut: bigint, recipient: Address}) {
        const { context } = this.contract.circuits.removeLiquidity(
            this.circuitContext,
            this.xReserves,
            this.yReserves,
            lpBurned,
            xOut,
            yOut,
            recipient
        )

        this.syncCircuitContext(context)
    }

    private syncCircuitContext(context: CircuitContext<unknown>) {
        this.syncXReserves(context)
        this.syncYReserves(context)

        // delete the currentZswapLocalstate
        this.circuitContext = {
            ...context,
            currentZswapLocalState: emptyZswapLocalState(dummyTxSender)
        }
    }

    private syncXReserves(context: CircuitContext<unknown>) {
        const newXReserves = context.currentZswapLocalState.outputs.find(output => {
            return !output.recipient.is_left && output.coinInfo.color.every((b, i) => b == this.xReserves.color.at(i))
        })

        if (!newXReserves) {
            throw new Error("xReserves output not found")
        }

        this.xReserves = {...this.xReserves, ...newXReserves.coinInfo}
    }

    private syncYReserves(context: CircuitContext<unknown>) {1
        const newYReserves = context.currentZswapLocalState.outputs.find(output => {
            return !output.recipient.is_left && output.coinInfo.color.every((b, i) => b == this.yReserves.color.at(i))
        })

        if (!newYReserves) {
            throw new Error("yReserves output not found")
        }

        this.yReserves = {...this.yReserves, ...newYReserves.coinInfo}
    }
}

