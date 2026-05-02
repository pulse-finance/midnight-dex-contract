import { describe, expect, it } from "bun:test"
import { treasury } from "./constants"
import { AmmSimulator } from "./AmmSimulator"

describe("liquidity init/add/remove without swaps", () => {
  const simulator = new AmmSimulator(treasury)

  it("fails to construct with a fee at or above 100%", () => {
    expect(() => new AmmSimulator(treasury, { fee: 10000n })).toThrow(/Fee too high/)
  })

  it("initializes xColor to 9999...", () => {
    const xColor = simulator.getXColor()

    expect(xColor.every((b) => b == 9))
  })

  it("initializes yColor to 10101010...", () => {
    const yColor = simulator.getYColor()

    expect(yColor.every((b) => b == 10))
  })

  it("initializes the fee to 10 bps", () => {
    expect(simulator.getFeeBps()).toBe(10n)
  })

  it("initializes LP supply to 0", () => {
    expect(simulator.getLPCirculatingSupply()).toBe(0n)
  })

  it("initializes X liquidity to 0", () => {
    expect(simulator.getXLiquidity()).toBe(0n)
  })

  it("initializes Y liquidity to 0", () => {
    expect(simulator.getYLiquidity()).toBe(0n)
  })

  it("rejects initial LP output above sqrt(xIn*yIn)", () => {
    expect(() => simulator.initLiquidity({ xIn: 1000n, yIn: 1000n, lpOut: 1002n })).toThrow(
      /Too many LP tokens taken/,
    )
  })

  it("can initialize liquidity", () => {
    simulator.initLiquidity({ xIn: 1000n, yIn: 1000n })
  })

  it("getXLiquidity() returns 1000n", () => {
    expect(simulator.getXLiquidity()).toBe(1000n)
  })

  it("getYLiquidity() returns 1000n", () => {
    expect(simulator.getYLiquidity()).toBe(1000n)
  })

  it("fails to mint a second time", () => {
    expect(() => simulator.initLiquidity({ xIn: 1000n, yIn: 1000n })).toThrow(/Already initialized/)
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

  it("can update the fee", () => {
    simulator.update({ fee: 20n, treasury })

    expect(simulator.getFeeBps()).toBe(20n)
  })

  it("LP supply is 1000n after initialization", () => {
    expect(simulator.getLPCirculatingSupply()).toBe(1000n)
  })

  it("xLiquidity in reserves coin is 1000n", () => {
    expect(simulator.xReserves.value).toBe(1000n)
  })

  it("can add balanced liquidity", () => {
    expect(() =>
      simulator.addLiquidity({
        xIn: 900n,
        yIn: 900n,
      }),
    ).not.toThrow()
  })

  it("X reserve coin increases after adding balanced liquidity", () => {
    expect(simulator.xReserves.value).toBe(1900n)
  })

  it("LP supply increases after adding balanced liquidity", () => {
    expect(simulator.getLPCirculatingSupply()).toBe(1900n)
  })

  it("X liquidity increases after adding balanced liquidity", () => {
    expect(simulator.getXLiquidity()).toBe(1900n)
  })

  it("Y liquidity increases after adding balanced liquidity", () => {
    expect(simulator.getYLiquidity()).toBe(1900n)
  })

  it("fails to remove liquidity if xOut is too high", () => {
    expect(() => {
      simulator.removeLiquidity({
        lpIn: 500n,
        xOut: 501n,
        yOut: 500n,
      })
    }).toThrow(/Too many X tokens taken/)
  })

  it("fails to remove liquidity if yOut is too high", () => {
    expect(() => {
      simulator.removeLiquidity({
        lpIn: 500n,
        xOut: 500n,
        yOut: 501n,
      })
    }).toThrow(/Too many Y tokens taken/)
  })

  it("can remove liquidity", () => {
    simulator.removeLiquidity({
      lpIn: 500n,
      xOut: 500n,
      yOut: 500n,
    })
  })

  it("LP supply decreases by the burned amount after removal", () => {
    expect(simulator.getLPCirculatingSupply()).toBe(1400n)
  })

  it("X liquidity decreases by the withdrawn amount after removal", () => {
    expect(simulator.getXLiquidity()).toBe(1400n)
  })

  it("Y liquidity decreases by the withdrawn amount after removal", () => {
    expect(simulator.getYLiquidity()).toBe(1400n)
  })
})

describe("init liquidity with an X to Y swap", () => {
  const simulator = new AmmSimulator(treasury)

  it("can initialize liquidity", () => {
    simulator.initLiquidity({ xIn: 1_000_000n, yIn: 2_000_000n })
  })

  it("fails to swap X to Y if fee is too low", () => {
    expect(() => {
      simulator.swapXToY({ xIn: 2000n, xFee: 1n })
    }).toThrow(/Fee too low/)
  })

  it("fails to swap X to Y if yOut is too high", () => {
    expect(() => {
      simulator.swapXToY({ xIn: 1000n, xFee: 1n, yOut: 1997n })
    }).toThrow(/Final k smaller than initial k/)
  })

  it("can swap X to Y", () => {
    simulator.swapXToY({ xIn: 1000n })
  })

  it("X liquidity includes the swap input less fees", () => {
    expect(simulator.getXLiquidity()).toBe(1_000_999n)
  })

  it("X rewards include the swap fee", () => {
    expect(simulator.getXRewards()).toBe(1n)
  })

  it("Y liquidity is reduced by the swap output", () => {
    expect(simulator.getYLiquidity()).toBe(1_998_004n)
  })

  it("can reward treasury", () => {
    simulator.rewardTreasury()

    expect(simulator.getXRewards()).toBe(0n)
  })
})

describe("init liquidity with an Y to X swap", () => {
  const simulator = new AmmSimulator(treasury)

  it("can initialize liquidity", () => {
    simulator.initLiquidity({ xIn: 1_000_000n, yIn: 2_000_000n })
  })

  it("fails to swap Y to X if fee is too low", () => {
    expect(() => {
      simulator.swapYToX({ yIn: 4000n, xFee: 1n })
    }).toThrow(/Fee too low/)
  })

  it("fails to swap Y to X if fee is too high", () => {
    expect(() => {
      simulator.swapYToX({ yIn: 2000n, xFee: 2n, xOut: 998n })
    }).toThrow(/Fee too high/)
  })

  it("can swap Y to X", () => {
    simulator.swapYToX({ yIn: 2000n })
  })

  it("Y liquidity includes the swap input", () => {
    expect(simulator.getYLiquidity()).toBe(2_002_000n)
  })

  it("X rewards include the swap fee", () => {
    expect(simulator.getXRewards()).toBe(1n)
  })

  it("X liquidity is reduced by output and fee", () => {
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

    simulator.initLiquidity({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    expect(() =>
      simulator.zapInX({
        xIn: 1000n,
        xSwap: 501n,
        xFee: 1n,
        ySwap: 999n,
        lpOut: 498n,
      }),
    ).not.toThrow()

    expect(simulator.getXLiquidity()).toBe(1_000_999n)
    expect(simulator.getYLiquidity()).toBe(2_000_000n)
    expect(simulator.getXRewards()).toBe(1n)
    expect(simulator.getLPCirculatingSupply()).toBe(1_000_498n)
  })

  it("can zap Y into LP", () => {
    const simulator = new AmmSimulator(treasury)

    simulator.initLiquidity({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    expect(() =>
      simulator.zapInY({
        yIn: 2000n,
        ySwap: 1002n,
        xFee: 1n,
        xSwap: 499n,
        lpOut: 498n,
      }),
    ).not.toThrow()

    expect(simulator.getXLiquidity()).toBe(999_999n)
    expect(simulator.getYLiquidity()).toBe(2_002_000n)
    expect(simulator.getXRewards()).toBe(1n)
    expect(simulator.getLPCirculatingSupply()).toBe(1_000_498n)
  })

  it("can zap LP out to X", () => {
    const simulator = new AmmSimulator(treasury)

    simulator.initLiquidity({
      xIn: 1_000_000n,
      yIn: 1_000_000n,
      lpOut: 1_000_000n,
    })
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

    simulator.initLiquidity({
      xIn: 1_000_000n,
      yIn: 1_000_000n,
      lpOut: 1_000_000n,
    })
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

    expect(() => simulator.validateSwapXToY({ xFee: 1n, yOut: 1n })).toThrow(/No active order/)
    expect(() => simulator.mintLp()).toThrow(/No active order/)
    expect(() => simulator.sendX()).toThrow(/No active order/)
    expect(() => simulator.sendY()).toThrow(/No active order/)
    expect(() => simulator.deactivateOrder()).toThrow(/No active order/)
  })

  it("rejects activating an unset order slot", () => {
    const simulator = initialized()

    expect(() => simulator.activateOrder(1n)).toThrow(/expected a cell, received null/)
  })

  it("rejects funding X for an unset order slot", () => {
    const simulator = initialized()

    expect(() => simulator.fundOrderX({ slot: 1n, amount: 100n })).toThrow(
      /expected a cell, received null/,
    )
  })

  it("rejects funding Y for an unset order slot", () => {
    const simulator = initialized()

    expect(() => simulator.fundOrderY({ slot: 1n, amount: 100n })).toThrow(
      /expected a cell, received null/,
    )
  })

  it("rejects funding LP for an unset order slot", () => {
    const simulator = initialized()

    expect(() => simulator.fundOrderLp({ slot: 1n, amount: 100n })).toThrow(
      /expected a cell, received null/,
    )
  })

  it("rejects paying X for an unset order slot", () => {
    const simulator = initialized()

    expect(() => simulator.payX(1n)).toThrow(/expected a cell, received null/)
  })

  it("rejects paying Y for an unset order slot", () => {
    const simulator = initialized()

    expect(() => simulator.payY(1n)).toThrow(/expected a cell, received null/)
  })

  it("rejects paying LP for an unset order slot", () => {
    const simulator = initialized()

    expect(() => simulator.payLp(1n)).toThrow(/expected a cell, received null/)
  })

  it("does not fail when clearing an unset order slot", () => {
    const simulator = initialized()

    expect(() => simulator.clearOrder(1n)).not.toThrow()
  })

  it("rejects new starts while a swap is pending", () => {
    const simulator = initialized()
    simulator.startSwapXToY({ xIn: 100n })

    expect(() => simulator.startDepositX({ xIn: 100n })).toThrow(/Order slot already occupied/)
    expect(() => simulator.startWithdrawXY({ lpIn: 100n })).toThrow(/Order slot already occupied/)
  })

  it("rejects two-sided deposit validation without a pending order", () => {
    const simulator = initialized()
    expect(() => simulator.validateDepositXY(1n)).toThrow(/No active order/)
  })

  it("rejects X zap-in validation without a pending order", () => {
    const simulator = initialized()
    expect(() => simulator.validateDepositX({ xSwap: 1n, xFee: 1n, ySwap: 1n, lpOut: 1n })).toThrow(
      /No active order/,
    )
  })

  it("rejects Y zap-in validation without a pending order", () => {
    const simulator = initialized()
    expect(() => simulator.validateDepositY({ ySwap: 1n, xFee: 1n, xSwap: 1n, lpOut: 1n })).toThrow(
      /No active order/,
    )
  })

  it("rejects Y-to-X swap validation without a pending order", () => {
    const simulator = initialized()
    expect(() => simulator.validateSwapYToX({ xFee: 1n, xOut: 1n })).toThrow(/No active order/)
  })

  it("rejects two-sided withdrawal validation without a pending order", () => {
    const simulator = initialized()
    expect(() => simulator.validateWithdrawXY({ xOut: 1n, yOut: 1n })).toThrow(/No active order/)
  })

  it("rejects X zap-out validation without a pending order", () => {
    const simulator = initialized()
    expect(() => simulator.validateWithdrawX({ xOut: 1n, ySwap: 1n, xFee: 1n, xSwap: 1n })).toThrow(
      /No active order/,
    )
  })

  it("rejects Y zap-out validation without a pending order", () => {
    const simulator = initialized()
    expect(() => simulator.validateWithdrawY({ yOut: 1n, xSwap: 1n, xFee: 1n, ySwap: 1n })).toThrow(
      /No active order/,
    )
  })

  it("rejects two-sided deposit start while a swap is pending", () => {
    const simulator = initialized()
    simulator.startSwapXToY({ xIn: 100n })
    expect(() => simulator.startDepositXY({ xIn: 100n, yIn: 100n })).toThrow(
      /Order slot already occupied/,
    )
  })

  it("rejects Y deposit start while a swap is pending", () => {
    const simulator = initialized()
    simulator.startSwapXToY({ xIn: 100n })
    expect(() => simulator.startDepositY({ yIn: 100n })).toThrow(/Order slot already occupied/)
  })

  it("rejects X-to-Y swap start while a deposit is pending", () => {
    const simulator = initialized()
    simulator.startDepositX({ xIn: 100n })
    expect(() => simulator.startSwapXToY({ xIn: 100n })).toThrow(/Order slot already occupied/)
  })

  it("rejects Y-to-X swap start while a deposit is pending", () => {
    const simulator = initialized()
    simulator.startDepositX({ xIn: 100n })
    expect(() => simulator.startSwapYToX({ yIn: 100n })).toThrow(/Order slot already occupied/)
  })

  it("rejects X withdrawal start while a deposit is pending", () => {
    const simulator = initialized()
    simulator.startDepositX({ xIn: 100n })
    expect(() => simulator.startWithdrawX({ lpIn: 100n })).toThrow(/Order slot already occupied/)
  })

  it("rejects Y withdrawal start while a deposit is pending", () => {
    const simulator = initialized()
    simulator.startDepositX({ xIn: 100n })
    expect(() => simulator.startWithdrawY({ lpIn: 100n })).toThrow(/Order slot already occupied/)
  })

  it("rejects two-sided deposits after all LP supply has been burned", () => {
    const simulator = initialized()
    simulator.removeLiquidity({ lpIn: 1000n, xOut: 999n, yOut: 999n })
    simulator.startDepositXY({ xIn: 100n, yIn: 100n })
    expect(() => simulator.validateDepositXY(1n)).toThrow(
      /Too many LP tokens taken \(bound by yIn\)/,
    )
  })

  it("rejects X deposits after all LP supply has been burned", () => {
    const simulator = initialized()
    simulator.removeLiquidity({ lpIn: 1000n, xOut: 999n, yOut: 999n })
    simulator.startDepositX({ xIn: 100n })
    expect(() =>
      simulator.validateDepositX({
        xSwap: 50n,
        xFee: 1n,
        ySwap: 1n,
        lpOut: 1n,
      }),
    ).toThrow(/result of subtraction would be negative/)
  })

  it("rejects Y deposits after all LP supply has been burned", () => {
    const simulator = initialized()
    simulator.removeLiquidity({ lpIn: 1000n, xOut: 999n, yOut: 999n })
    simulator.startDepositY({ yIn: 100n })
    expect(() =>
      simulator.validateDepositY({
        ySwap: 50n,
        xFee: 1n,
        xSwap: 1n,
        lpOut: 1n,
      }),
    ).toThrow(/result of subtraction would be negative/)
  })

  it("rejects finalizers and wrong swap validator for a pending X-to-Y swap", () => {
    const simulator = initialized()
    simulator.startSwapXToY({ xIn: 100n })

    expect(() => simulator.mintLp()).toThrow(/Active order isn't a deposit order/)
    expect(() => simulator.sendX()).toThrow(/Active order doesn't require X payment/)
    expect(() => simulator.sendY()).toThrow(/Unexpected active order state/)
    expect(() => simulator.deactivateOrder()).toThrow(/Unexpected order state/)
    expect(() => simulator.validateSwapYToX({ xFee: 1n, xOut: 1n })).toThrow(
      /Active order isn't a SwapYToX order/,
    )
  })

  it("rejects X-to-Y validation for a pending Y-to-X swap", () => {
    const simulator = initialized()
    simulator.startSwapYToX({ yIn: 100n })
    expect(() => simulator.validateSwapXToY({ xFee: 1n, yOut: 1n })).toThrow(
      /Active order isn't a SwapXToY order/,
    )
  })

  it("rejects non-swap validators for a pending X-to-Y swap", () => {
    const simulator = initialized()
    simulator.startSwapXToY({ xIn: 100n })

    expect(() => simulator.validateDepositXY(1n)).toThrow(
      /Pending order isn't a DepositXYLiq order/,
    )
    expect(() => simulator.validateDepositX({ xSwap: 1n, xFee: 1n, ySwap: 1n, lpOut: 1n })).toThrow(
      /Active order isn't a DepositXLiq order/,
    )
    expect(() => simulator.validateDepositY({ ySwap: 1n, xFee: 1n, xSwap: 1n, lpOut: 1n })).toThrow(
      /Active order isn't a DepositYLiq order/,
    )
    expect(() => simulator.validateWithdrawXY({ xOut: 1n, yOut: 1n })).toThrow(
      /Active order isn't a WithdrawXYLiq order/,
    )
    expect(() => simulator.validateWithdrawX({ xOut: 1n, ySwap: 1n, xFee: 1n, xSwap: 1n })).toThrow(
      /Active order isn't a WithdrawXLiq order/,
    )
    expect(() => simulator.validateWithdrawY({ yOut: 1n, xSwap: 1n, xFee: 1n, ySwap: 1n })).toThrow(
      /Active order isn't a WithdrawYLiq order/,
    )
  })

  it("rejects Y send finalization after validating a Y-to-X swap", () => {
    const simulator = initialized()
    simulator.startSwapYToX({ yIn: 100n })
    simulator.validateSwapYToX({ xFee: 1n, xOut: 89n })
    expect(() => simulator.sendY()).toThrow(/Active order doesn't require Y payment/)
  })

  it("rejects X send finalization after validating an X-to-Y swap", () => {
    const simulator = initialized()
    simulator.startSwapXToY({ xIn: 100n })
    simulator.validateSwapXToY({ xFee: 1n, yOut: 90n })
    expect(() => simulator.sendX()).toThrow(/Active order doesn't require X payment/)
  })

  it("requires deactivation after splitting an X-to-Y swap before payout", () => {
    const simulator = initialized()

    simulator.startSwapXToY({ xIn: 100n })
    simulator.validateSwapXToY({ xFee: 1n, yOut: 90n })
    simulator.sendY()

    expect(() => simulator.payY()).toThrow(/Unexpected amm order state/)
    expect(() => simulator.clearOrder()).toThrow(/Order not yet fully paid out/)

    simulator.deactivateOrder()

    expect(() => simulator.payY()).not.toThrow()
    expect(() => simulator.clearOrder()).not.toThrow()
  })

  it("requires deactivation after splitting a Y-to-X swap before payout", () => {
    const simulator = initialized()

    simulator.startSwapYToX({ yIn: 100n })
    simulator.validateSwapYToX({ xFee: 1n, xOut: 89n })
    simulator.sendX()

    expect(() => simulator.payX()).toThrow(/Unexpected amm order state/)
    expect(() => simulator.clearOrder()).toThrow(/Order not yet fully paid out/)

    simulator.deactivateOrder()

    expect(() => simulator.payX()).not.toThrow()
    expect(() => simulator.clearOrder()).not.toThrow()
  })

  it("requires X split before Y split on two-sided withdrawals", () => {
    const simulator = initialized()

    simulator.startWithdrawXY({ lpIn: 100n })
    simulator.validateWithdrawXY({ xOut: 100n, yOut: 100n })

    expect(() => simulator.sendY()).toThrow(/Must pay X before paying Y/)

    simulator.sendX()
    expect(() => simulator.sendY()).not.toThrow()
  })

  it("rejects excessive LP on two-sided deposits using the X bound", () => {
    const simulator = initialized()
    simulator.startDepositXY({ xIn: 100n, yIn: 200n })
    expect(() => simulator.validateDepositXY(101n)).toThrow(
      /Too many LP tokens taken \(bound by xIn\)/,
    )
  })

  it("rejects excessive LP on two-sided deposits using the Y bound", () => {
    const simulator = initialized()
    simulator.startDepositXY({ xIn: 200n, yIn: 100n })
    expect(() => simulator.validateDepositXY(101n)).toThrow(
      /Too many LP tokens taken \(bound by yIn\)/,
    )
  })

  it("rejects X zap-in validation with too little fee", () => {
    const simulator = initialized()
    simulator.startDepositX({ xIn: 1000n })
    expect(() =>
      simulator.validateDepositX({
        xSwap: 2000n,
        xFee: 1n,
        ySwap: 1n,
        lpOut: 1n,
      }),
    ).toThrow(/Fee too low/)
  })

  it("rejects X zap-in swaps that lower k", () => {
    const simulator = initialized()
    simulator.startDepositX({ xIn: 1000n })
    expect(() =>
      simulator.validateDepositX({
        xSwap: 500n,
        xFee: 1n,
        ySwap: 900n,
        lpOut: 1n,
      }),
    ).toThrow(/Post-swap k is lower than initial k/)
  })

  it("rejects X zap-in splits that are too X-heavy", () => {
    const simulator = initialized()
    simulator.startDepositX({ xIn: 1000n })
    expect(() => simulator.validateDepositX({ xSwap: 3n, xFee: 1n, ySwap: 1n, lpOut: 1n })).toThrow(
      /X zap-in split too X heavy/,
    )
  })

  it("rejects X zap-in splits that are too Y-heavy", () => {
    const simulator = initialized()
    simulator.startDepositX({ xIn: 1000n })
    expect(() =>
      simulator.validateDepositX({
        xSwap: 416n,
        xFee: 1n,
        ySwap: 293n,
        lpOut: 413n,
      }),
    ).toThrow(/X zap-in split too Y heavy/)
  })

  it("rejects excessive LP output for balanced X zap-in deposits", () => {
    const simulator = initialized({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    simulator.startDepositX({ xIn: 1000n })
    expect(() =>
      simulator.validateDepositX({
        xSwap: 501n,
        xFee: 1n,
        ySwap: 999n,
        lpOut: 499n,
      }),
    ).toThrow(/Too many LP tokens taken/)
  })

  it("rejects low Y zap-in fees", () => {
    const simulator = initialized()
    simulator.startDepositY({ yIn: 1000n })
    expect(() =>
      simulator.validateDepositY({
        ySwap: 500n,
        xFee: 1n,
        xSwap: 2000n,
        lpOut: 1n,
      }),
    ).toThrow(/Fee too low/)
  })

  it("rejects Y zap-in swaps that lower k", () => {
    const simulator = initialized()
    simulator.startDepositY({ yIn: 1000n })
    expect(() =>
      simulator.validateDepositY({
        ySwap: 500n,
        xFee: 1n,
        xSwap: 900n,
        lpOut: 1n,
      }),
    ).toThrow(/Post-swap k is lower than initial k/)
  })

  it("rejects Y-heavy Y zap-in splits", () => {
    const simulator = initialized()
    simulator.startDepositY({ yIn: 1000n })
    expect(() => simulator.validateDepositY({ ySwap: 3n, xFee: 1n, xSwap: 1n, lpOut: 2n })).toThrow(
      /Y zap-in split too Y heavy/,
    )
  })

  it("rejects X-heavy Y zap-in splits", () => {
    const simulator = initialized()
    simulator.startDepositY({ yIn: 1000n })
    expect(() =>
      simulator.validateDepositY({
        ySwap: 417n,
        xFee: 1n,
        xSwap: 293n,
        lpOut: 413n,
      }),
    ).toThrow(/Y zap-in split too X heavy/)
  })

  it("rejects excessive LP for balanced Y zap-in deposits", () => {
    const simulator = initialized({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    simulator.startDepositY({ yIn: 2000n })
    expect(() =>
      simulator.validateDepositY({
        ySwap: 1002n,
        xFee: 1n,
        xSwap: 499n,
        lpOut: 499n,
      }),
    ).toThrow(/Too many LP tokens minted \(bound by y\)/)
  })

  it("rejects excessive X removal on X zap-outs", () => {
    const simulator = initialized()
    simulator.startWithdrawX({ lpIn: 100n })
    expect(() =>
      simulator.validateWithdrawX({
        xOut: 101n,
        ySwap: 0n,
        xFee: 0n,
        xSwap: 0n,
      }),
    ).toThrow(/Too many X tokens taken/)
  })

  it("rejects excessive Y removal on X zap-outs", () => {
    const simulator = initialized()
    simulator.startWithdrawX({ lpIn: 100n })
    expect(() =>
      simulator.validateWithdrawX({
        xOut: 100n,
        ySwap: 101n,
        xFee: 0n,
        xSwap: 0n,
      }),
    ).toThrow(/Too many Y tokens taken/)
  })

  it("rejects low X zap-out fees", () => {
    const simulator = initialized()
    simulator.startWithdrawX({ lpIn: 100n })
    expect(() =>
      simulator.validateWithdrawX({
        xOut: 2100n,
        ySwap: 100n,
        xFee: 1n,
        xSwap: 2000n,
      }),
    ).toThrow(/Fee too low/)
  })

  it("rejects X zap-out swaps that lower k", () => {
    const simulator = initialized()
    simulator.startWithdrawX({ lpIn: 100n })
    expect(() =>
      simulator.validateWithdrawX({
        xOut: 200n,
        ySwap: 100n,
        xFee: 1n,
        xSwap: 100n,
      }),
    ).toThrow(/Post-swap k is lower than pre-swap k/)
  })

  it("rejects excessive X removal on Y zap-outs", () => {
    const simulator = initialized()
    simulator.startWithdrawY({ lpIn: 100n })
    expect(() =>
      simulator.validateWithdrawY({
        yOut: 0n,
        xSwap: 101n,
        xFee: 0n,
        ySwap: 0n,
      }),
    ).toThrow(/Too many X tokens taken/)
  })

  it("rejects excessive Y removal on Y zap-outs", () => {
    const simulator = initialized()
    simulator.startWithdrawY({ lpIn: 100n })
    expect(() =>
      simulator.validateWithdrawY({
        yOut: 101n,
        xSwap: 100n,
        xFee: 0n,
        ySwap: 0n,
      }),
    ).toThrow(/Too many Y tokens taken/)
  })

  it("rejects low Y zap-out fees", () => {
    const simulator = initialized({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    simulator.startWithdrawY({ lpIn: 2000n })
    expect(() =>
      simulator.validateWithdrawY({
        yOut: 4050n,
        xSwap: 2000n,
        xFee: 1n,
        ySwap: 50n,
      }),
    ).toThrow(/Fee too low/)
  })

  it("rejects Y zap-out swaps that lower k", () => {
    const simulator = initialized()
    simulator.startWithdrawY({ lpIn: 100n })
    expect(() =>
      simulator.validateWithdrawY({
        yOut: 200n,
        xSwap: 100n,
        xFee: 1n,
        ySwap: 100n,
      }),
    ).toThrow(/Post-swap k is lower than pre-swap k/)
  })

  it("accepts balanced X zap-in validation arguments", () => {
    const simulator = initialized({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    simulator.startDepositX({ xIn: 1000n })
    expect(() =>
      simulator.validateDepositX({
        xSwap: 501n,
        xFee: 1n,
        ySwap: 999n,
        lpOut: 498n,
      }),
    ).not.toThrow()
  })

  it("accepts balanced Y zap-in validation arguments", () => {
    const simulator = initialized({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    simulator.startDepositY({ yIn: 2000n })
    expect(() =>
      simulator.validateDepositY({
        ySwap: 1002n,
        xFee: 1n,
        xSwap: 499n,
        lpOut: 498n,
      }),
    ).not.toThrow()
  })

  it("allows an X-to-Y swap that produces no Y change", () => {
    const simulator = initialized({ xIn: 1n, yIn: 1n, lpOut: 1n })
    simulator.startSwapXToY({ xIn: 1n })
    expect(() => simulator.validateSwapXToY({ xFee: 1n, yOut: 0n })).not.toThrow()
    expect(() => simulator.sendY()).not.toThrow()
  })

  it("rejects X split when the reserve coin would have no change", () => {
    const simulator = initialized()
    simulator.startWithdrawXY({ lpIn: 1000n })
    simulator.validateWithdrawXY({ xOut: 1000n, yOut: 1000n })
    expect(() => simulator.sendX()).toThrow(/Some changes expected/)
  })

  it("surfaces map lookup failures when an X merge coin is missing", () => {
    const simulator = initialized()
    expect(() => simulator.mergeX()).toThrow(/expected a cell, received null/)
  })

  it("surfaces map lookup failures when a Y merge coin is missing", () => {
    const simulator = initialized()
    expect(() => simulator.mergeY()).toThrow(/expected a cell, received null/)
  })

  it("rejects overlarge X-to-Y swap fee arguments", () => {
    const simulator = initialized({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    simulator.startSwapXToY({ xIn: 1000n })
    expect(() => simulator.validateSwapXToY({ xFee: 1000n, yOut: 0n })).toThrow()
  })

  it("rejects X-to-Y swap output that is too small", () => {
    const simulator = initialized({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    simulator.startSwapXToY({ xIn: 1000n })
    expect(() => simulator.validateSwapXToY({ xFee: 1n, yOut: 0n })).toThrow(
      /Final k too large, yOut too small/,
    )
  })

  it("rejects too-small Y-to-X swap fee arguments", () => {
    const simulator = initialized({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    simulator.startSwapYToX({ yIn: 2000n })
    expect(() => simulator.validateSwapYToX({ xFee: 0n, xOut: 0n })).toThrow()
  })

  it("rejects Y-to-X swap output that is too small", () => {
    const simulator = initialized({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    simulator.startSwapYToX({ yIn: 2000n })
    expect(() => simulator.validateSwapYToX({ xFee: 1n, xOut: 0n })).toThrow(
      /Final k too large, not enough xOut/,
    )
  })

  it("rejects zero LP output for two-sided deposits", () => {
    const simulator = initialized({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    simulator.startDepositXY({ xIn: 1000n, yIn: 1000n })
    expect(() => simulator.validateDepositXY(0n)).toThrow(/Too little LP tokens minted/)
  })

  it("rejects overlarge X zap-in fee arguments", () => {
    const simulator = initialized({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    simulator.startDepositX({ xIn: 1000n })
    expect(() =>
      simulator.validateDepositX({
        xSwap: 1000n,
        xFee: 1000n,
        ySwap: 0n,
        lpOut: 0n,
      }),
    ).toThrow(/Fee too high/)
  })

  it("rejects X zap-in output arguments that over-preserve k", () => {
    const simulator = initialized({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    simulator.startDepositX({ xIn: 1000n })
    expect(() =>
      simulator.validateDepositX({
        xSwap: 1000n,
        xFee: 1n,
        ySwap: 0n,
        lpOut: 0n,
      }),
    ).toThrow(/Post-swap k is too high/)
  })

  it("rejects zero-swap X zap-in arguments", () => {
    const simulator = initialized({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    simulator.startDepositX({ xIn: 1000n })
    expect(() =>
      simulator.validateDepositX({ xSwap: 0n, xFee: 0n, ySwap: 0n, lpOut: 0n }),
    ).toThrow()
  })

  it("rejects Y zap-in zero-output arguments", () => {
    const simulator = initialized({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    simulator.startDepositY({ yIn: 2000n })
    expect(() =>
      simulator.validateDepositY({
        ySwap: 2000n,
        xFee: 0n,
        xSwap: 0n,
        lpOut: 0n,
      }),
    ).toThrow()
  })

  it("rejects Y zap-in output arguments that over-preserve k", () => {
    const simulator = initialized({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    simulator.startDepositY({ yIn: 2000n })
    expect(() =>
      simulator.validateDepositY({
        ySwap: 2000n,
        xFee: 1n,
        xSwap: 1n,
        lpOut: 0n,
      }),
    ).toThrow(/Post-swap k is too high/)
  })

  it("rejects zero-swap Y zap-in arguments", () => {
    const simulator = initialized({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    simulator.startDepositY({ yIn: 2000n })
    expect(() =>
      simulator.validateDepositY({ ySwap: 0n, xFee: 0n, xSwap: 0n, lpOut: 0n }),
    ).toThrow()
  })

  it("rejects zero-output two-sided withdrawals", () => {
    const simulator = initialized({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    simulator.startWithdrawXY({ lpIn: 1000n })
    expect(() => simulator.validateWithdrawXY({ xOut: 0n, yOut: 0n })).toThrow(
      /Not enough|Now enough/,
    )
  })

  it("rejects zero-output X zap-out arguments", () => {
    const simulator = initialized({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    simulator.startWithdrawX({ lpIn: 1000n })
    expect(() =>
      simulator.validateWithdrawX({ xOut: 0n, ySwap: 0n, xFee: 0n, xSwap: 0n }),
    ).toThrow()
  })

  it("rejects X zap-out arguments that over-preserve k", () => {
    const simulator = initialized({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    simulator.startWithdrawX({ lpIn: 1000n })
    expect(() =>
      simulator.validateWithdrawX({
        xOut: 1001n,
        ySwap: 2000n,
        xFee: 1n,
        xSwap: 1n,
      }),
    ).toThrow(/Post-swap k is too high/)
  })

  it("rejects X zap-out arguments that omit Y removal", () => {
    const simulator = initialized({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    simulator.startWithdrawX({ lpIn: 1000n })
    expect(() =>
      simulator.validateWithdrawX({
        xOut: 1000n,
        ySwap: 0n,
        xFee: 0n,
        xSwap: 0n,
      }),
    ).toThrow(/Not enough Y/)
  })

  it("rejects zero-output Y zap-out arguments", () => {
    const simulator = initialized({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    simulator.startWithdrawY({ lpIn: 1000n })
    expect(() =>
      simulator.validateWithdrawY({ yOut: 0n, xSwap: 0n, xFee: 0n, ySwap: 0n }),
    ).toThrow()
  })

  it("rejects Y zap-out arguments that over-preserve k", () => {
    const simulator = initialized({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    simulator.startWithdrawY({ lpIn: 1000n })
    expect(() =>
      simulator.validateWithdrawY({
        yOut: 2001n,
        xSwap: 1000n,
        xFee: 1n,
        ySwap: 1n,
      }),
    ).toThrow(/Post-swap k is too high/)
  })

  it("rejects Y zap-out arguments that omit X removal", () => {
    const simulator = initialized({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    simulator.startWithdrawY({ lpIn: 1000n })
    expect(() =>
      simulator.validateWithdrawY({
        yOut: 2000n,
        xSwap: 0n,
        xFee: 0n,
        ySwap: 0n,
      }),
    ).toThrow(/Too few X/)
  })
})

describe("zero-fee pools", () => {
  it("allows valid zero-fee X-to-Y swaps and rejects positive fees", () => {
    const simulator = new AmmSimulator(treasury, { fee: 0n })

    simulator.initLiquidity({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    simulator.startSwapXToY({ xIn: 1000n })
    expect(() => simulator.validateSwapXToY({ xFee: 0n, yOut: 1998n })).not.toThrow()

    const invalid = new AmmSimulator(treasury, { fee: 0n })
    invalid.initLiquidity({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    invalid.startSwapXToY({ xIn: 1000n })
    expect(() => invalid.validateSwapXToY({ xFee: 1n, yOut: 1998n })).toThrow(/Fee too high/)
  })

  it("allows valid zero-fee Y-to-X swaps and rejects positive fees", () => {
    const simulator = new AmmSimulator(treasury, { fee: 0n })

    simulator.initLiquidity({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    simulator.startSwapYToX({ yIn: 2000n })
    expect(() => simulator.validateSwapYToX({ xFee: 0n, xOut: 999n })).not.toThrow()

    const invalid = new AmmSimulator(treasury, { fee: 0n })
    invalid.initLiquidity({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    invalid.startSwapYToX({ yIn: 2000n })
    expect(() => invalid.validateSwapYToX({ xFee: 1n, xOut: 998n })).toThrow(/Fee too high/)
  })

  it("rejects positive xFee for zero-fee zap and withdrawal validators", () => {
    const depositX = new AmmSimulator(treasury, { fee: 0n })
    depositX.initLiquidity({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    depositX.startDepositX({ xIn: 1000n })
    expect(() =>
      depositX.validateDepositX({
        xSwap: 500n,
        xFee: 1n,
        ySwap: 999n,
        lpOut: 498n,
      }),
    ).toThrow(/Fee too high/)

    const depositY = new AmmSimulator(treasury, { fee: 0n })
    depositY.initLiquidity({
      xIn: 1_000_000n,
      yIn: 2_000_000n,
      lpOut: 1_000_000n,
    })
    depositY.startDepositY({ yIn: 2000n })
    expect(() =>
      depositY.validateDepositY({
        ySwap: 1002n,
        xFee: 1n,
        xSwap: 499n,
        lpOut: 498n,
      }),
    ).toThrow(/Fee too high/)

    const withdrawX = new AmmSimulator(treasury, { fee: 0n })
    withdrawX.initLiquidity({
      xIn: 1_000_000n,
      yIn: 1_000_000n,
      lpOut: 1_000_000n,
    })
    withdrawX.startWithdrawX({ lpIn: 1000n })
    expect(() =>
      withdrawX.validateWithdrawX({
        xOut: 1998n,
        ySwap: 1000n,
        xFee: 1n,
        xSwap: 998n,
      }),
    ).toThrow(/Fee too high/)

    const withdrawY = new AmmSimulator(treasury, { fee: 0n })
    withdrawY.initLiquidity({
      xIn: 1_000_000n,
      yIn: 1_000_000n,
      lpOut: 1_000_000n,
    })
    withdrawY.startWithdrawY({ lpIn: 1000n })
    expect(() =>
      withdrawY.validateWithdrawY({
        yOut: 1997n,
        xSwap: 999n,
        xFee: 1n,
        ySwap: 998n,
      }),
    ).toThrow(/Fee too high/)
  })
})
