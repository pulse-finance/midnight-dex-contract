import {
  CompactTypeField,
  CompactTypeVector,
  convertBytesToField,
  degradeToTransient,
  transientHash,
  upgradeFromTransient,
} from "@midnight-ntwrk/compact-runtime"
import { fromHex } from "@midnight-ntwrk/midnight-js-utils"

export type AddressArg = {
  is_left: boolean
  left: { bytes: Uint8Array }
  right: { bytes: Uint8Array }
}

export function bytes32(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? fromHex(value) : value
}

export function makeShieldedUserAddress(bytes: Uint8Array | string): AddressArg {
  return {
    is_left: true,
    left: { bytes: bytes32(bytes) },
    right: { bytes: new Uint8Array(32) },
  }
}

const NONCE_EVOLVE_DOMAIN = new TextEncoder().encode("midnight:kernel:nonce_evolve")
const TRANSIENT_HASH_PAIR_TYPE = new CompactTypeVector(2, CompactTypeField)

export function nonceEvolve(nonce: Uint8Array): Uint8Array {
  return upgradeFromTransient(
    transientHash(TRANSIENT_HASH_PAIR_TYPE, [
      convertBytesToField(NONCE_EVOLVE_DOMAIN.length, NONCE_EVOLVE_DOMAIN, "nonce_evolve"),
      degradeToTransient(nonce),
    ]),
  )
}
