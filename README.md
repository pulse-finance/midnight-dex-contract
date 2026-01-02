# midnight-dex-contract

Midnight AMM DEX contract, written in Compact.

This AMM contract doesn't require a batcher, and the main goal is to protect the treasury and liquidity providers. From the user's point-of-view, each swap is atomic.

## Compilation steps
 
1. install the compact toolchain (see https://docs.midnight.network/getting-started/installation#4-install-compact-using-the-installer-script)
2. `pnpm build`

## Testing steps

First make sure the compact compiler is installed. The contract unit tests can be run with the following commands:

1. `pnpm install`
2. `pnpm build`
3. `pnpm test`
