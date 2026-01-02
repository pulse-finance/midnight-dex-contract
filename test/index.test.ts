import { describe, expect, it } from "bun:test"
import { treasury, user1, user2 } from "./addresses"
import { Simulator } from "./simulator"

describe("liquidity init/add/remove without swaps", () => {
    const simulator = new Simulator(treasury)

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
    const simulator = new Simulator(treasury)

    it("can init lp", () => {
        simulator.initLiquidity({xIn: 1_000_000n, yIn: 2_000_000n})
    })

    it("fails to swap X to Y if fee is too low", () => {
        expect(() => {
            simulator.swapXToY({xIn: 1000n, xFee: 0n})
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
     const simulator = new Simulator(treasury)

    it("can init lp", () => {
        simulator.initLiquidity({xIn: 1_000_000n, yIn: 2_000_000n})
    })

    it("fails to swap Y to X if fee is too low", () => {
        expect(() => {
            simulator.swapYToX({yIn: 2000n, xFee: 0n})
        }).toThrow(/Fee too low/)
    })

    it("fails to swap Y to X if xOut is too hight", () => {
        expect(() => {
            simulator.swapYToX({yIn: 2000n, xFee: 2n, xOut: 998n})
        }).toThrow(/Final k smaller than initial k/)
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