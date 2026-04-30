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

1. `cd ../claim-contract-call-tests`
2. `docker compose -f ./compose.yml up -d`

Then, from this repository, run the integration test:

1. `pnpm install`
2. `pnpm build`
3. `bun test ./test/integ.ts`

