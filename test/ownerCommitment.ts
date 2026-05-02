import {
  Bytes32Descriptor,
  CompactTypeVector,
  encodeContractAddress,
  persistentHash,
} from "@midnight-ntwrk/compact-runtime"

type AddressLike = string | Uint8Array | { bytes: Uint8Array }

const ownerCommitmentType = new CompactTypeVector(2, Bytes32Descriptor)

function addressBytes(address: AddressLike): Uint8Array {
  if (typeof address === "string") {
    return encodeContractAddress(address)
  }

  if (address instanceof Uint8Array) {
    return address
  }

  return address.bytes
}

export function computeOwnerCommitment(address: AddressLike, ownerSecret: Uint8Array): Uint8Array {
  return persistentHash(ownerCommitmentType, [addressBytes(address), ownerSecret])
}
