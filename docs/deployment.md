# Deploying GetLeash on mainnet

The flow used for `getleash.onanikes.near` on 2 Nov 2026, rehearsed first on testnet
(`getleash.getleash-owner.testnet`). The owner runs every step that signs, on the owner's own machine.
Each script prints what it will sign and what it costs, then asks `[y/N]`; run them in a terminal app,
not through a tool without a terminal. Transaction ids and measured costs: [verified-facts.md](verified-facts.md).

## What you end up with

| Account | Created by | Keys | Holds | Can |
|---|---|---|---|---|
| `you.near` (owner) | you | your wallet, and near-cli while you deploy | NEAR for gas, USDC to top up | approve and reject payments, add suppliers, set limits, pause, withdraw, upgrade |
| `getleash.you.near` (policy contract) | setup | **none** | the treasury (USDC) and 1.05 NEAR, 0.84 of it for its code | pay only suppliers on your list, within your limits |
| `agent-1.you.near` | setup | one function-call key for `propose` | 0.15 NEAR for gas | propose a payment |
| `executor-1.you.near` | setup | one function-call key for `create_attempt`, `fund`, `forget` | 0.20 NEAR for gas | quote and fund cross-chain payments the contract already approved |

## Costs (measured 2 Nov 2026)

- Setup: **1.424 NEAR**: 1.4 NEAR moved into the three accounts, 0.00125 NEAR to register the contract on
  USDC, about 0.023 NEAR of gas.
- Each supplier paid on NEAR: 0.00125 NEAR to register it on USDC, plus gas. The contract pays its own
  storage for the supplier record.
- Each payment: about 0.0007 NEAR of gas. A cross-chain payment also takes 0.00125 NEAR from the contract
  (it registers the 1Click deposit account) and 1Click's fees in USDC (the Tron withdrawal fee was
  0.21–0.85 USDT when checked).
- Keep about 1.6 NEAR in the owner account. The treasury's USDC is up to you; the mainnet policy lets at
  most 20 USDC leave per day.

## Before you start

1. **Tools.** Node.js 22 or later and pnpm (`corepack enable`), then `pnpm install` in the repository.
   near-cli-rs: `npm install -g near-cli-rs` (with asdf-managed Node, run `asdf reshim nodejs` afterwards).
2. **Owner account.** A named mainnet account (`you.near`), because setup creates accounts under it, with
   at least 1.6 NEAR.
3. **Owner key in near-cli** on this machine. The scripts sign with it; the services never get it. In a
   terminal: `near account import-account`, choose the seed phrase or the private key (`ed25519:…`, not
   a password), then mainnet, then the legacy keychain. Then `chmod -R go-rwx ~/.near-credentials`:
   near-cli-rs 0.30.1 writes the key file readable by other users, seed phrase included.
4. **USDC.** Circle's native USDC on NEAR (`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`),
   not the bridged USDC.e. Register the owner on it first (0.00125 NEAR):
   ```bash
   near contract call-function as-transaction 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 storage_deposit json-args '{"account_id":"you.near","registration_only":true}' prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as you.near network-config mainnet sign-with-keychain send
   ```
   → `{"available": "0", "total": "1250000000000000000000"}`. Then swap NEAR for USDC in a NEAR wallet, or
   withdraw USDC to `you.near` from an exchange on the NEAR network.
5. **Service secrets** in `.env` (copy `.env.example`): `NEAR_AI_API_KEY`, `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_OWNER_CHAT_ID`, `TELEGRAM_ALLOWED_USER_IDS`, `TELEGRAM_ALLOWED_CHAT_IDS`, `TENANT_SECRET`,
   `INVOICE_STORE_KEY`, and optionally `ONECLICK_JWT`, which lowers 1Click's fee on stablecoin routes.
6. **The release wasm** at `contract/target/near/getleash_policy.wasm`, sha256
   `8eaccbf19a011b67eb70f603a97b992831bec2485478587ae6973768b7640a3d` (to rebuild it yourself, see the
   README, "Try it", step 7). Setup refuses any other file on mainnet.

## Deploy

1. **Service keys**, on the machine that runs the services (local files only):
   ```bash
   pnpm keygen --network mainnet --account agent-1.you.near
   pnpm keygen --network mainnet --account executor-1.you.near
   ```
   → `.keys/mainnet/agent-1.you.near.json` and `executor-1…`, mode 0600, git-ignored.

2. **Contract and role accounts** (four transactions, 1.424 NEAR):
   ```bash
   pnpm setup:owner --network mainnet --owner you.near --wasm-sha256 8eaccbf19a011b67eb70f603a97b992831bec2485478587ae6973768b7640a3d --policy deploy/mainnet-policy.json
   ```
   → after `y`: creates `agent-1` and `executor-1`; creates, deploys and initialises `getleash.you.near`
   in one batch; registers it on USDC. Then "Verifying from chain state" lists, all ✓: 0 access keys on
   the contract, the deployed code matches the wasm, the owner, agent, executor and token, a trust budget
   of 0, and each role account holding only its function-call key.

3. **Suppliers.** Write `.data/mainnet/suppliers.json` (git-ignored; names stay off-chain):
   ```json
   { "suppliers": [
     { "name": "Chisolu", "aliases": ["chisolu.near"], "chain": "NEAR", "recipient": "chisolu.near",
       "typical_amount": "2", "currency": "USD" },
     { "name": "Shenzhen Parts Co.", "chain": "TRON", "recipient": "T…",
       "asset_id": "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near",
       "typical_amount": "2", "currency": "USDT" } ] }
   ```
   ```bash
   pnpm seed --network mainnet --owner you.near --file .data/mainnet/suppliers.json
   ```
   → registers each NEAR supplier on USDC, adds each supplier, writes `.data/mainnet/directory.json`.
   **Each new supplier starts a 2-day cooldown** (`cooldown_ns` in `deploy/mainnet-policy.json`): until
   it ends, every payment to it waits for you and is capped at 0.50 USDC. Add suppliers at least two days
   before you need larger payments. Running `pnpm seed` again adds only the new entries.

4. **Treasury:**
   ```bash
   pnpm topup --network mainnet --owner you.near --amount 4.91
   ```
   → `treasury balance 4.91 USDC`.

5. **Service configuration.** `.env.mainnet` (git-ignored) sits on top of `.env`; the later file wins, so
   a testnet configuration in `.env` stays intact:
   ```bash
   NEAR_NETWORK=mainnet
   OWNER_ACCOUNT_ID=you.near
   POLICY_CONTRACT_ID=getleash.you.near
   AGENT_ACCOUNT_ID=agent-1.you.near
   EXECUTOR_ACCOUNT_ID=executor-1.you.near
   DASHBOARD_URL=http://localhost:3000
   # fresh, so mainnet invoice ids and the invoice store share nothing with testnet:
   TENANT_SECRET=     # openssl rand -hex 32
   INVOICE_STORE_KEY= # openssl rand -hex 32
   ```

6. **Run the services**, each in its own terminal (Ctrl-C stops it):
   ```bash
   pnpm exec tsx --env-file=.env --env-file=.env.mainnet executor/src/main.ts
   pnpm exec tsx --env-file=.env --env-file=.env.mainnet channels/telegram/src/main.ts
   NEXT_PUBLIC_NEAR_NETWORK=mainnet NEXT_PUBLIC_POLICY_CONTRACT_ID=getleash.you.near pnpm dashboard
   ```
   → `executor executor-1.you.near → getleash.you.near on mainnet`, `@<your bot> is listening`, and the
   dashboard at http://localhost:3000. One Telegram bot token serves one process at a time: stop a
   testnet bot first, or use a second bot.

7. **Check:**
   ```bash
   pnpm status --network mainnet --policy getleash.you.near
   ```
   → the treasury, today's limits, open payments, `0 access keys (must be 0)` and each role account's gas.

8. **First payment.** Send the bot an invoice from a supplier on file, 0.50 or less while its cooldown
   runs. It replies that the payment needs your OK because the supplier's details changed recently.
   Open the link, click the button and approve in your wallet → "Paid" on the dashboard and in Telegram.

## Host the services and the dashboard

Instead of step 6 on your own machine: the executor and the bot run as one Render background worker
([render.yaml](../render.yaml)), and the dashboard runs on Vercel. Nothing that signs as the owner goes to
either host: steps 1–4 stay on your machine, and the worker holds only the agent's and the executor's
function-call keys.

| What | Where | Notes |
|---|---|---|
| Executor and bot | Render background worker `getleash-services`, Starter plan (workers have no free plan), 1 GB disk at `/var/data` | `scripts/src/services.ts` runs both and starts either again if it stops; the disk keeps the executor's journal, the bot's update log, the encrypted invoices and the record that sends each owner notice once |
| Dashboard | Vercel project, root directory `web` | a public address, so the links in Telegram open on a phone; it reads the chain in the visitor's browser |

1. Do steps 1–4 from your machine, and stop any GetLeash bot running elsewhere: one bot token serves one
   process.
2. Gather the values to paste:
   ```bash
   pnpm deploy:env --network mainnet
   ```
   → `.env.render` and `.env.vercel` (mode 0600, git-ignored). They hold secrets, so paste them into the
   two hosts only and then delete them (`rm .env.render .env.vercel`). Only variable names are printed.
   Both carry the supplier names as `GETLEASH_DIRECTORY_BASE64`, because neither host has your files.
3. **Render:** New → Blueprint → connect the repository → Render reads `render.yaml` and shows the
   `getleash-services` worker and its plan. Paste `.env.render` (`pbcopy < .env.render` copies it without
   showing it) on its Environment page with "Add from .env", or fill in the values the Blueprint asks for.
4. **Vercel:** Add New → Project → import the repository → set the root directory to `web` (Vercel
   detects Next.js and the pnpm workspace) → in Environment Variables, paste `.env.vercel` → Deploy.
5. Set the worker's `DASHBOARD_URL` on Render to the dashboard's address (`https://….vercel.app`, or your
   own domain); saving redeploys the worker.
6. The worker's logs show `executor executor-1.you.near → getleash.you.near on mainnet` and
   `@<your bot> is listening`. Then send the first test invoice (step 8).

After `pnpm seed` adds a supplier, run `pnpm deploy:env` again and update `GETLEASH_DIRECTORY_BASE64` on
both hosts. The dashboard's private view shows supplier names, not invoice records: those stay encrypted
on the worker's disk. `NEXT_PUBLIC_*` values are built into the dashboard, so changing one needs a new
Vercel deployment.

## Day to day

- **Approve:** the Telegram link opens the payment with one button. A browser wallet (Meteor, HOT, Intear,
  MyNearWallet) approves in one tap; with near-cli, the page offers the ready-to-run command.
- **Pause everything:** dashboard → Pause, one signature. Unpausing works the same way.
- **Top up:** `pnpm topup --network mainnet --owner you.near --amount <USDC>`.
- **Withdraw** (only the owner can, the money goes only to the owner, and it works while paused). The
  amount is in USDC base units (6 decimals):
  ```bash
  near contract call-function as-transaction getleash.you.near withdraw json-args '{"amount":"4910000"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as you.near network-config mainnet sign-with-keychain send
  ```
- **Add a supplier:** add it to the suppliers file and run `pnpm seed` again; it starts its own cooldown.
- **Replace a service key:** `pnpm keygen --network mainnet --account executor-2.you.near`, then
  `pnpm rotate --network mainnet --owner you.near --role executor --n 2 --public-key ed25519:…`.

## Keep the owner key safe

The owner key is the only key that can change anything; the contract has none, and NEAR itself limits
the agent's and the executor's keys to their own methods. After setup, seeding and the first top-up, you
can delete `~/.near-credentials/mainnet/you.near.json` and the `you.near/` folder next to it, and approve
from a browser wallet that holds the account (or a Ledger). Import it again with
`near account import-account` the next time you run a script.

## Testnet rehearsal

The same flow with `--network testnet`: faucet accounts (`near account create-account
sponsor-by-faucet-service you.testnet autogenerate-new-keypair save-to-legacy-keychain network-config
testnet create`), USDC from https://faucet.circle.com, `--policy deploy/testnet-policy.json` (a 10-minute
cooldown), and, because 1Click runs on mainnet only, the 1Click stand-in: `pnpm mock:1click --network
testnet --solver <account>` with the executor started with `--mock` (see the header of
`scripts/src/mock-1click.ts`). What it measured is in verified-facts.md, "GetLeash v2 on testnet".
