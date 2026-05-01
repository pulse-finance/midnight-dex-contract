import { encodeContractAddress } from "@midnight-ntwrk/compact-runtime"

import {
  AMM_FEE_BPS,
  BURN_LP_IN,
  GENESIS_SEED_HEX,
  INITIAL_X_LIQ,
  INITIAL_Y_LIQ,
  MINT_LP_X_IN,
  MINT_LP_Y_IN,
  ORDER_OWNER_SECRET,
  SWAP_X_IN,
  SWAP_Y_IN,
  X_TOKEN_NAME,
  Y_TOKEN_NAME,
  ZAP_IN_X_IN,
  ZAP_IN_Y_IN,
  ZAP_OUT_X_LP_IN,
  ZAP_OUT_Y_LP_IN,
} from "./Constants"
import * as Amm from "./Contracts/Amm"
import * as BurnLpOrder from "./Contracts/BurnLpOrder"
import * as Faucet from "./Contracts/Faucet"
import * as MarketOrder from "./Contracts/MarketOrder"
import * as MintLpOrder from "./Contracts/MintLpOrder"
import * as Wallet from "./Wallet"
import { makeShieldedUserAddress } from "./integ-support"
import { makeMidnightProviders } from "./Providers/MidnightProviders"

import * as mintLpOrderModule from "../../dist/mintlporder/contract"
import * as burnLpOrderModule from "../../dist/burnlporder/contract"
import * as marketOrderModule from "../../dist/marketorder/contract"
import { fromHex } from "@midnight-ntwrk/midnight-js-utils"

type OwnerSecretContext = { privateState: undefined }
type OwnerSecretWitnesses = {
  newNonce(context: OwnerSecretContext): [undefined, Uint8Array]
  ownerSecret(context: OwnerSecretContext): [undefined, Uint8Array]
}
type OwnerCommitmentContract = {
  _persistentHash_1(value: [Uint8Array, Uint8Array]): Uint8Array
}
type OwnerCommitmentModule = {
  Contract: new (witnesses: OwnerSecretWitnesses) => unknown
}

function deterministicNonce(index: number): Uint8Array {
  const bytes = new Uint8Array(32)
  bytes[30] = (index >> 8) & 0xff
  bytes[31] = index & 0xff
  return bytes
}

function calcSwapXToY(
  state: Pick<Amm.Parameters, "feeBps" | "xLiquidity" | "yLiquidity">,
  xIn: bigint,
) {
  const xFee = (xIn * state.feeBps + 9999n) / 10000n
  const yOut =
    state.yLiquidity -
    (state.xLiquidity * state.yLiquidity + (state.xLiquidity + xIn - xFee) - 1n) /
      (state.xLiquidity + xIn - xFee)
  return { xFee, yOut }
}

function calcSwapYToX(
  state: Pick<Amm.Parameters, "feeBps" | "xLiquidity" | "yLiquidity">,
  yIn: bigint,
) {
  const xOutAndFee =
    state.xLiquidity -
    (state.xLiquidity * state.yLiquidity + (state.yLiquidity + yIn) - 1n) / (state.yLiquidity + yIn)
  const xOut = (xOutAndFee * (10000n - state.feeBps)) / 10000n
  const xFee = xOutAndFee - xOut
  return { xFee, xOut }
}

function calcLpOut(state: Amm.Parameters, xIn: bigint, yIn: bigint) {
  const byX = (xIn * state.lpCirculatingSupply) / state.xLiquidity
  const byY = (yIn * state.lpCirculatingSupply) / state.yLiquidity
  return byX < byY ? byX : byY
}

function calcWithdrawXY(state: Amm.Parameters, lpIn: bigint) {
  return {
    xOut: (lpIn * state.xLiquidity) / state.lpCirculatingSupply,
    yOut: (lpIn * state.yLiquidity) / state.lpCirculatingSupply,
  }
}

function findZapInX(state: Amm.Parameters, xIn: bigint) {
  for (let xSwap = 1n; xSwap < xIn; xSwap += 1n) {
    const { xFee, yOut: ySwap } = calcSwapXToY(state, xSwap)
    const xLiqAfterSwap = state.xLiquidity + xSwap - xFee
    const yLiqAfterSwap = state.yLiquidity - ySwap
    const xAdded = xIn - xSwap
    const yAdded = ySwap
    if (
      xAdded * yLiqAfterSwap > yAdded * xLiqAfterSwap ||
      (xAdded + 1n) * yLiqAfterSwap < yAdded * xLiqAfterSwap
    ) {
      continue
    }
    const lpOut = (xAdded * state.lpCirculatingSupply) / xLiqAfterSwap
    if (
      lpOut * xLiqAfterSwap <= xAdded * state.lpCirculatingSupply &&
      (lpOut + 1n) * xLiqAfterSwap >= xAdded * state.lpCirculatingSupply
    ) {
      return { xSwap, xFee, ySwap, lpOut }
    }
  }
  throw new Error("Failed to derive X zap-in validation args")
}

function findZapInY(state: Amm.Parameters, yIn: bigint) {
  for (let ySwap = 1n; ySwap < yIn; ySwap += 1n) {
    const { xFee, xOut: xSwap } = calcSwapYToX(state, ySwap)
    const xLiqAfterSwap = state.xLiquidity - xSwap - xFee
    const yLiqAfterSwap = state.yLiquidity + ySwap
    const xAdded = xSwap
    const yAdded = yIn - ySwap
    if (
      yAdded * xLiqAfterSwap > xAdded * yLiqAfterSwap ||
      (yAdded + 1n) * xLiqAfterSwap < xAdded * yLiqAfterSwap
    ) {
      continue
    }
    const lpOut = (yAdded * state.lpCirculatingSupply) / yLiqAfterSwap
    if (
      lpOut * yLiqAfterSwap <= yAdded * state.lpCirculatingSupply &&
      (lpOut + 1n) * yLiqAfterSwap >= yAdded * state.lpCirculatingSupply
    ) {
      return { ySwap, xFee, xSwap, lpOut }
    }
  }
  throw new Error("Failed to derive Y zap-in validation args")
}

function findZapOutX(state: Amm.Parameters, lpIn: bigint) {
  const maxX = (lpIn * state.xLiquidity) / state.lpCirculatingSupply + 1n
  const maxY = (lpIn * state.yLiquidity) / state.lpCirculatingSupply + 1n
  for (let xRemoved = 0n; xRemoved <= maxX; xRemoved += 1n) {
    for (let yRemoved = 0n; yRemoved <= maxY; yRemoved += 1n) {
      if (
        xRemoved * state.lpCirculatingSupply > lpIn * state.xLiquidity ||
        (xRemoved + 1n) * state.lpCirculatingSupply < lpIn * state.xLiquidity ||
        yRemoved * state.lpCirculatingSupply > lpIn * state.yLiquidity ||
        (yRemoved + 1n) * state.lpCirculatingSupply < lpIn * state.yLiquidity
      ) {
        continue
      }
      const reduced = {
        ...state,
        xLiquidity: state.xLiquidity - xRemoved,
        yLiquidity: state.yLiquidity - yRemoved,
      }
      const { xFee, xOut: xSwap } = calcSwapYToX(reduced, yRemoved)
      return { xOut: xRemoved + xSwap, ySwap: yRemoved, xFee, xSwap }
    }
  }
  throw new Error("Failed to derive X zap-out validation args")
}

function findZapOutY(state: Amm.Parameters, lpIn: bigint) {
  const maxX = (lpIn * state.xLiquidity) / state.lpCirculatingSupply + 1n
  const maxY = (lpIn * state.yLiquidity) / state.lpCirculatingSupply + 1n
  for (let xRemoved = 0n; xRemoved <= maxX; xRemoved += 1n) {
    for (let yRemoved = 0n; yRemoved <= maxY; yRemoved += 1n) {
      if (
        xRemoved * state.lpCirculatingSupply > lpIn * state.xLiquidity ||
        (xRemoved + 1n) * state.lpCirculatingSupply < lpIn * state.xLiquidity ||
        yRemoved * state.lpCirculatingSupply > lpIn * state.yLiquidity ||
        (yRemoved + 1n) * state.lpCirculatingSupply < lpIn * state.yLiquidity
      ) {
        continue
      }
      const reduced = {
        ...state,
        xLiquidity: state.xLiquidity - xRemoved,
        yLiquidity: state.yLiquidity - yRemoved,
      }
      const { xFee, yOut: ySwap } = calcSwapXToY(reduced, xRemoved)
      return { yOut: yRemoved + ySwap, xSwap: xRemoved, xFee, ySwap }
    }
  }
  throw new Error("Failed to derive Y zap-out validation args")
}

function applyInit(state: Amm.Parameters, xIn: bigint, yIn: bigint) {
  const lpOut = BigInt(Math.floor(Math.sqrt(Number(xIn) * Number(yIn))))
  return {
    ...state,
    xLiquidity: state.xLiquidity + xIn,
    yLiquidity: state.yLiquidity + yIn,
    lpCirculatingSupply: state.lpCirculatingSupply + lpOut,
  }
}

function computeOwnerCommitment(contractModule: OwnerCommitmentModule, contractAddress: string) {
  const contract = new contractModule.Contract({
    newNonce: (context) => [context.privateState, deterministicNonce(999)],
    ownerSecret: (context) => [context.privateState, ORDER_OWNER_SECRET],
  }) as OwnerCommitmentContract
  return contract._persistentHash_1([encodeContractAddress(contractAddress), ORDER_OWNER_SECRET])
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

async function main() {
  console.log("[integ] Creating genesis wallet")
  const wallet = await Wallet.makeContext(GENESIS_SEED_HEX)
  const providers = makeMidnightProviders(wallet)
  const walletPublicKey = fromHex(providers.walletProvider.getCoinPublicKey())
  const walletAddress = makeShieldedUserAddress(walletPublicKey)

  console.log("[integ] Deploying faucet")
  const faucet = await Faucet.make(providers)

  console.log("[integ] Minting X tokens from faucet")
  await faucet.mintShielded(
    X_TOKEN_NAME,
    INITIAL_X_LIQ + MINT_LP_X_IN + SWAP_X_IN + ZAP_IN_X_IN,
    deterministicNonce(1),
    walletAddress,
  )
  const xColor = faucet.color(X_TOKEN_NAME)

  console.log("[integ] Mining Y tokens from faucet")
  await faucet.mintShielded(
    Y_TOKEN_NAME,
    INITIAL_Y_LIQ + MINT_LP_Y_IN + SWAP_Y_IN + ZAP_IN_Y_IN,
    deterministicNonce(2),
    walletAddress,
  )
  const yColor = faucet.color(Y_TOKEN_NAME)

  console.log("[integ] Deploying AMM")
  const amm = await Amm.make({ xColor, yColor, treasury: walletAddress }, providers)
  const deployedAmmState = await providers.publicDataProvider.queryContractState(amm.address)
  assert(deployedAmmState, `Missing AMM state for ${amm.address}`)
  for (const operation of Amm.CircuitNames) {
    assert(deployedAmmState.operation(operation) != null, `Missing AMM operation ${operation}`)
  }

  console.log("[integ] Initializing AMM liquidity")
  const initLpOut = Amm.calcInitLpOut(INITIAL_X_LIQ, INITIAL_Y_LIQ)
  await amm.initXYLiq(INITIAL_X_LIQ, INITIAL_Y_LIQ, initLpOut, walletAddress)

  let ammLedger = await amm.state()
  assertEqual(ammLedger.xLiquidity, INITIAL_X_LIQ, "Unexpected initial X liquidity")
  assertEqual(ammLedger.yLiquidity, INITIAL_Y_LIQ, "Unexpected initial Y liquidity")
  assertEqual(ammLedger.lpCirculatingSupply, initLpOut, "Unexpected initial LP supply")

  let expected: Amm.Parameters = applyInit(
    {
      feeBps: AMM_FEE_BPS,
      xLiquidity: 0n,
      yLiquidity: 0n,
      xRewards: 0n,
      lpCirculatingSupply: 0n,
    },
    INITIAL_X_LIQ,
    INITIAL_Y_LIQ,
  )

  console.log("[integ] Deploying MintLpOrder contract")
  const mintLpOrder = await MintLpOrder.make({ privateStateId: "mint-lp-order-1" }, providers)

  console.log("[integ] Deploying BurnLpOrder contract")
  const burnLpOrder = await BurnLpOrder.make({ privateStateId: "burn-lp-order-1" }, providers)

  console.log("[integ] Place mint order")
  await mintLpOrder.open({
    ownerCommitment: computeOwnerCommitment(mintLpOrderModule, mintLpOrder.address),
    amm: amm.circuitIds("AmmFundOrderX", "AmmFundOrderY"),
    xAmountSent: MINT_LP_X_IN,
    yAmountSent: MINT_LP_Y_IN,
    xColorSent: xColor,
    yColorSent: yColor,
    colorReturned: amm.lpColor,
    returnsTo: { bytes: walletPublicKey },
  })

  console.log("[integ] Reserve amm slot for mint order")
  const mintSlot = 1n
  await mintLpOrder.reserveAmmSlot(amm, mintSlot, MINT_LP_X_IN, MINT_LP_Y_IN)

  console.log("[integ] Sending X coin from MintLpOrder to Amm")
  await mintLpOrder.sendXCoinToAmm(amm, mintSlot)

  await mintLpOrder.sendYCoinToAmm(amm, mintSlot)

  const mintLpOut = calcLpOut(expected, MINT_LP_X_IN, MINT_LP_Y_IN)
  await amm.activateOrder(mintSlot)
  await amm.validateDepositXYLiq(mintLpOut)
  await amm.mintLp()
  await mintLpOrder.receiveFromAmm(amm, mintSlot, BigInt(MarketOrder.ReturnKind.Lp), mintLpOut)

  expected = {
    ...expected,
    xLiquidity: expected.xLiquidity + MINT_LP_X_IN,
    yLiquidity: expected.yLiquidity + MINT_LP_Y_IN,
    lpCirculatingSupply: expected.lpCirculatingSupply + mintLpOut,
  }
  ammLedger = await amm.state()
  assertEqual(ammLedger.xLiquidity, expected.xLiquidity, "Unexpected X liquidity after mint LP")
  assertEqual(ammLedger.yLiquidity, expected.yLiquidity, "Unexpected Y liquidity after mint LP")
  assertEqual(
    ammLedger.lpCirculatingSupply,
    expected.lpCirculatingSupply,
    "Unexpected LP supply after mint LP",
  )
  assertEqual(
    (await mintLpOrder.state()).ammSlot,
    mintSlot,
    "Mint LP order should retain its AMM slot before close",
  )

  console.log("[integ] Running burn LP order flow")
  const burnSlot = 2n
  const { xOut: burnXOut, yOut: burnYOut } = calcWithdrawXY(expected, BURN_LP_IN)
  await burnLpOrder.open({
    ownerCommitment: computeOwnerCommitment(burnLpOrderModule, burnLpOrder.address),
    amm: amm.circuitIds("AmmFundOrderLp"),
    amountSent: BURN_LP_IN,
    colorSent: amm.lpColor,
    xColorReturned: xColor,
    yColorReturned: yColor,
    returnsTo: { bytes: walletPublicKey },
  })
  await burnLpOrder.reserveAmmSlot(amm, burnSlot, Amm.OrderKind.WithdrawXYLiq, BURN_LP_IN, 0n)
  await burnLpOrder.sendCoinToAmm(amm, burnSlot)
  await amm.activateOrder(burnSlot)
  await amm.validateWithdrawXYLiq(burnXOut, burnYOut)
  await amm.splitX()
  await amm.splitY()
  await burnLpOrder.receiveXCoinFromAmm(amm, burnSlot, BurnLpOrder.ReturnKind.X, burnXOut)
  await burnLpOrder.receiveYCoinFromAmm(amm, burnSlot, BurnLpOrder.ReturnKind.Y, burnYOut)
  await burnLpOrder.closeX(amm, burnSlot)
  await burnLpOrder.closeY()

  expected = {
    ...expected,
    xLiquidity: expected.xLiquidity - burnXOut,
    yLiquidity: expected.yLiquidity - burnYOut,
    lpCirculatingSupply: expected.lpCirculatingSupply - BURN_LP_IN,
  }

  console.log("[integ] Running market order case swap-x-to-y")
  {
    const label = "swap-x-to-y"
    const slot = 3n
    const swapX = calcSwapXToY(expected, SWAP_X_IN)
    const marketOrder = await MarketOrder.make(
      { privateStateId: `market-order-${label}` },
      providers,
    )
    await marketOrder.open({
      ownerCommitment: computeOwnerCommitment(marketOrderModule, marketOrder.address),
      amm: amm.circuitIds("AmmFundOrderX"),
      kind: Amm.OrderKind.SwapXToY,
      amountSent: SWAP_X_IN,
      colorSent: xColor,
      colorReturned: yColor,
      returnsTo: { bytes: walletPublicKey },
    })
    await marketOrder.reserveAmmSlot(amm, slot, Amm.OrderKind.SwapXToY, SWAP_X_IN, 0n)
    await marketOrder.sendCoinToAmm(amm, "AmmFundOrderX", slot)
    await amm.activateOrder(slot)
    await amm.validateSwapXToY(swapX.xFee, swapX.yOut)
    await amm.splitY()
    await marketOrder.receiveCoinFromAmm(amm, "AmmPayY", slot, MarketOrder.ReturnKind.Y, swapX.yOut)
    await marketOrder.close(amm, slot)
    expected = {
      ...expected,
      xLiquidity: expected.xLiquidity + SWAP_X_IN - swapX.xFee,
      yLiquidity: expected.yLiquidity - swapX.yOut,
      xRewards: expected.xRewards + swapX.xFee,
    }
    assert(!(await marketOrder.state()).coins.member(0n), `${label} market order should be closed`)
  }

  const swapY = calcSwapYToX(expected, SWAP_Y_IN)
  console.log("[integ] Running market order case swap-y-to-x")
  {
    const label = "swap-y-to-x"
    const slot = 4n
    const marketOrder = await MarketOrder.make(
      { privateStateId: `market-order-${label}` },
      providers,
    )
    await marketOrder.open({
      ownerCommitment: computeOwnerCommitment(marketOrderModule, marketOrder.address),
      amm: amm.circuitIds("AmmFundOrderY"),
      kind: Amm.OrderKind.SwapYToX,
      amountSent: SWAP_Y_IN,
      colorSent: yColor,
      colorReturned: xColor,
      returnsTo: { bytes: walletPublicKey },
    })
    await marketOrder.reserveAmmSlot(amm, slot, Amm.OrderKind.SwapYToX, 0n, SWAP_Y_IN)
    await marketOrder.sendCoinToAmm(amm, "AmmFundOrderY", slot)
    await amm.activateOrder(slot)
    await amm.validateSwapYToX(swapY.xFee, swapY.xOut)
    await amm.splitX()
    await marketOrder.receiveCoinFromAmm(amm, "AmmPayX", slot, MarketOrder.ReturnKind.X, swapY.xOut)
    await marketOrder.close(amm, slot)
    expected = {
      ...expected,
      xLiquidity: expected.xLiquidity - swapY.xOut - swapY.xFee,
      yLiquidity: expected.yLiquidity + SWAP_Y_IN,
      xRewards: expected.xRewards + swapY.xFee,
    }
    assert(!(await marketOrder.state()).coins.member(0n), `${label} market order should be closed`)
  }

  const zapInX = findZapInX(expected, ZAP_IN_X_IN)
  console.log("[integ] Running market order case zap-in-x")
  {
    const label = "zap-in-x"
    const slot = 5n
    const marketOrder = await MarketOrder.make(
      { privateStateId: `market-order-${label}` },
      providers,
    )
    await marketOrder.open({
      ownerCommitment: computeOwnerCommitment(marketOrderModule, marketOrder.address),
      amm: amm.circuitIds("AmmFundOrderX"),
      kind: Amm.OrderKind.DepositXLiq,
      amountSent: ZAP_IN_X_IN,
      colorSent: xColor,
      colorReturned: amm.lpColor,
      returnsTo: { bytes: walletPublicKey },
    })
    await marketOrder.reserveAmmSlot(amm, slot, Amm.OrderKind.DepositXLiq, ZAP_IN_X_IN, 0n)
    await marketOrder.sendCoinToAmm(amm, "AmmFundOrderX", slot)
    await amm.activateOrder(slot)
    await amm.validateDepositXLiq(zapInX.xSwap, zapInX.xFee, zapInX.ySwap, zapInX.lpOut)
    await amm.mintLp()
    await marketOrder.receiveCoinFromAmm(
      amm,
      "AmmPayLp",
      slot,
      MarketOrder.ReturnKind.Lp,
      zapInX.lpOut,
    )
    await marketOrder.close(amm, slot)
    expected = {
      ...expected,
      xLiquidity: expected.xLiquidity + ZAP_IN_X_IN - zapInX.xFee,
      yLiquidity: expected.yLiquidity,
      xRewards: expected.xRewards + zapInX.xFee,
      lpCirculatingSupply: expected.lpCirculatingSupply + zapInX.lpOut,
    }
    assert(!(await marketOrder.state()).coins.member(0n), `${label} market order should be closed`)
  }

  const zapInY = findZapInY(expected, ZAP_IN_Y_IN)
  console.log("[integ] Running market order case zap-in-y")
  {
    const label = "zap-in-y"
    const slot = 6n
    const marketOrder = await MarketOrder.make(
      { privateStateId: `market-order-${label}` },
      providers,
    )
    await marketOrder.open({
      ownerCommitment: computeOwnerCommitment(marketOrderModule, marketOrder.address),
      amm: amm.circuitIds("AmmFundOrderY"),
      kind: Amm.OrderKind.DepositYLiq,
      amountSent: ZAP_IN_Y_IN,
      colorSent: yColor,
      colorReturned: amm.lpColor,
      returnsTo: { bytes: walletPublicKey },
    })
    await marketOrder.reserveAmmSlot(amm, slot, Amm.OrderKind.DepositYLiq, 0n, ZAP_IN_Y_IN)
    await marketOrder.sendCoinToAmm(amm, "AmmFundOrderY", slot)
    await amm.activateOrder(slot)
    await amm.validateDepositYLiq(zapInY.ySwap, zapInY.xFee, zapInY.xSwap, zapInY.lpOut)
    await amm.mintLp()
    await marketOrder.receiveCoinFromAmm(
      amm,
      "AmmPayLp",
      slot,
      MarketOrder.ReturnKind.Lp,
      zapInY.lpOut,
    )
    await marketOrder.close(amm, slot)
    expected = {
      ...expected,
      xLiquidity: expected.xLiquidity - zapInY.xFee,
      yLiquidity: expected.yLiquidity + ZAP_IN_Y_IN,
      xRewards: expected.xRewards + zapInY.xFee,
      lpCirculatingSupply: expected.lpCirculatingSupply + zapInY.lpOut,
    }
    assert(!(await marketOrder.state()).coins.member(0n), `${label} market order should be closed`)
  }

  const zapOutX = findZapOutX(expected, ZAP_OUT_X_LP_IN)
  console.log("[integ] Running market order case zap-out-x")
  {
    const label = "zap-out-x"
    const slot = 7n
    const marketOrder = await MarketOrder.make(
      { privateStateId: `market-order-${label}` },
      providers,
    )
    await marketOrder.open({
      ownerCommitment: computeOwnerCommitment(marketOrderModule, marketOrder.address),
      amm: amm.circuitIds("AmmFundOrderLp"),
      kind: Amm.OrderKind.WithdrawXLiq,
      amountSent: ZAP_OUT_X_LP_IN,
      colorSent: amm.lpColor,
      colorReturned: xColor,
      returnsTo: { bytes: walletPublicKey },
    })
    await marketOrder.reserveAmmSlot(amm, slot, Amm.OrderKind.WithdrawXLiq, ZAP_OUT_X_LP_IN, 0n)
    await marketOrder.sendCoinToAmm(amm, "AmmFundOrderLp", slot)
    await amm.activateOrder(slot)
    await amm.validateWithdrawXLiq(zapOutX.xOut, zapOutX.ySwap, zapOutX.xFee, zapOutX.xSwap)
    await amm.splitX()
    await marketOrder.receiveCoinFromAmm(
      amm,
      "AmmPayX",
      slot,
      MarketOrder.ReturnKind.X,
      zapOutX.xOut,
    )
    await marketOrder.close(amm, slot)
    expected = {
      ...expected,
      xLiquidity: expected.xLiquidity - zapOutX.xOut - zapOutX.xFee,
      yLiquidity: expected.yLiquidity,
      xRewards: expected.xRewards + zapOutX.xFee,
      lpCirculatingSupply: expected.lpCirculatingSupply - ZAP_OUT_X_LP_IN,
    }
    assert(!(await marketOrder.state()).coins.member(0n), `${label} market order should be closed`)
  }

  const zapOutY = findZapOutY(expected, ZAP_OUT_Y_LP_IN)
  console.log("[integ] Running market order case zap-out-y")
  {
    const label = "zap-out-y"
    const slot = 8n
    const marketOrder = await MarketOrder.make(
      { privateStateId: `market-order-${label}` },
      providers,
    )
    await marketOrder.open({
      ownerCommitment: computeOwnerCommitment(marketOrderModule, marketOrder.address),
      amm: amm.circuitIds("AmmFundOrderLp"),
      kind: Amm.OrderKind.WithdrawYLiq,
      amountSent: ZAP_OUT_Y_LP_IN,
      colorSent: amm.lpColor,
      colorReturned: yColor,
      returnsTo: { bytes: walletPublicKey },
    })
    await marketOrder.reserveAmmSlot(amm, slot, Amm.OrderKind.WithdrawYLiq, ZAP_OUT_Y_LP_IN, 0n)
    await marketOrder.sendCoinToAmm(amm, "AmmFundOrderLp", slot)
    await amm.activateOrder(slot)
    await amm.validateWithdrawYLiq(zapOutY.yOut, zapOutY.xSwap, zapOutY.xFee, zapOutY.ySwap)
    await amm.splitY()
    await marketOrder.receiveCoinFromAmm(
      amm,
      "AmmPayY",
      slot,
      MarketOrder.ReturnKind.Y,
      zapOutY.yOut,
    )
    await marketOrder.close(amm, slot)
    expected = {
      ...expected,
      xLiquidity: expected.xLiquidity - zapOutY.xFee,
      yLiquidity: expected.yLiquidity - zapOutY.yOut,
      xRewards: expected.xRewards + zapOutY.xFee,
      lpCirculatingSupply: expected.lpCirculatingSupply - ZAP_OUT_Y_LP_IN,
    }
    assert(!(await marketOrder.state()).coins.member(0n), `${label} market order should be closed`)
  }

  console.log("[integ] Verifying final AMM ledger state")
  ammLedger = await amm.state()
  assertEqual(ammLedger.xLiquidity, expected.xLiquidity, "Unexpected final X liquidity")
  assertEqual(ammLedger.yLiquidity, expected.yLiquidity, "Unexpected final Y liquidity")
  assertEqual(
    ammLedger.lpCirculatingSupply,
    expected.lpCirculatingSupply,
    "Unexpected final LP supply",
  )
  assertEqual(ammLedger.xRewards, expected.xRewards, "Unexpected final X rewards")
  assert(!(await burnLpOrder.state()).coins.member(0n), "Burn LP order should be closed")
  console.log("[integ] Integration flow completed successfully")
}

await main()
