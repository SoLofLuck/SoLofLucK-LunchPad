# Architecture

## Accounts

| Account | Seeds | Owner | Purpose |
|---|---|---|---|
| `GlobalConfig` | `["config"]` | launchpad | Admin, fee recipient, pause flag, curve and Raydium parameters |
| `BondingCurve` | `["curve", mint]` | launchpad | Reserves, fee buckets, locks, status for one token |
| SOL vault | `["sol_vault", mint]` | **System Program** | Holds all of a token's SOL: reserves + accrued fees |
| Curve vault | ATA(curve, mint) | Token-2022 | Holds the unsold supply, the LP reserve and Creator Lock tokens |
| Mint | fresh keypair | Token-2022 | 6 decimals, MetadataPointer + TokenMetadata extensions, no authorities |

**Why a system-owned SOL vault?** Every SOL movement is then an ordinary System
Program transfer signed by the PDA — no hand-edited lamports — and the vault can
be the *creator* Raydium requires when creating a pool (the creator must pay rent
through the System Program). After every movement the program asserts
`vault ≥ rent minimum + real SOL reserves + creator fees + protocol fees`.

**Why fees accrue instead of being paid on every trade?** Paying a creator directly
on each trade lets a creator who empties their wallet below the rent-exempt minimum
make every small trade fail. Accrued fees are paid out on claim.

## Instructions

| Instruction | Who | What |
|---|---|---|
| `initialize_config` | program upgrade authority | One-time setup. Checks the ProgramData upgrade authority, so nobody can front-run initialization. |
| `update_config`, `set_paused`, `set_fee_recipient`, `transfer_admin` | admin | Bounds-checked (total fee ≤ 5%, virtual tokens > curve supply, …). |
| `accept_admin` | pending admin | Second step of the handover. |
| `create` | anyone | Mint + metadata + full supply to the curve; revoke mint and metadata authority; optional initial buy held under the Creator Lock. |
| `buy(max_sol_cost, min_tokens_out)` | anyone | Exact-SOL-in with a slippage floor. An oversized buy takes the remaining tokens, costs less, and completes the curve. |
| `sell(token_amount, min_sol_out)` | anyone | Rejected while the Sell Lock is active. Never affected by the pause. |
| `migrate` | anyone | Graduation, see below. |
| `claim_creator_fees` | creator | Pays accrued creator fees. Works after graduation too. |
| `claim_creator_lock` | creator | Releases the locked initial buy after the Creator Lock. |
| `collect_protocol_fees` | anyone | Pushes accrued protocol fees to the configured fee recipient. |

## Curve maths

Constant product over virtual reserves: `x · y = k` with `x = virtual SOL`,
`y = virtual tokens`. A buy of `s` net SOL returns `⌊y·s / (x+s)⌋` tokens; a sell of
`t` tokens returns `⌊x·t / (y+t)⌋` SOL, clamped to the real reserves. Fees are
`⌈amount · bps / 10 000⌉`. Every rounding favours the curve, so `k` never
decreases and a buy followed by a sell never profits (property-tested).

`app/src/lib/curve.ts` mirrors `programs/launchpad/src/math.rs` exactly so quotes in
the UI equal what the program does; both have tests pinned to the same cases.

## Sell Lock

`sell_unlock_at = created_at + sell_lock_seconds`. `sell` fails before it; so does
`migrate`, because after graduation trading moves to Raydium where the lock could
not be enforced. The old SoLofLuck site implemented this as a Token-2022 transfer
hook — Raydium rejects mints with a transfer hook, which forced those tokens onto
Meteora. Enforcing it in the curve removes that restriction entirely.

## Graduation (`migrate`)

1. Requires `status == Complete` and the Sell Lock expired.
2. `sol_to_pool = real_sol − migration_fee − pool_creation_budget`.
3. `tokens_to_pool = sol_to_pool · virtual_tokens / virtual_sol` (the curve's final
   price), capped by the LP reserve; the rest of the reserve is burned.
4. Tokens and wrapped SOL move into temporary ATAs of the SOL vault.
5. CPI to Raydium CPMM `initialize` with the SOL vault as creator. The pool account
   is a **fresh keypair** signed by the caller, not Raydium's deterministic PDA:
   that PDA depends only on (amm config, mint, WSOL), so anyone could create it
   first with dust and block graduation forever.
6. All LP tokens are burned; the temporary ATAs are closed (rent back to the
   caller). The migration fee and the budget act as one buffer for Raydium's
   costs; what is left of them goes to the fee recipient. Because both are
   snapshotted at creation, a later rise in Raydium's pool fee cannot block
   graduation of existing tokens. The solvency check proves Raydium never touched
   the creator's unclaimed fees or other balances.

The transaction has 25 accounts and serializes to 1086 bytes (limit 1232);
`scripts/check-tx-size.mjs` guards this in CI.

## Web app

Static site, hash routing, no backend:

- Token list: `getProgramAccounts` for curves + one batched `getMultipleAccounts`
  for the Token-2022 metadata; off-chain JSON (image, socials) fetched from the URI.
- Charts and trades: the `Trade` events in the logs of the curve account's
  transactions; live updates via `onLogs` / `onAccountChange` subscriptions.
- Transactions: signed by the wallet, broadcast over the site's RPC (never the
  wallet's network), priority fee, compute limit sized by simulation, re-broadcast
  until confirmed, errors mapped to the IDL's messages.
