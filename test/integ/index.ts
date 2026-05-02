import {
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

import { fromHex } from "@midnight-ntwrk/midnight-js-utils"
import { computeOwnerCommitment } from "../ownerCommitment"

function deterministicNonce(index: number): Uint8Array {
  const bytes = new Uint8Array(32)
  bytes[30] = (index >> 8) & 0xff
  bytes[31] = index & 0xff
  return bytes
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

type TestContext = {
  amm: Amm.ContractHelpers
  walletPublicKey: Buffer
  xColor: Uint8Array
  yColor: Uint8Array
}

async function mergeAmmTokensIfNeeded(amm: Amm.ContractHelpers) {
  const ammLedger = await amm.state()

  if (ammLedger.coins.member(1n)) {
    console.log("[integ] Merging fragmented X liquidity coin on Amm")
    await amm.mergeX()
  }

  if (ammLedger.coins.member(3n)) {
    console.log("[integ] Merging fragmented Y liquidity coin on Amm")
    await amm.mergeY()
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

  console.log("[integ] Minting Y tokens from faucet")
  await faucet.mintShielded(
    Y_TOKEN_NAME,
    INITIAL_Y_LIQ + MINT_LP_Y_IN + SWAP_Y_IN + ZAP_IN_Y_IN,
    deterministicNonce(2),
    walletAddress,
  )
  const yColor = faucet.color(Y_TOKEN_NAME)

  console.log("[integ] Deploying AMM")
  const amm = await Amm.makeHelpers({ xColor, yColor, treasury: walletAddress }, providers)
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

  const testContext: TestContext = {
    amm,
    walletPublicKey,
    xColor,
    yColor,
  }

  console.log("[integ] Deploying BurnLpOrder contract")
  const burnLpOrder = await BurnLpOrder.makeHelpers({}, providers)
  await testBurnLpOrderFlow(burnLpOrder, testContext)

  console.log("[integ] Deploying MintLpOrder contract")
  const mintLpOrder = await MintLpOrder.makeHelpers(providers)
  await testMintLpFlow(mintLpOrder, testContext)

  console.log("[integ] Deploying MarketOrder contract")
  const marketOrder = await MarketOrder.makeHelpers(providers)

  console.log("[integ] Running market order case swap-x-to-y")
  await testSwapXToYFlow(marketOrder, testContext)

  console.log("[integ] Running market order case swap-y-to-x")
  await testSwapYToXFlow(marketOrder, testContext)

  console.log("[integ] Running market order case zap-in-x")
  await testZapInXFlow(marketOrder, testContext)

  console.log("[integ] Running market order case zap-in-y")
  await testZapInYFlow(marketOrder, testContext)

  console.log("[integ] Running market order case zap-out-x")
  await testZapOutXFlow(marketOrder, testContext)

  console.log("[integ] Running market order case zap-out-y")
  await testZapOutYFlow(marketOrder, testContext)

  console.log("[integ] Verifying final AMM ledger state")
  ammLedger = await amm.state()
  assertEqual(ammLedger.xLiquidity, amm.expectedState.xLiquidity, "Unexpected final X liquidity")
  assertEqual(ammLedger.yLiquidity, amm.expectedState.yLiquidity, "Unexpected final Y liquidity")
  assertEqual(
    ammLedger.lpCirculatingSupply,
    amm.expectedState.lpCirculatingSupply,
    "Unexpected final LP supply",
  )
  assertEqual(ammLedger.xRewards, amm.expectedState.xRewards, "Unexpected final X rewards")
  assert(!(await burnLpOrder.state()).coins.member(0n), "Burn LP order should be closed")
  console.log("[integ] Integration flow completed successfully")
}

async function testMintLpFlow(mintLpOrder: MintLpOrder.ContractHelpers, ctx: TestContext) {
  const { amm, walletPublicKey, xColor, yColor } = ctx

  console.log("[integ] Place mint order")
  await mintLpOrder.open({
    ownerCommitment: computeOwnerCommitment(mintLpOrder.address, ORDER_OWNER_SECRET),
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

  console.log("[integ] Sending Y coin from MintLpOrder to Amm")
  await mintLpOrder.sendYCoinToAmm(amm, mintSlot)

  console.log("[integ] Activating MintLpOrder on Amm")
  await amm.activateOrder(mintSlot)

  console.log("[integ] Validating MintLpOrder on Amm")
  const mintLpOut = Amm.calcLpOut(amm.expectedState, MINT_LP_X_IN, MINT_LP_Y_IN)
  await amm.validateDepositXYLiq(mintLpOut)

  console.log("[integ] Minting Lp tokens")
  await amm.mintLp()

  console.log("[integ] Sending lp tokens from Amm to MintLpOrder contract")
  await mintLpOrder.receiveFromAmm(amm, mintSlot, BigInt(Amm.ReturnKind.Lp), mintLpOut)

  const finalAmmState = await amm.state()
  assertEqual(
    finalAmmState.xLiquidity,
    amm.expectedState.xLiquidity,
    "Unexpected X liquidity after mint LP",
  )
  assertEqual(
    finalAmmState.yLiquidity,
    amm.expectedState.yLiquidity,
    "Unexpected Y liquidity after mint LP",
  )
  assertEqual(
    finalAmmState.lpCirculatingSupply,
    amm.expectedState.lpCirculatingSupply,
    "Unexpected LP supply after mint LP",
  )
  assertEqual(
    (await mintLpOrder.state()).ammSlot,
    mintSlot,
    "Mint LP order should retain its AMM slot before close",
  )

  await mergeAmmTokensIfNeeded(amm)
}

async function testBurnLpOrderFlow(burnLpOrder: BurnLpOrder.ContractHelpers, ctx: TestContext) {
  const { amm, walletPublicKey, xColor, yColor } = ctx

  console.log("[integ] Running burn LP order flow")
  const burnSlot = 2n
  const { xOut: burnXOut, yOut: burnYOut } = Amm.calcWithdrawXY(amm.expectedState, BURN_LP_IN)
  console.log("[integ] Opening BurnLpOrder")
  await burnLpOrder.open({
    ownerCommitment: computeOwnerCommitment(burnLpOrder.address, ORDER_OWNER_SECRET),
    amm: amm.circuitIds("AmmFundOrderLp"),
    amountSent: BURN_LP_IN,
    colorSent: amm.lpColor,
    xColorReturned: xColor,
    yColorReturned: yColor,
    returnsTo: { bytes: walletPublicKey },
  })

  console.log("[integ] Reserving Amm slot for BurnLpOrder")
  await burnLpOrder.reserveAmmSlot(amm, burnSlot, Amm.OrderKind.WithdrawXYLiq, BURN_LP_IN, 0n)

  console.log("[integ] Sending lp tokens to Amm")
  await burnLpOrder.sendCoinToAmm(amm, burnSlot)

  console.log("[integ] Activating burn order on Amm")
  await amm.activateOrder(burnSlot)

  console.log("[integ] Validating burn order on Amm")
  await amm.validateWithdrawXYLiq(burnXOut, burnYOut)

  console.log("[integ] Split x liq to send to order slot")
  await amm.splitX()

  console.log(`[integ] Split y liq to send to order slot ${burnSlot}`)
  await amm.splitY()

  console.log("[integ] Deactivating processed burn order on Amm")
  await amm.deactivateOrder()

  console.log("[integ] Send X coin from Amm to BurnLpOrder")
  await burnLpOrder.receiveXCoinFromAmm(amm, burnSlot, BurnLpOrder.ReturnKind.X, burnXOut)

  console.log("[integ] Send Y coin from Amm to BurnLpOrder")
  await burnLpOrder.receiveYCoinFromAmm(amm, burnSlot, BurnLpOrder.ReturnKind.Y, burnYOut)

  console.log("[integ] Clearing burn order slot on Amm")
  await burnLpOrder.clearAmmSlot(amm, burnSlot)

  console.log("[integ] Closing X on BurnLpOrder")
  await burnLpOrder.closeX()

  console.log("[integ] Closing Y on BurnLpOrder")
  await burnLpOrder.closeY()

  await mergeAmmTokensIfNeeded(amm)
}

async function testSwapXToYFlow(marketOrder: MarketOrder.ContractHelpers, ctx: TestContext) {
  const { amm, walletPublicKey, xColor, yColor } = ctx

  const slot = 3n
  const swapX = Amm.calcSwapXToY(amm.expectedState, SWAP_X_IN)

  console.log("[integ] Opening swap-x-to-y market order")
  await marketOrder.open({
    ownerCommitment: computeOwnerCommitment(marketOrder.address, ORDER_OWNER_SECRET),
    amm: amm.circuitIds("AmmFundOrderX"),
    kind: Amm.OrderKind.SwapXToY,
    amountSent: SWAP_X_IN,
    colorSent: xColor,
    colorReturned: yColor,
    returnsTo: { bytes: walletPublicKey },
  })

  console.log("[integ] Reserving Amm slot for swap-x-to-y")
  await marketOrder.reserveAmmSlot(amm, slot, Amm.OrderKind.SwapXToY, SWAP_X_IN, 0n)

  console.log("[integ] Sending X coin from MarketOrder to Amm")
  await marketOrder.sendCoinToAmm(amm, "AmmFundOrderX", slot)

  console.log("[integ] Activating swap-x-to-y on Amm")
  await amm.activateOrder(slot)

  console.log("[integ] Validating swap-x-to-y on Amm")
  await amm.validateSwapXToY(swapX.xFee, swapX.yOut)

  console.log("[integ] Splitting Y liquidity for swap-x-to-y payout")
  await amm.splitY()

  console.log("[integ] Deactivating swap-x-to-y on Amm")
  await amm.deactivateOrder()

  console.log("[integ] Sending Y coin from Amm to MarketOrder")
  await marketOrder.receiveCoinFromAmm(amm, "AmmPayY", slot, Amm.ReturnKind.Y, swapX.yOut)

  console.log("[integ] Closing swap-x-to-y market order")
  await marketOrder.close(amm, slot)
  assert(!(await marketOrder.state()).coins.member(0n), `swap-x-to-y market order should be closed`)

  await mergeAmmTokensIfNeeded(amm)
}

async function testSwapYToXFlow(marketOrder: MarketOrder.ContractHelpers, ctx: TestContext) {
  const { amm, walletPublicKey, xColor, yColor } = ctx

  const slot = 4n
  const swapY = Amm.calcSwapYToX(amm.expectedState, SWAP_Y_IN)

  console.log("[integ] Opening swap-y-to-x market order")
  await marketOrder.open({
    ownerCommitment: computeOwnerCommitment(marketOrder.address, ORDER_OWNER_SECRET),
    amm: amm.circuitIds("AmmFundOrderY"),
    kind: Amm.OrderKind.SwapYToX,
    amountSent: SWAP_Y_IN,
    colorSent: yColor,
    colorReturned: xColor,
    returnsTo: { bytes: walletPublicKey },
  })

  console.log("[integ] Reserving Amm slot for swap-y-to-x")
  await marketOrder.reserveAmmSlot(amm, slot, Amm.OrderKind.SwapYToX, 0n, SWAP_Y_IN)

  console.log("[integ] Sending Y coin from MarketOrder to Amm")
  await marketOrder.sendCoinToAmm(amm, "AmmFundOrderY", slot)

  console.log("[integ] Activating swap-y-to-x on Amm")
  await amm.activateOrder(slot)

  console.log("[integ] Validating swap-y-to-x on Amm")
  await amm.validateSwapYToX(swapY.xFee, swapY.xOut)

  console.log("[integ] Splitting X liquidity for swap-y-to-x payout")
  await amm.splitX()

  console.log("[integ] Deactivating swap-y-to-x on Amm")
  await amm.deactivateOrder()

  console.log("[integ] Sending X coin from Amm to MarketOrder")
  await marketOrder.receiveCoinFromAmm(amm, "AmmPayX", slot, Amm.ReturnKind.X, swapY.xOut)

  console.log("[integ] Closing swap-y-to-x market order")
  await marketOrder.close(amm, slot)
  assert(!(await marketOrder.state()).coins.member(0n), `swap-y-to-x market order should be closed`)

  await mergeAmmTokensIfNeeded(amm)
}

async function testZapInXFlow(marketOrder: MarketOrder.ContractHelpers, ctx: TestContext) {
  const { amm, walletPublicKey, xColor } = ctx

  const slot = 5n
  const zapInX = Amm.findZapInX(amm.expectedState, ZAP_IN_X_IN)

  console.log("[integ] Opening zap-in-x market order")
  await marketOrder.open({
    ownerCommitment: computeOwnerCommitment(marketOrder.address, ORDER_OWNER_SECRET),
    amm: amm.circuitIds("AmmFundOrderX"),
    kind: Amm.OrderKind.DepositXLiq,
    amountSent: ZAP_IN_X_IN,
    colorSent: xColor,
    colorReturned: amm.lpColor,
    returnsTo: { bytes: walletPublicKey },
  })

  console.log("[integ] Reserving Amm slot for zap-in-x")
  await marketOrder.reserveAmmSlot(amm, slot, Amm.OrderKind.DepositXLiq, ZAP_IN_X_IN, 0n)

  console.log("[integ] Sending X coin from MarketOrder to Amm")
  await marketOrder.sendCoinToAmm(amm, "AmmFundOrderX", slot)

  console.log("[integ] Activating zap-in-x on Amm")
  await amm.activateOrder(slot)

  console.log("[integ] Validating zap-in-x on Amm")
  await amm.validateDepositXLiq(zapInX.xSwap, zapInX.xFee, zapInX.ySwap, zapInX.lpOut)

  console.log("[integ] Minting LP for zap-in-x")
  await amm.mintLp()

  console.log("[integ] Sending LP coin from Amm to MarketOrder")
  await marketOrder.receiveCoinFromAmm(amm, "AmmPayLp", slot, Amm.ReturnKind.Lp, zapInX.lpOut)

  console.log("[integ] Closing zap-in-x market order")
  await marketOrder.close(amm, slot)
  assert(!(await marketOrder.state()).coins.member(0n), `zap-in x market order should be closed`)

  await mergeAmmTokensIfNeeded(amm)
}

async function testZapInYFlow(marketOrder: MarketOrder.ContractHelpers, ctx: TestContext) {
  const { amm, walletPublicKey, yColor } = ctx

  const slot = 6n
  const zapInY = Amm.findZapInY(amm.expectedState, ZAP_IN_Y_IN)

  console.log("[integ] Opening zap-in-y market order")
  await marketOrder.open({
    ownerCommitment: computeOwnerCommitment(marketOrder.address, ORDER_OWNER_SECRET),
    amm: amm.circuitIds("AmmFundOrderY"),
    kind: Amm.OrderKind.DepositYLiq,
    amountSent: ZAP_IN_Y_IN,
    colorSent: yColor,
    colorReturned: amm.lpColor,
    returnsTo: { bytes: walletPublicKey },
  })

  console.log("[integ] Reserving Amm slot for zap-in-y")
  await marketOrder.reserveAmmSlot(amm, slot, Amm.OrderKind.DepositYLiq, 0n, ZAP_IN_Y_IN)

  console.log("[integ] Sending Y coin from MarketOrder to Amm")
  await marketOrder.sendCoinToAmm(amm, "AmmFundOrderY", slot)

  console.log("[integ] Activating zap-in-y on Amm")
  await amm.activateOrder(slot)

  console.log("[integ] Validating zap-in-y on Amm")
  await amm.validateDepositYLiq(zapInY.ySwap, zapInY.xFee, zapInY.xSwap, zapInY.lpOut)

  console.log("[integ] Minting LP for zap-in-y")
  await amm.mintLp()

  console.log("[integ] Sending LP coin from Amm to MarketOrder")
  await marketOrder.receiveCoinFromAmm(amm, "AmmPayLp", slot, Amm.ReturnKind.Lp, zapInY.lpOut)

  console.log("[integ] Closing zap-in-y market order")
  await marketOrder.close(amm, slot)
  assert(!(await marketOrder.state()).coins.member(0n), `zap-in y market order should be closed`)

  await mergeAmmTokensIfNeeded(amm)
}

async function testZapOutXFlow(marketOrder: MarketOrder.ContractHelpers, ctx: TestContext) {
  const { amm, walletPublicKey, xColor } = ctx

  const slot = 7n
  const zapOutX = Amm.findZapOutX(amm.expectedState, ZAP_OUT_X_LP_IN)

  console.log("[integ] Opening zap-out-x market order")
  await marketOrder.open({
    ownerCommitment: computeOwnerCommitment(marketOrder.address, ORDER_OWNER_SECRET),
    amm: amm.circuitIds("AmmFundOrderLp"),
    kind: Amm.OrderKind.WithdrawXLiq,
    amountSent: ZAP_OUT_X_LP_IN,
    colorSent: amm.lpColor,
    colorReturned: xColor,
    returnsTo: { bytes: walletPublicKey },
  })

  console.log("[integ] Reserving Amm slot for zap-out-x")
  await marketOrder.reserveAmmSlot(amm, slot, Amm.OrderKind.WithdrawXLiq, ZAP_OUT_X_LP_IN, 0n)

  console.log("[integ] Sending LP coin from MarketOrder to Amm")
  await marketOrder.sendCoinToAmm(amm, "AmmFundOrderLp", slot)

  console.log("[integ] Activating zap-out-x on Amm")
  await amm.activateOrder(slot)

  console.log("[integ] Validating zap-out-x on Amm")
  await amm.validateWithdrawXLiq(zapOutX.xOut, zapOutX.ySwap, zapOutX.xFee, zapOutX.xSwap)

  console.log("[integ] Splitting X liquidity for zap-out-x payout")
  await amm.splitX()

  console.log("[integ] Deactivating zap-out-x on Amm")
  await amm.deactivateOrder()

  console.log("[integ] Sending X coin from Amm to MarketOrder")
  await marketOrder.receiveCoinFromAmm(amm, "AmmPayX", slot, Amm.ReturnKind.X, zapOutX.xOut)

  console.log("[integ] Closing zap-out-x market order")
  await marketOrder.close(amm, slot)
  assert(!(await marketOrder.state()).coins.member(0n), `zap out x market order should be closed`)

  await mergeAmmTokensIfNeeded(amm)
}

async function testZapOutYFlow(marketOrder: MarketOrder.ContractHelpers, ctx: TestContext) {
  const { amm, walletPublicKey, yColor } = ctx
  const slot = 8n
  const zapOutY = Amm.findZapOutY(amm.expectedState, ZAP_OUT_Y_LP_IN)

  console.log("[integ] Opening zap-out-y market order")
  await marketOrder.open({
    ownerCommitment: computeOwnerCommitment(marketOrder.address, ORDER_OWNER_SECRET),
    amm: amm.circuitIds("AmmFundOrderLp"),
    kind: Amm.OrderKind.WithdrawYLiq,
    amountSent: ZAP_OUT_Y_LP_IN,
    colorSent: amm.lpColor,
    colorReturned: yColor,
    returnsTo: { bytes: walletPublicKey },
  })

  console.log("[integ] Reserving Amm slot for zap-out-y")
  await marketOrder.reserveAmmSlot(amm, slot, Amm.OrderKind.WithdrawYLiq, ZAP_OUT_Y_LP_IN, 0n)

  console.log("[integ] Sending LP coin from MarketOrder to Amm")
  await marketOrder.sendCoinToAmm(amm, "AmmFundOrderLp", slot)

  console.log("[integ] Activating zap-out-y on Amm")
  await amm.activateOrder(slot)

  console.log("[integ] Validating zap-out-y on Amm")
  await amm.validateWithdrawYLiq(zapOutY.yOut, zapOutY.xSwap, zapOutY.xFee, zapOutY.ySwap)

  console.log("[integ] Splitting Y liquidity for zap-out-y payout")
  await amm.splitY()

  console.log("[integ] Deactivating zap-out-y on Amm")
  await amm.deactivateOrder()

  console.log("[integ] Sending Y coin from Amm to MarketOrder")
  await marketOrder.receiveCoinFromAmm(amm, "AmmPayY", slot, Amm.ReturnKind.Y, zapOutY.yOut)

  console.log("[integ] Closing zap-out-y market order")
  await marketOrder.close(amm, slot)
  assert(!(await marketOrder.state()).coins.member(0n), `zap out y market order should be closed`)

  await mergeAmmTokensIfNeeded(amm)
}

await main()
