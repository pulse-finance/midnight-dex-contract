import { describe, expect, it } from "bun:test"
import { treasury } from "./addresses"
import { AmmSimulator } from "./AmmSimulator"

describe("liquidity init/add/remove without swaps", () => {
    const simulator = new AmmSimulator(treasury)

    it("fails to construct with a fee at or above 100%", () => {
        expect(() => new AmmSimulator(treasury, { fee: 10000n })).toThrow(/Fee too high/)
    })

    it("xColor initialized at 9999...", () => {
        const xColor = simulator.getXColor()

        expect(xColor.every(b => b == 9))
    })

    it("yColor initialized at 10101010...", () => {
        const xColor = simulator.getYColor()

        expect(xColor.every(b => b == 10))
    })

    it("fee initialized at 10", () => {
        expect(simulator.getFeeBps()).toBe(10n)
    })

    it("lp initialized at 0", () => {
        expect(simulator.getLPCirculatingSupply()).toBe(0n)    
    })

    it("x liquidity initialized at 0", () => {
        expect(simulator.getXLiquidity()).toBe(0n)    
    })

    it("y liquidity initialized at 0", () => {
        expect(simulator.getYLiquidity()).toBe(0n)    
    })

    it("fails to mint if lpMinted isn't sqrt(xIn*yIn)", () => {
        expect(() => simulator.initLiquidity({xIn: 1000n, yIn: 1000n, lpOut: 1002n})).toThrow(/Too many LP tokens taken/)
    })

    it("can init lp", () => {
        simulator.initLiquidity({xIn: 1000n, yIn: 1000n})
    })

    it("getXLiquidity() returns 1000n", () => {
        expect(simulator.getXLiquidity()).toBe(1000n)
    })

    it("getYLiquidity() returns 1000n", () => {
        expect(simulator.getYLiquidity()).toBe(1000n)
    })

    it("fails to mint a second time", () => {
        expect(() => simulator.initLiquidity({xIn: 1000n, yIn: 1000n})).toThrow(/Already initialized/)
    })

    it("fails to update the fee without the batcher secret", () => {
        const wrongSecret = new Uint8Array(32).fill(5)

        expect(() => {
            simulator.update({ fee: 20n, treasury, secret: wrongSecret })
        }).toThrow(/Can only be performed by batcher/)
    })

    it("fails to update the fee at or above 100%", () => {
        expect(() => {
            simulator.update({ fee: 10000n, treasury })
        }).toThrow(/Fee too high/)
    })

    it("can update the fee and treasury", () => {
        simulator.update({ fee: 20n, treasury })

        expect(simulator.getFeeBps()).toBe(20n)
    })

    it("lp is 1000n after init", () => {
        expect(simulator.getLPCirculatingSupply()).toBe(1000n)
    })

    it("xLiquidity in reserves coin is 1000n", () => {
        expect(simulator.xReserves.value).toBe(1000n)
    })

    it("can add more liquidity", () => {
        simulator.addLiquidity({
            xIn: 900n,
            yIn: 900n
        })
    })

    it("xLiquidity in reserves coin is 1900n", () => {
        expect(simulator.xReserves.value).toBe(1900n)
    })

    it("lp is 1900n after adding", () => {
        expect(simulator.getLPCirculatingSupply()).toBe(1900n)
    })

    it("getXLiquidity() returns 1900n", () => {
        expect(simulator.getXLiquidity()).toBe(1900n)
    })

    it("getYLiquidity() returns 1900n", () => {
        expect(simulator.getYLiquidity()).toBe(1900n)
    })

    it("fails to remove liquidity if xOut is too high", () => {
        expect(() => {
            simulator.removeLiquidity({
                lpIn: 500n,
                xOut: 501n,
                yOut: 500n
            })
        }).toThrow(/Too many X tokens taken/)
    })

    it("fails to remove liquidity if yOut is too high", () => {
        expect(() => {
            simulator.removeLiquidity({
                lpIn: 500n,
                xOut: 500n,
                yOut: 501n
            })
        }).toThrow(/Too many Y tokens taken/)
    })

    it("can remove some liquidity", () => {
        simulator.removeLiquidity({
            lpIn: 500n,
            xOut: 500n,
            yOut: 500n
        })
    })

    it("lp is 1400n after removing", () => {
        expect(simulator.getLPCirculatingSupply()).toBe(1400n)
    })

    it("getXLiquidity() returns 1400n", () => {
        expect(simulator.getXLiquidity()).toBe(1400n)
    })

    it("getYLiquidity() returns 1400n", () => {
        expect(simulator.getYLiquidity()).toBe(1400n)
    })
})

describe("init liquidity with an X to Y swap", () => {
    const simulator = new AmmSimulator(treasury)

    it("can init lp", () => {
        simulator.initLiquidity({xIn: 1_000_000n, yIn: 2_000_000n})
    })

    it("fails to swap X to Y if fee is too low", () => {
        expect(() => {
            simulator.swapXToY({xIn: 2000n, xFee: 1n})
        }).toThrow(/Fee too low/)
    })

    it("fails to swap X to Y if yOut is too high", () => {
        expect(() => {
            simulator.swapXToY({xIn: 1000n, xFee: 1n, yOut: 1997n})
        }).toThrow(/Final k smaller than initial k/)
    })

    it("can swap X to Y", () => {
        simulator.swapXToY({xIn: 1000n})
    })

    it("X liquidity increased", () => {
        expect(simulator.getXLiquidity()).toBe(1_000_999n)
    })

    it("X rewards increased", () => {
        expect(simulator.getXRewards()).toBe(1n)
    })

    it("Y liquidity decreased", () => {
        expect(simulator.getYLiquidity()).toBe(1_998_004n)
    })

    it("can reward treasury", () => {
        simulator.rewardTreasury()

        expect(simulator.getXRewards()).toBe(0n)
    })
})

describe("init liquidity with an Y to X swap", () => {
     const simulator = new AmmSimulator(treasury)

    it("can init lp", () => {
        simulator.initLiquidity({xIn: 1_000_000n, yIn: 2_000_000n})
    })

    it("fails to swap Y to X if fee is too low", () => {
        expect(() => {
            simulator.swapYToX({yIn: 4000n, xFee: 1n})
        }).toThrow(/Fee too low/)
    })

    it("fails to swap Y to X if fee is too high", () => {
        expect(() => {
            simulator.swapYToX({yIn: 2000n, xFee: 2n, xOut: 998n})
        }).toThrow(/Fee too high/)
    })

    it("can swap Y to X", () => {
        simulator.swapYToX({yIn: 2000n})
    })

    it("Y liquidity increased", () => {
        expect(simulator.getYLiquidity()).toBe(2_002_000n)
    })

    it("X rewards increased", () => {
        expect(simulator.getXRewards()).toBe(1n)
    })

    it("X liquidity decreased", () => {
        expect(simulator.getXLiquidity()).toBe(999_001n)
    })

    it("can reward treasury", () => {
        simulator.rewardTreasury()

        expect(simulator.getXRewards()).toBe(0n)
    })
})

describe("zap liquidity paths", () => {
    it("can zap X into LP", () => {
        const simulator = new AmmSimulator(treasury)

        simulator.initLiquidity({xIn: 1_000_000n, yIn: 2_000_000n, lpOut: 1_000_000n})
        simulator.zapInX({
            xIn: 1000n,
            xSwap: 501n,
            xFee: 1n,
            ySwap: 999n,
            lpOut: 498n,
        })

        expect(simulator.getXLiquidity()).toBe(1_000_999n)
        expect(simulator.getYLiquidity()).toBe(2_000_000n)
        expect(simulator.getXRewards()).toBe(1n)
        expect(simulator.getLPCirculatingSupply()).toBe(1_000_498n)
    })

    it("can zap Y into LP", () => {
        const simulator = new AmmSimulator(treasury)

        simulator.initLiquidity({xIn: 1_000_000n, yIn: 2_000_000n, lpOut: 1_000_000n})
        simulator.zapInY({
            yIn: 2000n,
            ySwap: 1002n,
            xFee: 1n,
            xSwap: 499n,
            lpOut: 498n,
        })

        expect(simulator.getXLiquidity()).toBe(999_999n)
        expect(simulator.getYLiquidity()).toBe(2_002_000n)
        expect(simulator.getXRewards()).toBe(1n)
        expect(simulator.getLPCirculatingSupply()).toBe(1_000_498n)
    })

    it("can zap LP out to X", () => {
        const simulator = new AmmSimulator(treasury)

        simulator.initLiquidity({xIn: 1_000_000n, yIn: 1_000_000n, lpOut: 1_000_000n})
        simulator.zapOutX({
            lpIn: 1000n,
            xOut: 1998n,
            ySwap: 1000n,
            xFee: 1n,
            xSwap: 998n,
        })

        expect(simulator.getXLiquidity()).toBe(998_001n)
        expect(simulator.getYLiquidity()).toBe(1_000_000n)
        expect(simulator.getXRewards()).toBe(1n)
        expect(simulator.getLPCirculatingSupply()).toBe(999_000n)
    })

    it("can zap LP out to Y", () => {
        const simulator = new AmmSimulator(treasury)

        simulator.initLiquidity({xIn: 1_000_000n, yIn: 1_000_000n, lpOut: 1_000_000n})
        simulator.zapOutY({
            lpIn: 1000n,
            yOut: 1998n,
            xSwap: 1000n,
            xFee: 1n,
            ySwap: 998n,
        })

        expect(simulator.getXLiquidity()).toBe(999_999n)
        expect(simulator.getYLiquidity()).toBe(998_002n)
        expect(simulator.getXRewards()).toBe(1n)
        expect(simulator.getLPCirculatingSupply()).toBe(999_000n)
    })
})

describe("AMM assertion failures", () => {
    function initialized({ xIn = 1000n, yIn = 1000n, lpOut = 1000n } = {}) {
        const simulator = new AmmSimulator(treasury)
        simulator.initLiquidity({ xIn, yIn, lpOut })
        return simulator
    }

    it("rejects finalizers and validators without a pending order", () => {
        const simulator = initialized()

        expect(() => simulator.validateSwapXToY({ xFee: 1n, yOut: 1n })).toThrow(/No pending order/)
        expect(() => simulator.mintLp()).toThrow(/No pending order/)
        expect(() => simulator.sendX()).toThrow(/No pending order/)
        expect(() => simulator.sendY()).toThrow(/No pending order/)
    })

    it("rejects new starts while a swap is pending", () => {
        const simulator = initialized()
        simulator.startSwapXToY({ xIn: 100n })

        expect(() => simulator.startDepositX({ xIn: 100n })).toThrow(/Another order is pending/)
        expect(() => simulator.startWithdrawXY({ lpIn: 100n })).toThrow(/Amm slot not empty/)
    })

    it("rejects two-sided deposit validation without a pending order", () => {
        const simulator = initialized()
        expect(() => simulator.validateDepositXY(1n)).toThrow(/No pending order/)
    })

    it("rejects X zap-in validation without a pending order", () => {
        const simulator = initialized()
        expect(() => simulator.validateDepositX({ xSwap: 1n, xFee: 1n, ySwap: 1n, lpOut: 1n }))
            .toThrow(/No pending order/)
    })

    it("rejects Y zap-in validation without a pending order", () => {
        const simulator = initialized()
        expect(() => simulator.validateDepositY({ ySwap: 1n, xFee: 1n, xSwap: 1n, lpOut: 1n }))
            .toThrow(/No pending order/)
    })

    it("rejects Y-to-X swap validation without a pending order", () => {
        const simulator = initialized()
        expect(() => simulator.validateSwapYToX({ xFee: 1n, xOut: 1n })).toThrow(/No pending order/)
    })

    it("rejects two-sided withdrawal validation without a pending order", () => {
        const simulator = initialized()
        expect(() => simulator.validateWithdrawXY({ xOut: 1n, yOut: 1n })).toThrow(/No pending order/)
    })

    it("rejects X zap-out validation without a pending order", () => {
        const simulator = initialized()
        expect(() => simulator.validateWithdrawX({ xOut: 1n, ySwap: 1n, xFee: 1n, xSwap: 1n }))
            .toThrow(/No pending order/)
    })

    it("rejects Y zap-out validation without a pending order", () => {
        const simulator = initialized()
        expect(() => simulator.validateWithdrawY({ yOut: 1n, xSwap: 1n, xFee: 1n, ySwap: 1n }))
            .toThrow(/No pending order/)
    })

    it("rejects two-sided deposit start while a swap is pending", () => {
        const simulator = initialized()
        simulator.startSwapXToY({ xIn: 100n })
        expect(() => simulator.startDepositXY({ xIn: 100n, yIn: 100n })).toThrow(/Another order is pending/)
    })

    it("rejects Y deposit start while a swap is pending", () => {
        const simulator = initialized()
        simulator.startSwapXToY({ xIn: 100n })
        expect(() => simulator.startDepositY({ yIn: 100n })).toThrow(/Another order is pending/)
    })

    it("rejects X-to-Y swap start while a deposit is pending", () => {
        const simulator = initialized()
        simulator.startDepositX({ xIn: 100n })
        expect(() => simulator.startSwapXToY({ xIn: 100n })).toThrow(/Another order is pending/)
    })

    it("rejects Y-to-X swap start while a deposit is pending", () => {
        const simulator = initialized()
        simulator.startDepositX({ xIn: 100n })
        expect(() => simulator.startSwapYToX({ yIn: 100n })).toThrow(/Another order is pending/)
    })

    it("rejects X withdrawal start while a deposit is pending", () => {
        const simulator = initialized()
        simulator.startDepositX({ xIn: 100n })
        expect(() => simulator.startWithdrawX({ lpIn: 100n })).toThrow(/Amm slot not empty/)
    })

    it("rejects Y withdrawal start while a deposit is pending", () => {
        const simulator = initialized()
        simulator.startDepositX({ xIn: 100n })
        expect(() => simulator.startWithdrawY({ lpIn: 100n })).toThrow(/Amm slot not empty/)
    })

    it("rejects two-sided deposits after all LP supply has been burned", () => {
        const simulator = initialized()
        simulator.removeLiquidity({ lpIn: 1000n, xOut: 999n, yOut: 999n })
        expect(simulator.getLPCirculatingSupply()).toBe(0n)
        expect(() => simulator.startDepositXY({ xIn: 100n, yIn: 100n })).toThrow(/Not yet initialized/)
    })

    it("rejects X deposits after all LP supply has been burned", () => {
        const simulator = initialized()
        simulator.removeLiquidity({ lpIn: 1000n, xOut: 999n, yOut: 999n })
        expect(simulator.getLPCirculatingSupply()).toBe(0n)
        expect(() => simulator.startDepositX({ xIn: 100n })).toThrow(/Not yet initialized/)
    })

    it("rejects Y deposits after all LP supply has been burned", () => {
        const simulator = initialized()
        simulator.removeLiquidity({ lpIn: 1000n, xOut: 999n, yOut: 999n })
        expect(simulator.getLPCirculatingSupply()).toBe(0n)
        expect(() => simulator.startDepositY({ yIn: 100n })).toThrow(/Not yet initialized/)
    })

    it("rejects finalizers and wrong swap validator for a pending X-to-Y swap", () => {
        const simulator = initialized()
        simulator.startSwapXToY({ xIn: 100n })

        expect(() => simulator.mintLp()).toThrow(/Pending order isn't a MintLp order/)
        expect(() => simulator.sendX()).toThrow(/Pending order isn't a SendX order/)
        expect(() => simulator.sendY()).toThrow(/Pending order isn't an SendY order/)
        expect(() => simulator.validateSwapYToX({ xFee: 1n, xOut: 1n }))
            .toThrow(/Pending order isn't a ValidateSwapYToX order/)
    })

    it("rejects X-to-Y validation for a pending Y-to-X swap", () => {
        const simulator = initialized()
        simulator.startSwapYToX({ yIn: 100n })
        expect(() => simulator.validateSwapXToY({ xFee: 1n, yOut: 1n }))
            .toThrow(/Pending order isn't a ValidateSwapXToY order/)
    })

    it("rejects non-swap validators for a pending X-to-Y swap", () => {
        const simulator = initialized()
        simulator.startSwapXToY({ xIn: 100n })

        expect(() => simulator.validateDepositXY(1n))
            .toThrow(/Pending order isn't a ValidateDepositXYLiq order/)
        expect(() => simulator.validateDepositX({ xSwap: 1n, xFee: 1n, ySwap: 1n, lpOut: 1n }))
            .toThrow(/Pending order isn't a ValidateDepositXLiq order/)
        expect(() => simulator.validateDepositY({ ySwap: 1n, xFee: 1n, xSwap: 1n, lpOut: 1n }))
            .toThrow(/Pending order isn't a ValidateDepositYLiq order/)
        expect(() => simulator.validateWithdrawXY({ xOut: 1n, yOut: 1n }))
            .toThrow(/Pending order isn't a ValidateWithdrawXYLiq order/)
        expect(() => simulator.validateWithdrawX({ xOut: 1n, ySwap: 1n, xFee: 1n, xSwap: 1n }))
            .toThrow(/Pending order isn't a ValidateWithdrawXLiq order/)
        expect(() => simulator.validateWithdrawY({ yOut: 1n, xSwap: 1n, xFee: 1n, ySwap: 1n }))
            .toThrow(/Pending order isn't a ValidateWithdrawYLiq order/)
    })

    it("rejects Y send finalization after validating a Y-to-X swap", () => {
        const simulator = initialized()
        simulator.startSwapYToX({ yIn: 100n })
        simulator.validateSwapYToX({ xFee: 1n, xOut: 89n })
        expect(() => simulator.sendY()).toThrow(/Pending order isn't an SendY order/)
    })

    it("rejects X send finalization after validating an X-to-Y swap", () => {
        const simulator = initialized()
        simulator.startSwapXToY({ xIn: 100n })
        simulator.validateSwapXToY({ xFee: 1n, yOut: 90n })
        expect(() => simulator.sendX()).toThrow(/Pending order isn't a SendX order/)
    })

    it("rejects excessive LP on X-bound two-sided deposits", () => {
        const simulator = initialized()
        simulator.startDepositXY({ xIn: 100n, yIn: 200n })
        expect(() => simulator.validateDepositXY(101n)).toThrow(/Too many LP tokens taken \(bound by xIn\)/)
    })

    it("rejects excessive LP on Y-bound two-sided deposits", () => {
        const simulator = initialized()
        simulator.startDepositXY({ xIn: 200n, yIn: 100n })
        expect(() => simulator.validateDepositXY(101n)).toThrow(/Too many LP tokens taken \(bound by yIn\)/)
    })

    it("rejects low X zap-in fees", () => {
        const simulator = initialized()
        simulator.startDepositX({ xIn: 1000n })
        expect(() => simulator.validateDepositX({ xSwap: 2000n, xFee: 1n, ySwap: 1n, lpOut: 1n }))
            .toThrow(/Fee too low/)
    })

    it("rejects X zap-in swaps that lower k", () => {
        const simulator = initialized()
        simulator.startDepositX({ xIn: 1000n })
        expect(() => simulator.validateDepositX({ xSwap: 500n, xFee: 1n, ySwap: 900n, lpOut: 1n }))
            .toThrow(/Post-swap k is lower than initial k/)
    })

    it("rejects X-heavy X zap-in splits", () => {
        const simulator = initialized()
        simulator.startDepositX({ xIn: 1000n })
        expect(() => simulator.validateDepositX({ xSwap: 3n, xFee: 1n, ySwap: 1n, lpOut: 1n }))
            .toThrow(/X zap-in split too X heavy/)
    })

    it("rejects Y-heavy X zap-in splits", () => {
        const simulator = initialized()
        simulator.startDepositX({ xIn: 1000n })
        expect(() => simulator.validateDepositX({ xSwap: 416n, xFee: 1n, ySwap: 293n, lpOut: 413n }))
            .toThrow(/X zap-in split too Y heavy/)
    })

    it("rejects excessive LP for balanced X zap-in deposits", () => {
        const simulator = initialized({ xIn: 1_000_000n, yIn: 2_000_000n, lpOut: 1_000_000n })
        simulator.startDepositX({ xIn: 1000n })
        expect(() => simulator.validateDepositX({ xSwap: 501n, xFee: 1n, ySwap: 999n, lpOut: 499n }))
            .toThrow(/Too many LP tokens taken/)
    })

    it("rejects low Y zap-in fees", () => {
        const simulator = initialized()
        simulator.startDepositY({ yIn: 1000n })
        expect(() => simulator.validateDepositY({ ySwap: 500n, xFee: 1n, xSwap: 2000n, lpOut: 1n }))
            .toThrow(/Fee too low/)
    })

    it("rejects Y zap-in swaps that lower k", () => {
        const simulator = initialized()
        simulator.startDepositY({ yIn: 1000n })
        expect(() => simulator.validateDepositY({ ySwap: 500n, xFee: 1n, xSwap: 900n, lpOut: 1n }))
            .toThrow(/Post-swap k is lower than initial k/)
    })

    it("rejects Y-heavy Y zap-in splits", () => {
        const simulator = initialized()
        simulator.startDepositY({ yIn: 1000n })
        expect(() => simulator.validateDepositY({ ySwap: 3n, xFee: 1n, xSwap: 1n, lpOut: 2n }))
            .toThrow(/Y zap-in split too Y heavy/)
    })

    it("rejects X-heavy Y zap-in splits", () => {
        const simulator = initialized()
        simulator.startDepositY({ yIn: 1000n })
        expect(() => simulator.validateDepositY({ ySwap: 417n, xFee: 1n, xSwap: 293n, lpOut: 413n }))
            .toThrow(/Y zap-in split too X heavy/)
    })

    it("rejects excessive LP for balanced Y zap-in deposits", () => {
        const simulator = initialized({ xIn: 1_000_000n, yIn: 2_000_000n, lpOut: 1_000_000n })
        simulator.startDepositY({ yIn: 2000n })
        expect(() => simulator.validateDepositY({ ySwap: 1002n, xFee: 1n, xSwap: 499n, lpOut: 499n }))
            .toThrow(/Too many LP tokens minted \(bound by y\)/)
    })

    it("rejects excessive X removal on X zap-outs", () => {
        const simulator = initialized()
        simulator.startWithdrawX({ lpIn: 100n })
        expect(() => simulator.validateWithdrawX({ xOut: 101n, ySwap: 0n, xFee: 0n, xSwap: 0n }))
            .toThrow(/Too many X tokens taken/)
    })

    it("rejects excessive Y removal on X zap-outs", () => {
        const simulator = initialized()
        simulator.startWithdrawX({ lpIn: 100n })
        expect(() => simulator.validateWithdrawX({ xOut: 100n, ySwap: 101n, xFee: 0n, xSwap: 0n }))
            .toThrow(/Too many Y tokens taken/)
    })

    it("rejects low X zap-out fees", () => {
        const simulator = initialized()
        simulator.startWithdrawX({ lpIn: 100n })
        expect(() => simulator.validateWithdrawX({ xOut: 2100n, ySwap: 100n, xFee: 1n, xSwap: 2000n }))
            .toThrow(/Fee too low/)
    })

    it("rejects X zap-out swaps that lower k", () => {
        const simulator = initialized()
        simulator.startWithdrawX({ lpIn: 100n })
        expect(() => simulator.validateWithdrawX({ xOut: 200n, ySwap: 100n, xFee: 1n, xSwap: 100n }))
            .toThrow(/Post-swap k is lower than pre-swap k/)
    })

    it("rejects excessive X removal on Y zap-outs", () => {
        const simulator = initialized()
        simulator.startWithdrawY({ lpIn: 100n })
        expect(() => simulator.validateWithdrawY({ yOut: 0n, xSwap: 101n, xFee: 0n, ySwap: 0n }))
            .toThrow(/Too many X tokens taken/)
    })

    it("rejects excessive Y removal on Y zap-outs", () => {
        const simulator = initialized()
        simulator.startWithdrawY({ lpIn: 100n })
        expect(() => simulator.validateWithdrawY({ yOut: 101n, xSwap: 100n, xFee: 0n, ySwap: 0n }))
            .toThrow(/Too many Y tokens taken/)
    })

    it("rejects low Y zap-out fees", () => {
        const simulator = initialized({ xIn: 1_000_000n, yIn: 2_000_000n, lpOut: 1_000_000n })
        simulator.startWithdrawY({ lpIn: 2000n })
        expect(() => simulator.validateWithdrawY({ yOut: 4050n, xSwap: 2000n, xFee: 1n, ySwap: 50n }))
            .toThrow(/Fee too low/)
    })

    it("rejects Y zap-out swaps that lower k", () => {
        const simulator = initialized()
        simulator.startWithdrawY({ lpIn: 100n })
        expect(() => simulator.validateWithdrawY({ yOut: 200n, xSwap: 100n, xFee: 1n, ySwap: 100n }))
            .toThrow(/Post-swap k is lower than pre-swap k/)
    })

    it("rejects occupied X temporary coin positions", () => {
        const simulator = initialized({ xIn: 1_000_000n, yIn: 2_000_000n, lpOut: 1_000_000n })
        simulator.startDepositX({ xIn: 1000n })
        simulator.validateDepositX({ xSwap: 501n, xFee: 1n, ySwap: 999n, lpOut: 498n })
        simulator.mintLp()

        expect(() => simulator.startDepositX({ xIn: 1000n })).toThrow(/Coin position 1 already occupied/)
        expect(() => simulator.startDepositXY({ xIn: 1000n, yIn: 1000n })).toThrow(/Coin position 1 already occupied/)
        expect(() => simulator.startSwapXToY({ xIn: 1000n })).toThrow(/Coin position 1 already occupied/)
    })

    it("rejects occupied Y temporary coin positions", () => {
        const simulator = initialized({ xIn: 1_000_000n, yIn: 2_000_000n, lpOut: 1_000_000n })
        simulator.startDepositY({ yIn: 2000n })
        simulator.validateDepositY({ ySwap: 1002n, xFee: 1n, xSwap: 499n, lpOut: 498n })
        simulator.mintLp()

        expect(() => simulator.startDepositY({ yIn: 2000n })).toThrow(/Coin position 3 already occupied/)
        expect(() => simulator.startDepositXY({ xIn: 1000n, yIn: 1000n })).toThrow(/Coin position 3 already occupied/)
        expect(() => simulator.startSwapYToX({ yIn: 2000n })).toThrow(/Coin position 3 already occupied/)
    })

    it("rejects reward payouts when sendShielded produces no change", () => {
        const simulator = initialized({ xIn: 1n, yIn: 1n, lpOut: 1n })
        simulator.startSwapXToY({ xIn: 1n })
        simulator.validateSwapXToY({ xFee: 1n, yOut: 0n })
        simulator.sendY()
        expect(() => simulator.rewardTreasury()).toThrow(/Expected some change/)
    })

    it("rejects X sends when sendShielded produces no change", () => {
        const simulator = initialized()
        simulator.startWithdrawXY({ lpIn: 1000n })
        simulator.validateWithdrawXY({ xOut: 1000n, yOut: 1000n })
        expect(() => simulator.sendX()).toThrow(/Expected some X change/)
    })

    it("surfaces map lookup failures when an X merge coin is missing", () => {
        const simulator = initialized()
        expect(() => simulator.mergeX()).toThrow(/expected a cell, received null/)
    })

    it("surfaces map lookup failures when a Y merge coin is missing", () => {
        const simulator = initialized()
        expect(() => simulator.mergeY()).toThrow(/expected a cell, received null/)
    })

    it("rejects malicious X-to-Y swap fee arguments", () => {
        const simulator = initialized({ xIn: 1_000_000n, yIn: 2_000_000n, lpOut: 1_000_000n })
        simulator.startSwapXToY({ xIn: 1000n })
        expect(() => simulator.validateSwapXToY({ xFee: 1000n, yOut: 0n })).toThrow()
    })

    it("rejects malicious X-to-Y swap output arguments", () => {
        const simulator = initialized({ xIn: 1_000_000n, yIn: 2_000_000n, lpOut: 1_000_000n })
        simulator.startSwapXToY({ xIn: 1000n })
        expect(() => simulator.validateSwapXToY({ xFee: 1n, yOut: 0n })).toThrow(/Final k too large/)
    })

    it("rejects malicious Y-to-X swap fee arguments", () => {
        const simulator = initialized({ xIn: 1_000_000n, yIn: 2_000_000n, lpOut: 1_000_000n })
        simulator.startSwapYToX({ yIn: 2000n })
        expect(() => simulator.validateSwapYToX({ xFee: 0n, xOut: 0n })).toThrow()
    })

    it("rejects malicious Y-to-X swap output arguments", () => {
        const simulator = initialized({ xIn: 1_000_000n, yIn: 2_000_000n, lpOut: 1_000_000n })
        simulator.startSwapYToX({ yIn: 2000n })
        expect(() => simulator.validateSwapYToX({ xFee: 1n, xOut: 0n })).toThrow(/Fee too high|Final k too large/)
    })

    it("rejects zero LP output for two-sided deposits", () => {
        const simulator = initialized({ xIn: 1_000_000n, yIn: 2_000_000n, lpOut: 1_000_000n })
        simulator.startDepositXY({ xIn: 1000n, yIn: 1000n })
        expect(() => simulator.validateDepositXY(0n)).toThrow(/Too little LP tokens minted/)
    })

    it("rejects malicious X zap-in fee arguments", () => {
        const simulator = initialized({ xIn: 1_000_000n, yIn: 2_000_000n, lpOut: 1_000_000n })
        simulator.startDepositX({ xIn: 1000n })
        expect(() => simulator.validateDepositX({ xSwap: 1000n, xFee: 1000n, ySwap: 0n, lpOut: 0n }))
            .toThrow(/Fee too high|Too little LP tokens minted/)
    })

    it("rejects malicious X zap-in output arguments that over-preserve k", () => {
        const simulator = initialized({ xIn: 1_000_000n, yIn: 2_000_000n, lpOut: 1_000_000n })
        simulator.startDepositX({ xIn: 1000n })
        expect(() => simulator.validateDepositX({ xSwap: 1000n, xFee: 1n, ySwap: 0n, lpOut: 0n }))
            .toThrow(/Post-swap k is too high/)
    })

    it("rejects zero-swap X zap-in arguments", () => {
        const simulator = initialized({ xIn: 1_000_000n, yIn: 2_000_000n, lpOut: 1_000_000n })
        simulator.startDepositX({ xIn: 1000n })
        expect(() => simulator.validateDepositX({ xSwap: 0n, xFee: 0n, ySwap: 0n, lpOut: 0n })).toThrow()
    })

    it("rejects malicious Y zap-in zero-output arguments", () => {
        const simulator = initialized({ xIn: 1_000_000n, yIn: 2_000_000n, lpOut: 1_000_000n })
        simulator.startDepositY({ yIn: 2000n })
        expect(() => simulator.validateDepositY({ ySwap: 2000n, xFee: 0n, xSwap: 0n, lpOut: 0n })).toThrow()
    })

    it("rejects malicious Y zap-in output arguments that over-preserve k", () => {
        const simulator = initialized({ xIn: 1_000_000n, yIn: 2_000_000n, lpOut: 1_000_000n })
        simulator.startDepositY({ yIn: 2000n })
        expect(() => simulator.validateDepositY({ ySwap: 2000n, xFee: 1n, xSwap: 1n, lpOut: 0n }))
            .toThrow(/Post-swap k is too high/)
    })

    it("rejects zero-swap Y zap-in arguments", () => {
        const simulator = initialized({ xIn: 1_000_000n, yIn: 2_000_000n, lpOut: 1_000_000n })
        simulator.startDepositY({ yIn: 2000n })
        expect(() => simulator.validateDepositY({ ySwap: 0n, xFee: 0n, xSwap: 0n, lpOut: 0n })).toThrow()
    })

    it("rejects zero-output two-sided withdrawals", () => {
        const simulator = initialized({ xIn: 1_000_000n, yIn: 2_000_000n, lpOut: 1_000_000n })
        simulator.startWithdrawXY({ lpIn: 1000n })
        expect(() => simulator.validateWithdrawXY({ xOut: 0n, yOut: 0n })).toThrow(/Not enough|Now enough/)
    })

    it("rejects zero-output X zap-out arguments", () => {
        const simulator = initialized({ xIn: 1_000_000n, yIn: 2_000_000n, lpOut: 1_000_000n })
        simulator.startWithdrawX({ lpIn: 1000n })
        expect(() => simulator.validateWithdrawX({ xOut: 0n, ySwap: 0n, xFee: 0n, xSwap: 0n })).toThrow()
    })

    it("rejects X zap-out arguments that over-preserve k", () => {
        const simulator = initialized({ xIn: 1_000_000n, yIn: 2_000_000n, lpOut: 1_000_000n })
        simulator.startWithdrawX({ lpIn: 1000n })
        expect(() => simulator.validateWithdrawX({ xOut: 1001n, ySwap: 2000n, xFee: 1n, xSwap: 1n }))
            .toThrow(/Post-swap k is too high/)
    })

    it("rejects X zap-out arguments that omit Y removal", () => {
        const simulator = initialized({ xIn: 1_000_000n, yIn: 2_000_000n, lpOut: 1_000_000n })
        simulator.startWithdrawX({ lpIn: 1000n })
        expect(() => simulator.validateWithdrawX({ xOut: 1000n, ySwap: 0n, xFee: 0n, xSwap: 0n })).toThrow(/Not enough Y/)
    })

    it("rejects zero-output Y zap-out arguments", () => {
        const simulator = initialized({ xIn: 1_000_000n, yIn: 2_000_000n, lpOut: 1_000_000n })
        simulator.startWithdrawY({ lpIn: 1000n })
        expect(() => simulator.validateWithdrawY({ yOut: 0n, xSwap: 0n, xFee: 0n, ySwap: 0n })).toThrow()
    })

    it("rejects Y zap-out arguments that over-preserve k", () => {
        const simulator = initialized({ xIn: 1_000_000n, yIn: 2_000_000n, lpOut: 1_000_000n })
        simulator.startWithdrawY({ lpIn: 1000n })
        expect(() => simulator.validateWithdrawY({ yOut: 2001n, xSwap: 1000n, xFee: 1n, ySwap: 1n }))
            .toThrow(/Post-swap k is too high/)
    })

    it("rejects Y zap-out arguments that omit X removal", () => {
        const simulator = initialized({ xIn: 1_000_000n, yIn: 2_000_000n, lpOut: 1_000_000n })
        simulator.startWithdrawY({ lpIn: 1000n })
        expect(() => simulator.validateWithdrawY({ yOut: 2000n, xSwap: 0n, xFee: 0n, ySwap: 0n })).toThrow(/Too few X/)
    })
})
