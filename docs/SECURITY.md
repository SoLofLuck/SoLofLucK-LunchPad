# Security notes

## Guarantees enforced by the program

- **Fixed supply.** The mint authority is set to `None` in the creation instruction; no freeze authority is ever set.
- **Immutable metadata.** The Token-2022 metadata update authority is set to `None` at creation.
- **Solvency.** After every SOL movement, the token's SOL vault must hold its rent minimum plus the real reserves plus both fee buckets, or the transaction fails.
- **Rounding favours the curve.** `k` never decreases; buy-then-sell never profits (unit and randomized integration tests).
- **Slippage limits** on buy (`min_tokens_out`) and sell (`min_sol_out`).
- **Pause cannot trap funds.** It stops `create` and `buy` only.
- **Config changes cannot alter live tokens.** Fees, economics and migration costs are snapshotted into each curve.
- **Fee caps.** Protocol + creator fee ≤ 5% whatever the admin sets.
- **Initialization cannot be front-run.** Only the program's upgrade authority can call `initialize_config`.
- **Two-step admin handover.**
- **Graduation cannot be griefed** by pre-creating the Raydium pool (fresh pool keypair), and Raydium accounts that matter (program, AMM config, fee receiver) are pinned by the config.
- **LP burned.** All LP tokens minted at graduation are burned in the same transaction.

## Trust assumptions

- The **admin** can change parameters for *future* tokens, pause new launches/buys, and change the fee recipient.
- The **upgrade authority** can replace the program. Move it to a multisig, or make the program immutable once stable.
- Raydium CPMM is trusted to behave as documented; the pool creation budget bounds what it can spend from the vault.

## Known limitations

- Not audited.
- The Sell Lock applies to the curve. Tokens can still be transferred wallet-to-wallet during the lock (that does not sell into the curve).
- The web app reads history from RPC; a rate-limited public RPC shows partial charts. Use a dedicated RPC.
- `local-testing` feature skips the upgrade-authority check for the in-process tests; CI and deploys never enable it.
