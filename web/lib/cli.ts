/**
 * The near-cli-rs command for an owner call, ready to run as is: it ends in `send`, so it signs with the
 * key near-cli keeps for the owner and sends without a further prompt (the "NEAR CLI" wallet's own
 * command stops at a prompt, which fails outside an interactive terminal). Same terms as the button.
 * Calls go to the policy contract with 1 yoctoNEAR unless `receiver` and `deposit` say otherwise.
 */
import { NETWORK, POLICY_ID } from "./config";

const quoted = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

export function nearCliCommand(
  owner: string,
  method: string,
  args: Record<string, unknown>,
  tgas: number,
  { receiver = POLICY_ID, deposit = "1 yoctoNEAR" }: { receiver?: string; deposit?: string } = {},
): string {
  return [
    "near contract call-function as-transaction",
    receiver,
    method,
    "json-args",
    quoted(JSON.stringify(args)),
    "prepaid-gas",
    quoted(`${tgas} Tgas`),
    "attached-deposit",
    quoted(deposit),
    "sign-as",
    owner,
    "network-config",
    NETWORK,
    "sign-with-keychain send",
  ].join(" ");
}
