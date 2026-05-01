import type {
  FinalizedCallTxData,
  UnsubmittedCallTxData,
} from "@midnight-ntwrk/midnight-js-contracts"

function littleEndianHexToField(hex: string): bigint {
  const normalizedHex = hex.length === 66 && hex.startsWith("73") ? hex.slice(2) : hex
  const bytes = Buffer.from(normalizedHex, "hex")
  let value = 0n

  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[index])
  }

  return value
}

export function commOpening(
  tx: FinalizedCallTxData<any, any> | UnsubmittedCallTxData<any, any>,
): bigint {
  return littleEndianHexToField(tx.private.communicationCommitmentRand)
}
