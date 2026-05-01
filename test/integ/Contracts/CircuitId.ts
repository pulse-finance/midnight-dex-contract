import { entryPointHash } from "@midnight-ntwrk/compact-runtime"
import { fromHex } from "@midnight-ntwrk/midnight-js-utils"

export type CircuitId = { address: { bytes: Uint8Array }; hash: Uint8Array }

export function circuitId(contractAddress: string, entrypoint: string): CircuitId {
  return {
    address: { bytes: fromHex(contractAddress) },
    hash: fromHex(entryPointHash(entrypoint)),
  }
}
