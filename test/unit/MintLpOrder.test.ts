import { describe, expect, it } from "bun:test"
import {
  encodedMintLpAmmContractAddress,
  mintLpAmmClearOrderCircuitHash,
  mintLpAmmContractAddress,
  mintLpAmmFundOrderXCircuitHash,
  mintLpAmmFundOrderYCircuitHash,
  mintLpAmmPlaceOrderCircuitHash,
  mintLpOtherSecret,
  mintLpOtherUser,
  mintLpOwner,
  MintLpOrderSimulator,
  mintLpReturnedValue,
  mintLpReturnColor,
  mintLpXColor,
  mintLpXValue,
  mintLpYColor,
  mintLpYValue,
} from "./MintLpOrderSimulator"

describe("MintLpOrder", () => {
  it("rejects actions in the wrong state", () => {
    const simulator = new MintLpOrderSimulator()

    expect(() => simulator.sendToAmm()).toThrow(/Unexpected MarketOrder state/)
    expect(() => simulator.receiveFromAmm()).toThrow(/Unexpected MintLpOrder state/)
    expect(() => simulator.close()).toThrow(/Can only be performed by the order owner/)

    simulator.openOrder()
    expect(() => simulator.openOrder()).toThrow(/MintLpOrder state not empty/)
    expect(() => simulator.receiveFromAmm()).toThrow(/Unexpected MintLpOrder state/)
  })

  it("opens and sends both coins to the AMM", () => {
    const simulator = new MintLpOrderSimulator()
    simulator.openOrder()

    let ledger = simulator.currentLedger()
    expect(ledger.state).toBe(1)
    expect(ledger.order.xAmountSent).toBe(mintLpXValue)
    expect(ledger.order.yAmountSent).toBe(mintLpYValue)
    expect(ledger.order.xColorSent).toEqual(mintLpXColor)
    expect(ledger.order.yColorSent).toEqual(mintLpYColor)
    expect(ledger.order.colorReturned).toEqual(mintLpReturnColor)
    expect(ledger.order.returnsTo.bytes).toEqual(mintLpOwner.bytes)
    expect(ledger.order.amm.address.bytes).toEqual(encodedMintLpAmmContractAddress.bytes)
    expect(ledger.coins.lookup(0n).value).toBe(mintLpXValue)
    expect(ledger.coins.lookup(2n).value).toBe(mintLpYValue)

    const sent = simulator.sendToAmm()
    ledger = simulator.currentLedger()
    expect(ledger.state).toBe(4)
    expect(ledger.ammSlot).toBe(1n)
    expect(ledger.coins.isEmpty()).toBe(true)
    const hashes = sent.context.currentQueryContext.effects.claimedContractCalls.map(
      (call) => call[2],
    )
    expect(
      sent.context.currentQueryContext.effects.claimedContractCalls.every(
        (call) => call[1] === mintLpAmmContractAddress,
      ),
    ).toBe(true)
    expect(hashes).toContain(Buffer.from(mintLpAmmFundOrderYCircuitHash).toString("hex"))
    expect(Buffer.from(mintLpAmmPlaceOrderCircuitHash).length).toBe(32)
    expect(Buffer.from(mintLpAmmFundOrderXCircuitHash).length).toBe(32)
  })

  it("receives LP but close currently requires SentX state", () => {
    const simulator = new MintLpOrderSimulator()
    simulator.openOrder()
    simulator.sendToAmm()
    simulator.receiveFromAmm()

    expect(simulator.currentLedger().coins.lookup(0n).value).toBe(mintLpReturnedValue)
    expect(() => simulator.close({ sender: mintLpOtherUser, secret: mintLpOtherSecret })).toThrow(
      /Can only be performed by the order owner/,
    )
    expect(() => simulator.close()).toThrow(/Unexpected MintLpOrder state/)
    expect(Buffer.from(mintLpAmmClearOrderCircuitHash).length).toBe(32)
  })
})
