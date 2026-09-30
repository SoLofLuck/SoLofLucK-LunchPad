# Deploy guide

Everything runs from GitHub Actions; you never need the Solana CLI.

## What you do (once)

1. **Make the deploy key.**
   ```bash
   npm install
   node scripts/new-keypair.mjs deploy-key.json
   ```
   It prints the public address. Keep `deploy-key.json` backed up offline: it is
   the program's upgrade authority and the launchpad admin. Never commit it.
2. **Fund it with devnet SOL.** Paste the address at https://faucet.solana.com
   (sign in with GitHub for the higher limit). About **10 SOL** covers the program
   deploy (~4 SOL of rent) and the end-to-end rehearsal (~5 SOL). The workflow also
   tries the RPC airdrop, which is often rate limited.
3. **Add the secret.** GitHub → *Settings → Secrets and variables → Actions →
   New repository secret*: name `LAUNCHPAD_DEPLOY_KEY`, value = the full content of
   `deploy-key.json` (the `[12,34,...]` array).
4. **Enable Pages.** *Settings → Pages → Source: GitHub Actions* (one-time).
5. **Run it.** *Actions → Deploy program → Run workflow* (network `devnet`).

## What the workflow does for you

- Builds the program with the real SBF toolchain.
- First run on a network: generates the program address, deploys, initializes the
  config (fee recipient = the deploy wallet unless you enter another), commits the
  address to `app/src/program-ids.json`, and redeploys the site.
- Later runs: upgrade the program in place.
- On devnet, starts **Rehearse on devnet**: a real token goes through the whole
  lifecycle against Raydium — create, buy, Sell Lock refusal, buy-out, graduation,
  LP burn check, claims. Its summary lists every check with ✅/❌.
- **Crank** (every 15 minutes) graduates completed curves automatically, using the
  deploy key (or a separate `CRANK_KEY` secret if you add one).

## Optional

| Where | Name | Why |
|---|---|---|
| Secret | `VITE_RPC_URL` | A dedicated RPC (Helius, Triton…). Public RPCs rate-limit chart history. |
| Secret | `VITE_PINATA_JWT` | Logo uploads on the Create page (Pinata key with *Files: Write* only). Without it, creators paste a metadata URI. |
| Secret | `CRANK_KEY` | A separate hot wallet for the crank instead of the deploy key. |
| Variable | `VITE_NETWORK` | `mainnet-beta` once you launch there (default `devnet`). |

## Mainnet

1. Rehearsal on devnet is green.
2. Fund the deploy wallet with ~5 SOL on mainnet.
3. *Deploy program* with network `mainnet-beta` and the confirmation text.
4. Set the `VITE_NETWORK` variable to `mainnet-beta` and re-run *Deploy app*.
5. Strongly recommended: move the admin and upgrade authority to a multisig
   (`admin.mjs transfer-admin`, then `solana program set-upgrade-authority`).

Mainnet defaults: ~85 SOL to graduate, 1% trading fee (0.7% protocol / 0.3%
creator), 1 SOL migration fee. Devnet uses the same curve scaled down 20× (~4.25
SOL) so it can be tested with faucet SOL.

## Operator CLI

```bash
NETWORK=devnet KEYPAIR=deploy-key.json node scripts/admin.mjs status
node scripts/admin.mjs update '{"migrationFeeLamports": 500000000}'
node scripts/admin.mjs pause        # create + buy only; sells/claims/migrate stay open
node scripts/admin.mjs collect-fees
NETWORK=devnet KEYPAIR=deploy-key.json node scripts/rehearse.mjs
```
