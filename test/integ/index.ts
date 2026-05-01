import { encodeContractAddress } from "@midnight-ntwrk/compact-runtime"

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

  console.log("[integ] Deploying BurnLpOrder contract")
  const burnLpOrder = await BurnLpOrder.makeHelpers({}, providers)

  await testBurnLpOrderFlow(walletPublicKey, amm, burnLpOrder)

  console.log("[integ] Deploying MintLpOrder contract")
  const mintLpOrder = await MintLpOrder.make({ privateStateId: "mint-lp-order-1" }, providers)

  await testMintLpFlow(walletPublicKey, amm, mintLpOrder)

  console.log("[integ] Running market order case swap-x-to-y")
  {
    const label = "swap-x-to-y"
    const slot = 3n
    const swapX = Amm.calcSwapXToY(amm.expectedState, SWAP_X_IN)
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
    assert(!(await marketOrder.state()).coins.member(0n), `${label} market order should be closed`)
  }

  const swapY = Amm.calcSwapYToX(amm.expectedState, SWAP_Y_IN)
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
    assert(!(await marketOrder.state()).coins.member(0n), `${label} market order should be closed`)
  }

  const zapInX = Amm.findZapInX(amm.expectedState, ZAP_IN_X_IN)
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
    assert(!(await marketOrder.state()).coins.member(0n), `${label} market order should be closed`)
  }

  const zapInY = Amm.findZapInY(amm.expectedState, ZAP_IN_Y_IN)
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
    assert(!(await marketOrder.state()).coins.member(0n), `${label} market order should be closed`)
  }

  const zapOutX = Amm.findZapOutX(amm.expectedState, ZAP_OUT_X_LP_IN)
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
    assert(!(await marketOrder.state()).coins.member(0n), `${label} market order should be closed`)
  }

  const zapOutY = Amm.findZapOutY(amm.expectedState, ZAP_OUT_Y_LP_IN)
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
    assert(!(await marketOrder.state()).coins.member(0n), `${label} market order should be closed`)
  }

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

async function testMintLpFlow(
  walletPublicKey: Buffer,
  amm: Amm.ContractHelpers,
  mintLpOrder: MintLpOrder.Contract,
) {
  const initialAmmState = await amm.state()
  const xColor = initialAmmState.xColor
  const yColor = initialAmmState.yColor

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
  await mintLpOrder.receiveFromAmm(amm, mintSlot, BigInt(MarketOrder.ReturnKind.Lp), mintLpOut)

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
}

async function testBurnLpOrderFlow(
  walletPublicKey: Buffer,
  amm: Amm.ContractHelpers,
  burnLpOrder: BurnLpOrder.ContractHelpers,
) {
  const initialAmmState = await amm.state()
  const xColor = initialAmmState.xColor
  const yColor = initialAmmState.yColor

  console.log("[integ] Running burn LP order flow")
  const burnSlot = 2n
  const { xOut: burnXOut, yOut: burnYOut } = Amm.calcWithdrawXY(amm.expectedState, BURN_LP_IN)
  console.log("[integ] Opening BurnLpOrder")
  await burnLpOrder.open({
    ownerCommitment: computeOwnerCommitment(burnLpOrderModule, burnLpOrder.address),
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

  console.log("[integ] Split y liq to send to order slot")
  await amm.splitY()

  console.log("[integ] Send X coin from Amm to BurnLpOrder")
  await burnLpOrder.receiveXCoinFromAmm(amm, burnSlot, BurnLpOrder.ReturnKind.X, burnXOut)

  console.log("[integ] Send Y coin from Amm to BurnLpOrder")
  await burnLpOrder.receiveYCoinFromAmm(amm, burnSlot, BurnLpOrder.ReturnKind.Y, burnYOut)

  console.log("[integ] Closing X on Amm")
  await burnLpOrder.closeX(amm, burnSlot)

  console.log("[integ] Closing Y on Amm")
  await burnLpOrder.closeY()
}

await main()
