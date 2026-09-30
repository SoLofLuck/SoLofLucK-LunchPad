# 🍀 SoLofLuck LaunchPad

A fair-launch token launchpad on Solana, in the spirit of pump.fun, with stronger
protections built into the program itself:

- **Bonding curve launches.** One transaction creates a Token-2022 token, mints the
  whole supply into the curve, revokes the mint authority and freezes the metadata.
  No presale, no team allocation, no freeze authority.
- **🔒 Sell Lock.** The creator picks a lock (none, 5 min, 15 min, 1 h, 5 h, 24 h).
  Until it expires *nobody* — creator included — can sell to the curve. Buying is
  always open. Enforced by the curve program, not a transfer hook, so the token
  stays a plain Token-2022 mint that Raydium accepts.
- **🛡️ Creator Lock.** The creator's own launch buy can be held by the program for
  1–90 days.
- **🎓 Graduation to Raydium CPMM.** When the curve sells out, anyone can migrate
  the liquidity. The pool opens at exactly the curve's final price and **every LP
  token is burned** in the same transaction.
- **Creator rewards.** A share of every trade accrues to the creator, claimable any time.

| | |
|---|---|
| `programs/launchpad` | Anchor program (Rust) + in-process tests |
| `app` | Web app (Vite + React + TypeScript) |
| `scripts` | Operator CLI, graduation crank, checks |
| `docs` | [Architecture](docs/ARCHITECTURE.md) · [Deploy guide](docs/DEPLOY.md) · [Security](docs/SECURITY.md) |

## Quick start

```bash
npm install
npm run dev                 # web app on http://localhost:5173 (devnet)
npm test                    # app tests + graduation transaction size check
npm run test:program        # 23 program tests (needs Rust)
```

App configuration lives in `app/.env` (see `app/.env.example`): network, RPC URL,
program ID and a Pinata JWT for image uploads.

## Default economics

Set on chain in the global config (`scripts/admin.mjs`), snapshotted into every
curve at creation so later changes never alter a live token's rules.

| Parameter | Default |
|---|---|
| Total supply | 1,000,000,000 (6 decimals) |
| Sold on the curve | 793,100,000 (79.31%) |
| Reserved for Raydium | 206,900,000 (the unused part is burned at graduation) |
| Virtual reserves | 30 SOL / 1,073,000,000 tokens |
| SOL to graduate | ≈ 85 SOL |
| Trading fee | 1% (0.7% protocol, 0.3% creator), hard cap 5% |
| Migration fee | 1 SOL, plus up to 0.25 SOL budget for Raydium's pool costs |

## Going live

Only one secret is needed; the workflows do the rest. See [docs/DEPLOY.md](docs/DEPLOY.md).

## Status

The program has **not been audited**. It is fully tested in-process (including a
Raydium CPMM mock that checks the exact account layout), and the *Rehearse on
devnet* workflow runs the whole lifecycle against the real Raydium program — make
sure it is green before mainnet.
