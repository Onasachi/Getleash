/**
 * Adds destination assets and suppliers from a JSON file, and records their names in the private
 * off-chain directory. New suppliers start unverified and in cooldown (test payments only).
 *
 *   pnpm seed --network mainnet --owner yourbusiness.near --file fixtures/seed.example.json
 */
import { readFileSync } from "node:fs";

import { z } from "zod";

import { Chain, InvoiceCurrency, OwnerClient, PolicyView, toUnits } from "@getleash/shared";
import { directoryPath, loadDirectory, saveDirectory } from "@getleash/shared/node";

import { confirm, fail, ok, ownerAccount, parse, required, step } from "./lib/cli.ts";
import { defaultRoleIds } from "@getleash/shared";

const Decimal = z.string().regex(/^\d+(\.\d+)?$/);
const SeedFile = z.object({
  assets: z
    .array(z.object({ asset_id: z.string(), chain: Chain, decimals: z.number().int(), max_fixed_fee: Decimal }))
    .default([]),
  suppliers: z.array(
    z.object({
      name: z.string(),
      aliases: z.array(z.string()).default([]),
      chain: Chain,
      asset_id: z.string(),
      recipient: z.string(),
      per_payment_cap: Decimal,
      monthly_cap: Decimal,
      contact: z.string().optional(),
      typical_amount: Decimal.optional(),
      currency: InvoiceCurrency,
    }),
  ),
});

const { values, common } = parse(
  { owner: { type: "string" }, "owner-key-file": { type: "string" }, policy: { type: "string" }, file: { type: "string" } },
  "Usage: pnpm seed --network <net> --owner <you.near> --file <seed.json> [--policy <contract>]",
);
const ownerId = required(values.owner, "owner");
const policyId = (values.policy as string | undefined) ?? defaultRoleIds(ownerId).policyId;
const parsed = SeedFile.safeParse(JSON.parse(readFileSync(required(values.file, "file"), "utf8")));
if (!parsed.success) fail(parsed.error.message);
const seed = parsed.data;

const view = new PolicyView(common.rpc, policyId);
const config = await view.config();
const assets = new Map(await view.assets());
const existing = await view.suppliers();
const newAssets = seed.assets.filter((a) => !assets.has(a.asset_id));
const newSuppliers = seed.suppliers.filter(
  (s) => !existing.some((e) => e.chain === s.chain && e.asset_id === s.asset_id && e.recipient === s.recipient),
);

await confirm(
  common,
  `Seeding ${policyId}:\n` +
    newAssets.map((a) => `  + asset ${a.asset_id} (${a.chain}, fixed fee ≤ ${a.max_fixed_fee})`).join("\n") +
    "\n" +
    newSuppliers.map((s) => `  + supplier "${s.name}" → ${s.chain} ${s.recipient} (cap ${s.per_payment_cap}/payment, ${s.monthly_cap}/month)`).join("\n"),
);

const owner = new OwnerClient(ownerAccount(common, ownerId, values["owner-key-file"] as string | undefined), policyId);
for (const a of newAssets) {
  step(`adding asset ${a.asset_id}`);
  await owner.addAsset({
    assetId: a.asset_id,
    chain: a.chain,
    decimals: a.decimals,
    maxFixedFee: toUnits(a.max_fixed_fee, config.treasury_decimals),
  });
}
const allAssets = new Map(await view.assets());
const path = directoryPath(common.network);
const directory = loadDirectory(path);
for (const s of newSuppliers) {
  const asset = allAssets.get(s.asset_id);
  if (!asset) fail(`asset ${s.asset_id} is not on the contract`);
  step(`adding supplier ${s.name}`);
  const id = (
    await owner.addSupplier({
      chain: s.chain,
      assetId: s.asset_id,
      recipient: s.recipient,
      perPaymentCap: toUnits(s.per_payment_cap, asset.decimals),
      monthlyCap: toUnits(s.monthly_cap, asset.decimals),
    })
  ).value;
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
