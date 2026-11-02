/**
 * Runs mock-1click on its own against testnet (1Click itself is mainnet-only), so the executor,
 * the contract's cross-chain payout and the owner's authorization can be rehearsed with Circle's
 * real testnet USDC. Nothing reaches Tron: the mock settles by moving the deposit to its solver.
 *
 *   pnpm keygen --network testnet --account oneclick-mock.you.testnet   # then create that account
 *   pnpm mock:1click --network testnet --solver oneclick-mock.you.testnet
 *   pnpm executor --mock                                                 # MOCK_ONECLICK_URL=http://127.0.0.1:3031
 *
 * The solver registers itself on the token and sends `--deposit-near` to each deposit account it
 * empties (gas for the deposit account's own ft_transfer).
 */
import { MockOneClick, type Scenario } from "@getleash/mock-1click";
import { keyFileAccount, keyFilePath, readKeyFile } from "@getleash/shared/node";

import { fail, parse, required } from "./lib/cli.ts";

const TRON_USDT = "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near";
const SCENARIOS = ["success", "change", "refund", "slow", "outage"] as const;

const { values, common } = parse(
  {
    solver: { type: "string" },
    "solver-key-file": { type: "string" },
    port: { type: "string", default: "3031" },
    "deposit-near": { type: "string", default: "0.05" },
    scenario: { type: "string", default: "success" },
  },
  `
Usage: pnpm mock:1click --network testnet --solver <account> [options]

  --solver-key-file <path>   default .keys/<network>/<solver>.json (pnpm keygen)
  --port <n>                 default 3031
  --deposit-near <NEAR>      NEAR sent to each deposit account before emptying it (default 0.05)
  --scenario <s>             default for every quote: ${SCENARIOS.join(" | ")} (default success)`,
);

if (common.network === "mainnet") fail("mock-1click is for testnet or a local node; mainnet uses the real 1Click");
const token = common.preset.usdc;
if (!token) fail(`no USDC preset for ${common.network}; use pnpm devnet for a local node`);
const scenario = values.scenario as Scenario;
if (!(SCENARIOS as readonly string[]).includes(scenario)) fail(`--scenario must be one of ${SCENARIOS.join(", ")}`);

const solverId = required(values.solver, "solver");
const keyPath = (values["solver-key-file"] as string | undefined) ?? keyFilePath(common.network, solverId);
const key = readKeyFile(keyPath);
if (keyFileAccount(keyPath, key) !== solverId) fail(`${keyPath} is not a key for ${solverId}`);

const mock = new MockOneClick({
  rpcUrl: common.rpcUrl,
  token,
  solver: { accountId: solverId, privateKey: key.private_key },
  destinations: [
    {
      assetId: TRON_USDT,
      symbol: "USDT",
      blockchain: "tron",
      decimals: 6,
      withdrawFee: 200_000n,
      contractAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    },
  ],
  port: Number(values.port),
  depositAccountNear: values["deposit-near"] as string,
  processingMs: 5_000,
  pollMs: 3_000,
  log: (line) => console.log(`${new Date().toISOString()} ${line}`),
});
if (scenario !== "success") mock.setScenario(scenario, 1_000);
const url = await mock.start();
console.log(`mock-1click on ${common.network} at ${url}: token ${token}, solver ${solverId}, scenario ${scenario}`);
