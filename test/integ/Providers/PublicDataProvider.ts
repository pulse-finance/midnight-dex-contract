import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { PublicDataProvider } from "@midnight-ntwrk/midnight-js-types";
import { INDEXER_URL, INDEXER_WS_URL } from "../Constants";

export function makePublicDataProvider(): PublicDataProvider {
    return indexerPublicDataProvider(
        INDEXER_URL,
        INDEXER_WS_URL
    )
}