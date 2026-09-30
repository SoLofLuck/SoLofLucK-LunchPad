# Deploy guide

Everything runs from GitHub Actions; no local Solana toolchain is required.

## 1. Keys (once)

Create two keypairs locally (`solana-keygen new -o deploy.json` and
`solana-keygen new -o program.json`, or any tool that writes the 64-number JSON
format). Keep offline backups; never commit them.

| Secret | Content |
|---|---|
| `LAUNCHPAD_DEPLOY_KEY` | `deploy.json` — pays for deploys and becomes the **upgrade authority** and config admin |
| `LAUNCHPAD_PROGRAM_KEYPAIR` | `program.json` — its public key is the program ID |

Add them under *Settings → Secrets and variables → Actions*.

## 2. Deploy the program to devnet

*Actions → Deploy program → Run workflow*: network `devnet`, and set
`init_fee_recipient` to the wallet that should receive protocol fees. The run
builds with the real SBF toolchain, deploys, initializes the config with the
default economics, and prints the program ID in the run summary.

Then point the repository at it:

```bash
node scripts/sync-program-id.mjs program.json   # declare_id, Anchor.toml, app IDL
git commit -am "chore: set program id" && git push
```

## 3. Publish the site

Repository **variables**: `VITE_NETWORK` = `devnet`, `VITE_PROGRAM_ID` = the ID.
Repository **secrets** (optional but recommended): `VITE_RPC_URL` (e.g. Helius),
`VITE_PINATA_JWT` (Files: Write only). *Settings → Pages → Source: GitHub Actions.*
Every push to `main` touching `app/` redeploys.

## 4. Automatic graduation (optional)

Secret `CRANK_KEY`: a small hot wallet with ~0.1 SOL for fees. `crank.yml` runs every
15 minutes and graduates every completed curve whose Sell Lock has expired. Users
can also press *Graduate to Raydium* on the token page.

## 5. Devnet rehearsal — do this before mainnet

1. Create a token with a 5-minute Sell Lock and a small initial buy.
2. Buy from a second wallet; confirm selling is refused until the lock expires.
3. Buy the curve out (≈85 SOL of devnet SOL; lower `initialVirtualSolReserves` /
   `curveTokenSupply` with `admin.mjs update` to rehearse cheaply).
4. Graduate. On Solscan, check the Raydium pool, that the LP mint supply is 0
   (plus Raydium's locked 100 units), and the fee recipient's receipt.
5. Claim creator fees and the Creator Lock.

## 6. Mainnet

Run *Deploy program* with network `mainnet-beta` and the confirmation text. It costs
roughly 3 SOL of rent. Switch `VITE_NETWORK` to `mainnet-beta`. Consider moving the
upgrade authority and admin to a multisig (`admin.mjs transfer-admin`, then
`solana program set-upgrade-authority`).

## Operator CLI

```bash
NETWORK=devnet KEYPAIR=deploy.json node scripts/admin.mjs status
node scripts/admin.mjs update '{"migrationFeeLamports": 500000000}'
node scripts/admin.mjs pause        # create + buy only; sells/claims/migrate stay open
node scripts/admin.mjs collect-fees
```
