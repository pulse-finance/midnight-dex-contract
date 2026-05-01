import type { Contract as CompactContract } from "@midnight-ntwrk/compact-js/effect/Contract"
import type { ZswapLocalState } from "@midnight-ntwrk/compact-runtime"
import {
  type CoinCommitment,
  type PreProof,
  type QualifiedShieldedCoinInfo,
  type UnprovenInput,
  type UnprovenOutput,
  type UnprovenTransaction,
  type UnprovenTransient,
  ZswapInput,
  ZswapOffer,
  ZswapOutput,
  ZswapTransient,
} from "@midnight-ntwrk/ledger-v8"
import type { UnsubmittedCallTxData } from "@midnight-ntwrk/midnight-js-contracts"

const DEFAULT_SEGMENT_NUMBER = 0

type ContractOwnedOutputCoinsByCommitment = Map<CoinCommitment, QualifiedShieldedCoinInfo>
type Offer = ZswapOffer<PreProof>

function contractOwnedOutputCoinsByCommitment(
  zswapLocalState: ZswapLocalState,
): ContractOwnedOutputCoinsByCommitment {
  const commitments = new Map<CoinCommitment, QualifiedShieldedCoinInfo>()

  zswapLocalState.outputs.forEach((output) => {
    if (output.recipient.is_left) {
      return
    }

    const unprovenOutput = ZswapOutput.newContractOwned(
      output.coinInfo,
      DEFAULT_SEGMENT_NUMBER,
      output.recipient.right,
    )
    commitments.set(unprovenOutput.commitment, {
      ...output.coinInfo,
      mt_index: 0n,
    })
  })

  return commitments
}

function offerFromParts(
  inputs: UnprovenInput[],
  outputs: UnprovenOutput[],
  transients: UnprovenTransient[],
): Offer | undefined {
  const offers: Offer[] = [
    ...inputs.map((input) => ZswapOffer.fromInput(input)),
    ...outputs.map((output) => ZswapOffer.fromOutput(output)),
    ...transients.map((transient) => ZswapOffer.fromTransient(transient)),
  ]

  if (offers.length === 0) {
    return undefined
  }

  return offers.slice(1).reduce((acc, curr) => acc.merge(curr), offers[0])
}

function getCallIntentSegment<
  C extends CompactContract.Any,
  PCK extends CompactContract.ProvableCircuitId<C>,
>(callTx: UnsubmittedCallTxData<C, PCK>): number | undefined {
  return Array.from(callTx.private.unprovenTx.intents?.entries() ?? []).find(
    ([, intent]) => intent.actions.length > 0,
  )?.[0]
}

function reconcileMergedOffer<
  C extends CompactContract.Any,
  PCK extends CompactContract.ProvableCircuitId<C>,
  D extends CompactContract.Any,
  Q extends CompactContract.ProvableCircuitId<D>,
>(
  offer: Offer | undefined,
  callTxs: [UnsubmittedCallTxData<C, PCK>, UnsubmittedCallTxData<D, Q>],
): Offer | undefined {
  if (!offer) {
    return offer
  }

  const outputsByCommitment = new Map<CoinCommitment, typeof offer.outputs>()
  offer.outputs.forEach((output) => {
    if (!output.contractAddress) {
      return
    }

    const duplicateOutputs = outputsByCommitment.get(output.commitment) ?? []
    duplicateOutputs.push(output)
    outputsByCommitment.set(output.commitment, duplicateOutputs)
  })

  const knownContractOwnedOutputs = new Map<CoinCommitment, QualifiedShieldedCoinInfo>()
  callTxs.forEach((callTx) => {
    contractOwnedOutputCoinsByCommitment(callTx.private.nextZswapLocalState).forEach(
      (coin, commitment) => {
        if (!knownContractOwnedOutputs.has(commitment)) {
          knownContractOwnedOutputs.set(commitment, coin)
        }
      },
    )
  })

  const duplicatedCommitments = new Set(
    Array.from(outputsByCommitment.entries())
      .filter(
        ([, outputs]) => outputs.length > 1 && knownContractOwnedOutputs.has(outputs[0].commitment),
      )
      .map(([commitment]) => commitment),
  )

  if (duplicatedCommitments.size === 0) {
    return offer
  }

  const seenDuplicatedCommitments = new Set<CoinCommitment>()
  const repairedOutputs = offer.outputs.filter((output) => {
    if (!duplicatedCommitments.has(output.commitment)) {
      return true
    }

    if (seenDuplicatedCommitments.has(output.commitment)) {
      return false
    }

    seenDuplicatedCommitments.add(output.commitment)
    return true
  })

  return offerFromParts(offer.inputs, repairedOutputs, offer.transients)
}

function coalesceContractIntents<
  C extends CompactContract.Any,
  PCK extends CompactContract.ProvableCircuitId<C>,
  D extends CompactContract.Any,
  Q extends CompactContract.ProvableCircuitId<D>,
>(
  mergedTx: UnprovenTransaction,
  current: UnsubmittedCallTxData<C, PCK>,
  next: UnsubmittedCallTxData<D, Q>,
): void {
  const targetSegment = getCallIntentSegment(current)
  const sourceSegment = getCallIntentSegment(next)

  if (
    targetSegment === undefined ||
    sourceSegment === undefined ||
    targetSegment === sourceSegment ||
    !mergedTx.intents
  ) {
    return
  }

  const intents = new Map(mergedTx.intents)
  const targetIntent = intents.get(targetSegment)
  const sourceIntent = intents.get(sourceSegment)

  if (!targetIntent || !sourceIntent || sourceIntent.actions.length === 0) {
    return
  }

  targetIntent.actions = [...targetIntent.actions, ...sourceIntent.actions]
  targetIntent.ttl = new Date(Math.min(targetIntent.ttl.getTime(), sourceIntent.ttl.getTime()))
  intents.set(targetSegment, targetIntent)
  intents.delete(sourceSegment)
  mergedTx.intents = intents
}

export function mergeContractCallTxs<
  C extends CompactContract.Any,
  PCK extends CompactContract.ProvableCircuitId<C>,
  D extends CompactContract.Any,
  Q extends CompactContract.ProvableCircuitId<D>,
>(current: UnsubmittedCallTxData<C, PCK>, next: UnsubmittedCallTxData<D, Q>): UnprovenTransaction {
  const mergedTx = current.private.unprovenTx.merge(next.private.unprovenTx)

  coalesceContractIntents(mergedTx, current, next)
  mergedTx.guaranteedOffer = reconcileMergedOffer(mergedTx.guaranteedOffer, [current, next])

  if (mergedTx.fallibleOffer) {
    mergedTx.fallibleOffer = new Map(
      Array.from(mergedTx.fallibleOffer.entries(), ([segment, offer]) => [
        segment,
        reconcileMergedOffer(offer, [current, next])!,
      ]),
    )
  }

  return mergedTx
}
