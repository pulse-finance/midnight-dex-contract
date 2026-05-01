import { ZKConfigProvider } from "@midnight-ntwrk/midnight-js-types";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { PROOF_SERVER_URL } from "../Constants";

export function makeProofProvider(zkConfigProvider: ZKConfigProvider<string>) {
    return httpClientProofProvider(PROOF_SERVER_URL, zkConfigProvider)
}
