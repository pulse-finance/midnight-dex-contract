# midnight-dex-contract

This project is built on the Midnight Network.

Midnight AMM DEX contract, written in Compact.

## Installing From GitHub

Install this package directly from GitHub instead of using npm (the artifacts are too large for npm):

```bash
pnpm add github:pulse-finance/midnight-dex-contract#<tag-or-commit>
```

When a consuming TypeScript project runs `pnpm install`, `pnpm` will execute this package's `prepare` hook, compile the contracts, and install the built library into `node_modules`.

You can then import the generated contracts through the package subpaths:

```ts
import * as AmmContract from "@pulsefinance/dex-contract/amm";
import * as FaucetContract from "@pulsefinance/dex-contract/faucet";
import * as MarketOrderContract from "@pulsefinance/dex-contract/marketorder";
import * as MintLpOrderContract from "@pulsefinance/dex-contract/mintlporder";
import * as BurnLpOrderContract from "@pulsefinance/dex-contract/burnlporder";
```

Pinning to a tag or commit is recommended so consumers get a reproducible Compact/compiler output.

### `prepare` lifecycle hook details

This package uses the `prepare` lifecycle hook to:

1. download the official Compact tool for the current OS/CPU architecture
2. bootstrap an isolated Compact artifact directory and pin the compiler version used by this repo
3. compile the contracts into `dist`

The first install is slower because it downloads Compact and generates the contract artifacts. Current upstream install docs for Compact are here: https://docs.midnight.network/getting-started/installation

## Testing

### Unit tests

The contract unit tests can be run with the following commands:

1. `pnpm install`
2. `pnpm build`
3. `pnpm test`

### Integration tests

The integration test suite in [test/integ.ts](/home/christian/Src/Pulse/midnight-dex-contract/test/integ.ts) runs against a local undeployed Midnight network.

Start the local Docker services first:

1. `docker compose -f ./compose.yml up -d`

Then, from this repository, run the integration test:

1. `pnpm install`
2. `pnpm build`
3. `bun test ./test/integ.ts`

## Order lifecycle

1. The user places an order in an open `*Order` contract slot (e.g. `MarketOrder`)
2. The batcher creates an order in an open `Amm` slot
3. The batcher sends an order coin from the order contract to the order coin slot in the AMM contract
4. For adding liquidity, the batcher sends a second order coin to the AMM contract, updating an AMM slot
5. Attackers can also send coins to a given `Amm` slot, but they must be merged
6. Once all necessary coins are in the contract (according the amounts specified in the order), the coins can be moved into primary merge addresses, and the order can be moved into the active slot (if it's open)
7. The active slot order is validated
8. The payout coins are created and moved to the order coin slots, the active slot is freed
9. The resulting order coin slots are sent to 