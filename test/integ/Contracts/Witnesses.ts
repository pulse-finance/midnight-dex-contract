export function newNonce(seed: number) {
  let index = seed
  return (context: { privateState: undefined }): [undefined, Uint8Array] => {
    index += 1
    return [context.privateState, deterministicNonce(index)]
  }
}

export function actorSecret(secret: Uint8Array) {
  return (context: { privateState: undefined }) => [context.privateState, secret]
}

function deterministicNonce(index: number): Uint8Array {
  const bytes = new Uint8Array(32)
  bytes[30] = (index >> 8) & 0xff
  bytes[31] = index & 0xff
  return bytes
}
