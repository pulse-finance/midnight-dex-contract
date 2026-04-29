# Compact Contract Security Audit

## Findings

### 1. Critical: anyone can finalize AMM pending orders with hostile parameters

AMM start circuits require `assertOnlyBatcher()`, but validation/finalization circuits do not. A third party can wait for a pending order and call validators with adverse but invariant-valid values, e.g. `lpOut = 0`, `yOut = 0`, or `xOut = 0`, then finalize. That can donate a user's deposited assets to the pool or burn LP for little/no return.

Affected code:

- `src/Amm.compact:565` `AmmValidateDepositXYLiq`
- `src/Amm.compact:605` `AmmValidateDepositXLiq`
- `src/Amm.compact:658` `AmmValidateDepositYLiq`
- `src/Amm.compact:712` `AmmValidateSwapXToY`
- `src/Amm.compact:748` `AmmValidateSwapYToX`
- `src/Amm.compact:785` `AmmValidateWithdrawXYLiq`
- `src/Amm.compact:820` `AmmValidateWithdrawXLiq`
- `src/Amm.compact:870` `AmmValidateWithdrawYLiq`
- `src/Amm.compact:413` `AmmMintLp`
- `src/Amm.compact:464` `AmmSendX`
- `src/Amm.compact:514` `AmmSendY`

Recommendation: require batcher authorization on validation/finalizer circuits, or bind expected validation arguments to the started order.

### 2. Critical: order callback circuits can be spoofed by anyone

`MarketOrderReceiveFromAmm`, `MintLpOrderReceiveFromAmm`, and `BurnLpOrderReceiveFromAmm` accept any caller-provided shielded coin with the stored return color and arbitrary amount. They do not authenticate that the AMM made the callback or that the amount/nonce corresponds to a claimed AMM return. An attacker can deposit a tiny return coin after `SendToAmm`, occupy the slot, and let the owner close for the fake amount while the real AMM return later fails or is blocked.

Affected code:

- `src/MarketOrder.compact:83` `MarketOrderReceiveFromAmm`
- `src/MintLpOrder.compact:110` `MintLpOrderReceiveFromAmm`
- `src/BurnLpOrder.compact:86` `BurnLpOrderReceiveFromAmm`

Recommendation: authenticate callbacks through the contract-call mechanism, restrict caller/circuit identity, and bind expected callback payloads.

### 3. High: `AmmInitXYLiq` lets whoever initializes first become the batcher

The constructor does not set `batcherCommitment`; `AmmInitXYLiq` sets it from the caller's witness without an existing authorization check. If deployment and initialization are separate, a front-runner can initialize first, become the batcher, and later update treasury/fee and operate restricted entry circuits.

Affected code:

- `src/Amm.compact:73` `AmmInitXYLiq`
- `src/Amm.compact:83` `batcherCommitment = disclose(generateBatcherCommitment())`

Recommendation: pass the intended batcher commitment in the constructor, or require init to prove a deployer/admin secret.

### 4. High: public AMM merge circuits can grief or corrupt pending flow sequencing

`AmmMergeXLiq` and `AmmMergeYLiq` are public and have no slot/kind guard. During a pending order, anyone can merge temporary coins into reserves before validation or before intended sequencing. Some cases may still reconcile, but failures can strand a pending slot or force later operations into unexpected state.

Affected code:

- `src/Amm.compact:382` `AmmMergeXLiq`
- `src/Amm.compact:396` `AmmMergeYLiq`

Recommendation: restrict merges to batcher and/or only allow them after the corresponding pending order has completed.

### 5. Medium: AMM can enter zero-LP, non-reinitializable states with stranded reserves/rewards

Deposits reject `lpCirculatingSupply == 0`, but withdrawals can burn all LP while leaving reserve coin dust or rewards. `AmmInitXYLiq` only checks LP supply, then tries inserting into occupied reserve slots, so reinit can fail. `AmmReward` also requires change, so if rewards equal the full X coin value, reward payout fails.

Affected code:

- `src/Amm.compact:80` `assert(lpCirculatingSupply == 0, "Already initialized")`
- `src/Amm.compact:128` deposit initialization check
- `src/Amm.compact:447` `AmmReward`
- `src/Amm.compact:805` LP supply reduction on withdrawal

Recommendation: define an explicit pool shutdown/reinit path, allow full-coin sends where intended, or prevent LP supply from reaching zero unless reserves/rewards are fully cleared.

### 6. Medium: oracle circuits can report stale/manipulable values during pending orders

`AmmXLiq`/`AmmYLiq` return ledger liquidity, but start circuits receive coins before validation updates liquidity. During pending swaps/deposits/withdrawals, reported liquidity can diverge from actual reserve coins. Consumers using these as oracle feeds can read stale values.

Affected code:

- `src/Amm.compact:59` `AmmXLiq`
- `src/Amm.compact:64` `AmmYLiq`

Recommendation: avoid exposing these as oracle feeds, include pending-state guards, or expose values only when `slot` is empty.

## Main Assumption

If the batcher is intended to be fully trusted to choose prices and execute all phases, findings 1 and 4 are still bugs because those phases are currently public, not batcher-only.
