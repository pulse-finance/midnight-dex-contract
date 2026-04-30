export type Address = {
    is_left: boolean,
    left: {bytes: Uint8Array},
    right: {bytes: Uint8Array}
}

function makePubKeyAddress(bytes: Uint8Array): Address {
    return {
        is_left: true,
        left: {bytes},
        right: {bytes: new Uint8Array(32)}
    }
}

function makeContractAddress(bytes: Uint8Array): Address {
    return {
        is_left: true,
        left: {bytes: new Uint8Array(32)},
        right: {bytes}
    }
}

export const treasury: Address = makePubKeyAddress(new Uint8Array(32).fill(1))
export const user1: Address = makePubKeyAddress(new Uint8Array(32).fill(2))
export const user2: Address = makePubKeyAddress(new Uint8Array(32).fill(3))
