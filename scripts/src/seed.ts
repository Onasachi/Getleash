/**
 * Adds suppliers from a JSON file and records their names in the private off-chain directory.
 * New suppliers start in cooldown: until it ends, every payment to them waits for the owner, who
 * can approve at most `cooldown_max` (a test payment). Native NEAR suppliers are registered on the
 * treasury token here (paid by the owner), because the contract pays only registered accounts.
 *
 *   pnpm seed --network mainnet --owner yourbusiness.near --file suppliers.json
 *
 * suppliers.json:
 *   { "suppliers": [
 *       { "name": "Acme Packaging Ltd", "chain": "NEAR", "recipient": "acme.near",
 *         "typical_amount": "18", "currency": "USD" },
 *       { "name": "Shenzhen Parts Co.", "chain": "TRON", "recipient": "T…",
 *         "asset_id": "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near",
 *         "typical_amount": "2", "currency": "USDT" } ] }
 * `asset_id` defaults to the treasury token (native) for NEAR; `decimals` defaults to 6.
 */
import { readFileSync } from "node:fs";

import { z } from "zod";

import {
  CHAINS,
  defaultRoleIds,
  InvoiceCurrency,
  isNative,
  isTronAddress,
  OwnerClient,
  PolicyView,
  registerOnToken,
} from "@getleash/shared";
import { directoryPath, loadDirectory, saveDirectory } from "@getleash/shared/node";

import { confirm, fail, ok, ownerAccount, parse, required, step } from "./lib/cli.ts";

const Decimal = z.string().regex(/^\d+(\.\d+)?$/);
const SeedFile = z.object({
  suppliers: z.array(
    z.object({
      name: z.string(),
      aliases: z.array(z.string()).default([]),
      chain: z.enum(CHAINS),
      asset_id: z.string().optional(),
      recipient: z.string(),
      decimals: z.number().int().min(0).max(24).default(6),
      contact: z.string().optional(),
      typical_amount: Decimal.optional(),
      currency: InvoiceCurrency,
    }),
  ),
});

const { values, common } = parse(
  { owner: { type: "string" }, "owner-key-file": { type: "string" }, policy: { type: "string" }, file: { type: "string" } },
  "Usage: pnpm seed --network <net> --owner <you.near> --file <suppliers.json> [--policy <contract>]",
);
const ownerId = required(values.owner, "owner");
const policyId = (values.policy as string | undefined) ?? defaultRoleIds(ownerId).policyId;
const parsed = SeedFile.safeParse(JSON.parse(readFileSync(required(values.file, "file"), "utf8")));
if (!parsed.success) fail(parsed.error.message);

const view = new PolicyView(common.rpc, policyId);
const state = await view.state();
const treasuryAsset = `nep141:${state.token_id}`;
const wanted = parsed.data.suppliers.map((s) => ({ ...s, asset_id: s.asset_id ?? (s.chain === "NEAR" ? treasuryAsset : "") }));
for (const s of wanted) {
  if (!s.asset_id) fail(`${s.name}: asset_id is required for ${s.chain}`);
  if (s.chain === "TRON" && !isTronAddress(s.recipient)) fail(`${s.name}: ${s.recipient} is not a valid Tron address (checksum)`);
  if (isNative(s, state.token_id) && s.decimals !== state.token_decimals) fail(`${s.name}: native suppliers use the token's ${state.token_decimals} decimals`);
}
const existing = await view.suppliers();
const fresh = wanted.filter((s) => !existing.some((e) => e.chain === s.chain && e.asset_id === s.asset_id && e.recipient === s.recipient));
const hours = Number(BigInt(state.policy.cooldown_ns) / 3_600_000_000_000n);

await confirm(
  common,
  `Seeding ${policyId} (each new supplier starts a ${hours} h cooldown):\n` +
    fresh.map((s) => `  + "${s.name}" → ${s.chain} ${s.recipient}${isNative(s, state.token_id) ? " (native USDC; registered on the token if needed)" : ` (${s.asset_id})`}`).join("\n"),
);

const account = ownerAccount(common, ownerId, values["owner-key-file"] as string | undefined);
const owner = new OwnerClient(account, policyId);
const path = directoryPath(common.network);
const directory = loadDirectory(path);
for (const s of fresh) {
  if (isNative(s, state.token_id)) {
    const registered = await common.rpc.callFunction({ contractId: state.token_id, method: "storage_balance_of", args: { account_id: s.recipient } });
    if (registered == null) {
      step(`registering ${s.recipient} on ${state.token_id} (0.00125 NEAR)`);
      await registerOnToken(account, state.token_id, s.recipient);
    }
  }
  step(`adding supplier ${s.name}`);
  const id = (await owner.addSupplier({ chain: s.chain, asset_id: s.asset_id, recipient: s.recipient, decimals: s.decimals })).value;
  directory.suppliers = directory.suppliers.filter((d) => d.supplier_id !== id);
  directory.suppliers.push({
    supplier_id: id,
    name: s.name,
    aliases: s.aliases,
    payment_details: [s.recipient],
    contact: s.contact,
    typical_amount: s.typical_amount,
    currency: s.currency,
  });
  ok(`supplier ${id}: ${s.name}`);
}
saveDirectory(path, directory);
ok(`directory written to ${path} (private; git-ignored)`);
