import {
  createCircuitContext,
  createConstructorContext,
  encodeCoinPublicKey,
  encodeContractAddress,
  emptyZswapLocalState,
  entryPointHash,
} from "@midnight-ntwrk/compact-runtime"
import { Contract, ledger, type Witnesses } from "../../dist/burnlporder/contract/index.js"

type CoinInfo = {
  nonce: Uint8Array
  color: Uint8Array
  value: bigint
}

type Sender = { bytes: Uint8Array }

export const burnLpOwnerPublicKey = "11".repeat(32)
export const burnLpOtherUserPublicKey = "22".repeat(32)
export const burnLpContractAddress = "66".repeat(32)
export const burnLpAmmContractAddress = "44".repeat(32)

export const burnLpOwner = { bytes: encodeCoinPublicKey(burnLpOwnerPublicKey) }
export const burnLpOtherUser = {
  bytes: encodeCoinPublicKey(burnLpOtherUserPublicKey),
}
export const encodedBurnLpContractAddress = {
  bytes: encodeContractAddress(burnLpContractAddress),
}
export const encodedBurnLpAmmContractAddress = {
  bytes: encodeContractAddress(burnLpAmmContractAddress),
}
export const burnLpOwnerSecret = new Uint8Array(32).fill(5)
export const burnLpOtherSecret = new Uint8Array(32).fill(6)
export const burnLpReceiveCircuitHash = burnLpHashBytes("BurnLpOrderReceiveFromAmm")
export const burnLpAmmClearOrderCircuitHash = burnLpHashBytes("AmmClearOrder")
export const burnLpAmmFundOrderLpCircuitHash = burnLpHashBytes("AmmFundOrderLp")
export const burnLpAmmFundOrderYCircuitHash = burnLpHashBytes("AmmFundOrderY")
export const burnLpAmmPlaceOrderCircuitHash = burnLpHashBytes("AmmPlaceOrder")
export const burnLpAmmTickCircuitHash = burnLpAmmClearOrderCircuitHash
export const burnLpAmmCircuit = {
  address: encodedBurnLpAmmContractAddress,
  hash: burnLpAmmPlaceOrderCircuitHash,
}
export const burnLpColor = new Uint8Array(32).fill(7)
export const burnLpXReturnColor = new Uint8Array(32).fill(8)
export const burnLpYReturnColor = new Uint8Array(32).fill(9)
export const burnLpNonce = new Uint8Array(32).fill(10)
export const burnLpXReturnedNonce = new Uint8Array(32).fill(11)
export const burnLpYReturnedNonce = new Uint8Array(32).fill(12)
export const burnLpValue = 123n
export const burnLpXReturnedValue = 77n
export const burnLpYReturnedValue = 88n
export const burnLpCallOpening = 13n
export const burnLpTickCallOpening = 14n

export function burnLpHashBytes(circuitName: string) {
  return Uint8Array.from(Buffer.from(entryPointHash(circuitName), "hex"))
}

export class BurnLpOrderSimulator {
  readonly contract: Contract
  private currentContractState: any
  private currentPrivateState: any
  private nextCoinIndex = 0n
  private nextCoinColor: Uint8Array = burnLpXReturnColor

  constructor(secret = burnLpOwnerSecret) {
    this.contract = new Contract({
      newNonce: (context: { privateState: any }) => [context.privateState, burnLpNonce],
      ownerSecret: (context: Parameters<Witnesses<any>["ownerSecret"]>[0]) => [
        context.privateState,
        secret,
      ],
      coinIndex: (context: { privateState: any }) => [context.privateState, this.nextCoinIndex],
      coinColor: (context: { privateState: any }) => [context.privateState, this.nextCoinColor],
    })

    const { currentContractState, currentPrivateState } = this.contract.initialState(
      createConstructorContext({}, burnLpOwner),
      burnLpReceiveCircuitHash,
    )

    this.currentContractState = currentContractState
    this.currentPrivateState = currentPrivateState
  }

  static makeContract(secret = burnLpOwnerSecret) {
    return new Contract({
      newNonce: (context: { privateState: any }) => [context.privateState, burnLpNonce],
      ownerSecret: (context: Parameters<Witnesses<any>["ownerSecret"]>[0]) => [
        context.privateState,
        secret,
      ],
      coinIndex: (context: { privateState: any }) => [context.privateState, 0n],
      coinColor: (context: { privateState: any }) => [context.privateState, burnLpXReturnColor],
    })
  }

  ownerCommitment() {
    return (
      this.contract as Contract & {
        _persistentHash_1(value: [Uint8Array, Uint8Array]): Uint8Array
      }
    )._persistentHash_1([encodeContractAddress(burnLpContractAddress), burnLpOwnerSecret])
  }

  currentLedger() {
    return ledger(this.currentContractState.data ?? this.currentContractState)
  }

  openOrder({
    amount = burnLpValue,
    colorSent = burnLpColor,
    calls = burnLpAmmCircuit,
    returnsTo = burnLpOwner,
    xColorReturned = burnLpXReturnColor,
    yColorReturned = burnLpYReturnColor,
    nonce = burnLpNonce,
    sender = burnLpOwner,
  } = {}) {
    const result = this.contract.circuits.BurnLpOrderOpen(
      this.makeContext(sender, [this.makeIncomingCoin(colorSent, amount, nonce)]),
      {
        ownerCommitment: this.ownerCommitment(),
        amm: {
          address: calls.address,
          placeOrder: calls.hash,
          fundOrder: burnLpAmmFundOrderLpCircuitHash,
          fundOrderAlt: burnLpAmmFundOrderYCircuitHash,
          clearOrder: burnLpAmmClearOrderCircuitHash,
        },
        amountSent: amount,
        colorSent,
        xColorReturned,
        yColorReturned,
        returnsTo,
      },
    )

    this.commit(result.context)
    return result
  }

  sendToAmm({
    sender = burnLpOtherUser,
    calleeRnd = burnLpCallOpening,
    ammTick = 0n,
    ammTickRnd = burnLpTickCallOpening,
  } = {}) {
    let result = this.contract.circuits.BurnLpOrderReserveAmmSlot(
      this.makeContext(sender),
      ammTick + 1n,
      ammTickRnd,
    )
    this.commit(result.context)
    result = this.contract.circuits.BurnLpOrderSendCoinToAmm(this.makeContext(sender), calleeRnd)

    this.commit(result.context)
    return result
  }

  receiveXFromAmm({
    amount = burnLpXReturnedValue,
    color = burnLpXReturnColor,
    nonce = burnLpXReturnedNonce,
    sender = burnLpOtherUser,
    coinIndex = 0n,
  } = {}) {
    return this.receiveFromAmm({
      amount,
      color,
      nonce,
      sender,
      returnKind: 0n,
      coinIndex,
    })
  }

  receiveYFromAmm({
    amount = burnLpYReturnedValue,
    color = burnLpYReturnColor,
    nonce = burnLpYReturnedNonce,
    sender = burnLpOtherUser,
    coinIndex = 1n,
  } = {}) {
    return this.receiveFromAmm({
      amount,
      color,
      nonce,
      sender,
      returnKind: 1n,
      coinIndex,
    })
  }

  receiveUnexpectedFromAmm({
    amount = burnLpYReturnedValue,
    color = burnLpYReturnColor,
    nonce = burnLpYReturnedNonce,
    sender = burnLpOtherUser,
    returnKind = 2n,
    coinIndex = 2n,
  } = {}) {
    return this.receiveFromAmm({
      amount,
      color,
      nonce,
      sender,
      returnKind,
      coinIndex,
    })
  }

  close({
    sender = burnLpOwner,
    secret = burnLpOwnerSecret,
    ammTickRnd = burnLpTickCallOpening,
  } = {}) {
    const contract =
      secret === burnLpOwnerSecret ? this.contract : BurnLpOrderSimulator.makeContract(secret)
    let result = contract.circuits.BurnLpOrderClearAmmSlot(this.makeContext(sender), ammTickRnd)
    this.commit(result.context)
    result = contract.circuits.BurnLpOrderCloseX(this.makeContext(sender))
    this.commit(result.context)
    if (this.currentLedger().state === 5 && this.currentLedger().coins.member(2n)) {
      result = contract.circuits.BurnLpOrderCloseY(this.makeContext(sender))
      this.commit(result.context)
    }

    return result
  }

  clearAmmSlot({
    sender = burnLpOwner,
    secret = burnLpOwnerSecret,
    ammTickRnd = burnLpTickCallOpening,
  } = {}) {
    const contract =
      secret === burnLpOwnerSecret ? this.contract : BurnLpOrderSimulator.makeContract(secret)
    const result = contract.circuits.BurnLpOrderClearAmmSlot(this.makeContext(sender), ammTickRnd)

    this.commit(result.context)
    return result
  }

  closeX({ sender = burnLpOwner, secret = burnLpOwnerSecret } = {}) {
    const contract =
      secret === burnLpOwnerSecret ? this.contract : BurnLpOrderSimulator.makeContract(secret)
    const result = contract.circuits.BurnLpOrderCloseX(this.makeContext(sender))

    this.commit(result.context)
    return result
  }

  closeY({ sender = burnLpOwner, secret = burnLpOwnerSecret } = {}) {
    const contract =
      secret === burnLpOwnerSecret ? this.contract : BurnLpOrderSimulator.makeContract(secret)
    const result = contract.circuits.BurnLpOrderCloseY(this.makeContext(sender))

    this.commit(result.context)
    return result
  }

  private receiveFromAmm({
    amount,
    color,
    nonce,
    sender,
    returnKind,
    coinIndex,
  }: {
    amount: bigint
    color: Uint8Array
    nonce: Uint8Array
    sender: Sender
    returnKind: bigint
    coinIndex: bigint
  }) {
    this.nextCoinIndex = coinIndex
    this.nextCoinColor = color

    const result = this.contract.circuits.BurnLpOrderReceiveCoinFromAmm(
      this.makeContext(sender, [this.makeIncomingCoin(color, amount, nonce)]),
      Number(returnKind),
      amount,
      nonce,
    )

    this.commit(result.context)
    return result
  }

  private makeContext(sender: Sender, outputs: Array<{ coinInfo: CoinInfo; recipient: any }> = []) {
    return createCircuitContext(
      burnLpContractAddress,
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
        right: encodedBurnLpContractAddress,
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
