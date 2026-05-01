import { ContractAddress, rawTokenType } from "@midnight-ntwrk/ledger-v8"
import { fromHex } from "@midnight-ntwrk/midnight-js-utils"

export function encodeName(name: string): Uint8Array {
  const bytes = new Uint8Array(32)
  bytes.set(new TextEncoder().encode(name).slice(0, bytes.length))
  return bytes
}

export function color(name: Uint8Array, address: ContractAddress): Uint8Array {
  return fromHex(rawTokenType(name, address))
}
