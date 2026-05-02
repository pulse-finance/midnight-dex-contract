import {
  createCircuitContext,
  createConstructorContext,
  encodeCoinPublicKey,
  encodeContractAddress,
  emptyZswapLocalState,
  entryPointHash,
} from "@midnight-ntwrk/compact-runtime"
import { Contract, ledger, type Witnesses } from "../../dist/marketorder/contract/index.js"

type CoinInfo = {
  nonce: Uint8Array
  color: Uint8Array
  value: bigint
}

type Sender = { bytes: Uint8Array }

export const ownerPublicKey = "11".repeat(32)
export const otherUserPublicKey = "22".repeat(32)
export const marketOrderContractAddress = "33".repeat(32)
export const ammContractAddress = "44".repeat(32)

export const owner = { bytes: encodeCoinPublicKey(ownerPublicKey) }
export const otherUser = { bytes: encodeCoinPublicKey(otherUserPublicKey) }
export const encodedMarketOrderContractAddress = {
  bytes: encodeContractAddress(marketOrderContractAddress),
}
export const encodedAmmContractAddress = {
  bytes: encodeContractAddress(ammContractAddress),
}
export const ownerSecret = new Uint8Array(32).fill(5)
export const otherSecret = new Uint8Array(32).fill(6)
export const receiveCircuitHash = hashBytes("MarketOrderReceiveFromAmm")
export const ammClearOrderCircuitHash = hashBytes("AmmClearOrder")
export const ammFundOrderXCircuitHash = hashBytes("AmmFundOrderX")
export const ammFundOrderYCircuitHash = hashBytes("AmmFundOrderY")
export const ammPlaceOrderCircuitHash = hashBytes("AmmPlaceOrder")
export const ammTickCircuitHash = ammClearOrderCircuitHash
export const ammSwapCircuit = {
  address: encodedAmmContractAddress,
  hash: ammPlaceOrderCircuitHash,
}
export const returnColor = new Uint8Array(32).fill(10)
export const coinColor = new Uint8Array(32).fill(8)
export const coinNonce = new Uint8Array(32).fill(9)
export const returnedNonce = new Uint8Array(32).fill(12)
export const coinValue = 123n
export const returnedValue = 77n
export const callOpening = 11n
export const tickCallOpening = 12n

export function hashBytes(circuitName: string) {
  return Uint8Array.from(Buffer.from(entryPointHash(circuitName), "hex"))
}

export class MarketOrderSimulator {
  readonly contract: Contract
  private currentContractState: any
  private currentPrivateState: any
  private nextCoinIndex = 0n
  private nextCoinColor: Uint8Array = returnColor

  constructor(secret = ownerSecret) {
    this.contract = new Contract({
      newNonce: (context: { privateState: any }) => [context.privateState, coinNonce],
      ownerSecret: (context: Parameters<Witnesses<any>["ownerSecret"]>[0]) => [
        context.privateState,
        secret,
      ],
      coinIndex: (context: { privateState: any }) => [context.privateState, this.nextCoinIndex],
      coinColor: (context: { privateState: any }) => [context.privateState, this.nextCoinColor],
    })

    const { currentContractState, currentPrivateState } = this.contract.initialState(
      createConstructorContext({}, owner),
      receiveCircuitHash,
    )

    this.currentContractState = currentContractState
    this.currentPrivateState = currentPrivateState
  }

  static makeContract(secret = ownerSecret) {
    return new Contract({
      newNonce: (context: { privateState: any }) => [context.privateState, coinNonce],
      ownerSecret: (context: Parameters<Witnesses<any>["ownerSecret"]>[0]) => [
        context.privateState,
        secret,
      ],
      coinIndex: (context: { privateState: any }) => [context.privateState, 0n],
      coinColor: (context: { privateState: any }) => [context.privateState, returnColor],
    })
  }

  ownerCommitment() {
    return (
      this.contract as Contract & {
        _persistentHash_0(value: [Uint8Array, Uint8Array]): Uint8Array
      }
    )._persistentHash_0([encodeContractAddress(marketOrderContractAddress), ownerSecret])
  }

  currentLedger() {
    return ledger(this.currentContractState.data ?? this.currentContractState)
  }

  openOrder({
    amount = coinValue,
    colorSent = coinColor,
    calls = ammSwapCircuit,
    returnsTo = owner,
    colorReturned = returnColor,
    nonce = coinNonce,
    sender = owner,
  } = {}) {
    const result = this.contract.circuits.MarketOrderOpen(
      this.makeContext(sender, [this.makeIncomingCoin(colorSent, amount, nonce)]),
      {
        ownerCommitment: this.ownerCommitment(),
        amm: {
          address: calls.address,
          placeOrder: calls.hash,
          fundOrder: ammFundOrderXCircuitHash,
          fundOrderAlt: ammFundOrderYCircuitHash,
          clearOrder: ammClearOrderCircuitHash,
        },
        kind: 3,
        amountSent: amount,
        colorSent,
        colorReturned,
        returnsTo,
      },
    )

    this.commit(result.context)
    return result
  }

  sendToAmm({
    sender = otherUser,
    calleeRnd = callOpening,
    ammTick = 0n,
    ammTickRnd = tickCallOpening,
  } = {}) {
    let result = this.contract.circuits.MarketOrderReserveAmmSlot(
      this.makeContext(sender),
      ammTick + 1n,
      ammTickRnd,
    )
    this.commit(result.context)
    result = this.contract.circuits.MarketOrderSendCoinToAmm(this.makeContext(sender), calleeRnd)

    this.commit(result.context)
    return result
  }

  receiveFromAmm({
    amount = returnedValue,
    color = returnColor,
    nonce = returnedNonce,
    sender = otherUser,
    returnKind = 0n,
    coinIndex = 0n,
  } = {}) {
    this.nextCoinIndex = coinIndex
    this.nextCoinColor = color

    const result = this.contract.circuits.MarketOrderReceiveCoinFromAmm(
      this.makeContext(sender, [this.makeIncomingCoin(color, amount, nonce)]),
      Number(returnKind),
      amount,
      nonce,
    )

    this.commit(result.context)
    return result
  }

  close({ sender = owner, secret = ownerSecret, ammTick = 1n, ammTickRnd = tickCallOpening } = {}) {
    const contract =
      secret === ownerSecret ? this.contract : MarketOrderSimulator.makeContract(secret)
    const result = contract.circuits.MarketOrderClose(this.makeContext(sender), ammTickRnd)

    this.commit(result.context)
    return result
  }

  private makeContext(sender: Sender, outputs: Array<{ coinInfo: CoinInfo; recipient: any }> = []) {
    return createCircuitContext(
      marketOrderContractAddress,
      {
        ...emptyZswapLocalState(sender),
        outputs,
      },
      this.currentContractState,
      this.currentPrivateState,
    )
  }

  private makeIncomingCoin(color: Uint8Array, value: bigint, nonce: Uint8Array) {
    return {
      coinInfo: {
        nonce,
        color,
        value,
      },
      recipient: {
        is_left: false,
        left: { bytes: new Uint8Array(32) },
        right: encodedMarketOrderContractAddress,
      },
    }
  }

  private commit(context: ReturnType<typeof createCircuitContext>) {
    this.currentContractState = context.currentQueryContext.state
    this.currentPrivateState = context.currentPrivateState
  }
}

function makeNonceFromId(id: number) {
  const nonce = new Uint8Array(32)
  let value = id

  for (let i = 31; i >= 0 && value > 0; i -= 1) {
    nonce[i] = value & 0xff
    value >>= 8
  }

  return nonce
}
