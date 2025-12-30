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
        expect(simulator.getFee()).toBe(10n)
    })

    it("lp initialized at 0", () => {
        expect(simulator.getLPSupply()).toBe(0n)    
    })

    it("x liquidity initialized at 0", () => {
        expect(simulator.getXLiquidity()).toBe(0n)    
    })

    it("y liquidity initialized at 0", () => {
        expect(simulator.getYLiquidity()).toBe(0n)    
    })

    it("fails to mint if lpMinted isn't sqrt(xIn*yIn)", () => {
        expect(() => simulator.initLiquidity({xIn: 1000n, yIn: 1000n, recipient: user1, lpMinted: 999n})).toThrow(/Unexpected lpMinted/)
        expect(() => simulator.initLiquidity({xIn: 1000n, yIn: 1000n, recipient: user1, lpMinted: 1001n})).toThrow(/Unexpected lpMinted/)
    })

    it("can init lp", () => {
        simulator.initLiquidity({xIn: 1000n, yIn: 1000n, recipient: user1})
    })

    it("getXLiquidity() returns 1000n", () => {
        expect(simulator.getXLiquidity()).toBe(1000n)
    })

    it("getYLiquidity() returns 1000n", () => {
        expect(simulator.getYLiquidity()).toBe(1000n)
    })

    it("fails to mint a second time", () => {
        expect(() => simulator.initLiquidity({xIn: 1000n, yIn: 1000n, recipient: user1})).toThrow(/Already initialized/)
    })

    it("lp is 1000n after init", () => {
        expect(simulator.getLPSupply()).toBe(1000n)
    })

    it("xLiquidity in reserves coin is 1000n", () => {
        expect(simulator.xReserves.value).toBe(1000n)
    })

    it("can add more liquidity", () => {
        simulator.addLiquidity({
            xIn: 900n,
            yIn: 900n,
            recipient: user2
        })
    })

    it("xLiquidity in reserves coin is 1900n", () => {
        expect(simulator.xReserves.value).toBe(1900n)
    })

    it("lp is 1900n after adding", () => {
        expect(simulator.getLPSupply()).toBe(1900n)
    })

    it("getXLiquidity() returns 1900n", () => {
        expect(simulator.getXLiquidity()).toBe(1900n)
    })

    it("getYLiquidity() returns 1900n", () => {
        expect(simulator.getYLiquidity()).toBe(1900n)
    })

    it("can remove some liquidity", () => {
        simulator.removeLiquidity({
            lpBurned: 500n,
            xOut: 500n,
            yOut: 500n,
            recipient: user2
        })
    })

    it("lp is 1400n after removing", () => {
        expect(simulator.getLPSupply()).toBe(1400n)
    })

    it("getXLiquidity() returns 1400n", () => {
        expect(simulator.getXLiquidity()).toBe(1400n)
    })

    it("getYLiquidity() returns 1400n", () => {
        expect(simulator.getYLiquidity()).toBe(1400n)
    })
})