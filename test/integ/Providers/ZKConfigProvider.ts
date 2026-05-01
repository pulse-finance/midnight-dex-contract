import path from "node:path";
import { readFile } from "node:fs/promises";

import {
  type ProverKey,
  type VerifierKey,
  ZKConfigProvider,
  type ZKIR
} from "@midnight-ntwrk/midnight-js-types";

const BUILTIN_CIRCUITS: Record<string, string> = {
  "midnight/zswap/spend": "ZswapSpend",
  "midnight/zswap/output": "ZswapOutput",
  "midnight/zswap/sign": "ZswapSign",
  "midnight/dust/spend": "DustSpend",
};

const DIST_DIR = path.join(__dirname, "..", "..", "..", "dist")

export class LocalFileZKConfigProvider extends ZKConfigProvider<string> {
  constructor() {
    super();
  }


  getZKIR(circuitId: string): Promise<ZKIR> {
    return readAsset<ZKIR>(circuitId, ".bzkir")
  }

  getProverKey(circuitId: string): Promise<ProverKey> {
    return readAsset<ProverKey>(circuitId, ".prover")
  }

  getVerifierKey(circuitId: string): Promise<VerifierKey> {
    return readAsset<VerifierKey>(circuitId, ".verifier")
  }
}

async function readAsset<T extends Uint8Array>(circuitId: string, extension: string): Promise<T> {
    const assetKind = extension.endsWith("zkir") ? "zkir" : "keys"

    let circuitPath: string

    if (circuitId in BUILTIN_CIRCUITS) {
        const localCircuitId = BUILTIN_CIRCUITS[circuitId];

        circuitPath = path.join(__dirname, "MidnightCircuits", `${localCircuitId}${extension}`)
    } else {
        if (circuitId.startsWith("Amm")) {
            circuitPath = path.join(DIST_DIR, "amm", assetKind, `${circuitId}${extension}`)
        } else if (circuitId.startsWith("Faucet")) {
            circuitPath = path.join(DIST_DIR, "faucet", assetKind, `${circuitId}${extension}`)
        } else if (circuitId.startsWith("MintLpOrder")) {
            circuitPath = path.join(DIST_DIR, "mintlporder", assetKind, `${circuitId}${extension}`)
        } else if (circuitId.startsWith("BurnLpOrder")) {
            circuitPath = path.join(DIST_DIR, "burnlporder", assetKind, `${circuitId}${extension}`)
        } else if (circuitId.startsWith("MarketOrder")) {
            circuitPath = path.join(DIST_DIR, "marketorder", assetKind, `${circuitId}${extension}`)
        } else {
            console.error(`Unable to resolve circuit ${circuitId}`)
            throw new Error(`Unable to resolve circuit ${circuitId}`)
        }
    }

    try {
        const bytes = await readFile(circuitPath)
        return new Uint8Array(bytes) as T
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Failed to load '${circuitId}' asset from '${circuitPath}': ${message}`)
    }
}
