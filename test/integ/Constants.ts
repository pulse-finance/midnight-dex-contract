import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id"

export const NETWORK_ID = "undeployed"
setNetworkId(NETWORK_ID)

export const GENESIS_SEED_HEX = "0000000000000000000000000000000000000000000000000000000000000001"
export const PROOF_SERVER_URL = "http://127.0.0.1:6300"
export const INDEXER_URL = "http://127.0.0.1:8088/api/v4/graphql"
export const INDEXER_WS_URL = "ws://127.0.0.1:8088/api/v4/graphql/ws"
export const NODE_WS_URL = "ws://127.0.0.1:9944"

export const AMM_FEE_BPS = 10n
export const X_TOKEN_NAME = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
export const Y_TOKEN_NAME = Uint8Array.from({ length: 32 }, (_, index) => 255 - index)
export const INITIAL_X_LIQ = 1_000_000n
export const INITIAL_Y_LIQ = 2_000_000n
export const MINT_LP_X_IN = 100_000n
export const MINT_LP_Y_IN = 200_000n
export const BURN_LP_IN = 50_000n
export const SWAP_X_IN = 10_000n
export const SWAP_Y_IN = 20_000n
export const ZAP_IN_X_IN = 11_112n
export const ZAP_IN_Y_IN = 22_223n
export const ZAP_OUT_X_LP_IN = 7_777n
export const ZAP_OUT_Y_LP_IN = 6_666n
export const ORDER_OWNER_SECRET = new Uint8Array(32).fill(11)
export const AMM_BATCHER_SECRET = new Uint8Array(32).fill(7)
export const AMM_DEPLOY_CIRCUIT_BATCH_SIZE = 10

export const TX_TTL_MS = 60 * 60 * 1000
