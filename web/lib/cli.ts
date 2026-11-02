/**
 * The near-cli-rs command for an owner call, ready to run as is: it ends in `send`, so it signs with the
 * key near-cli keeps for the owner and sends without a further prompt (the "NEAR CLI" wallet's own
 * command stops at a prompt, which fails outside an interactive terminal). Same terms as the button.
 */
import { NETWORK, POLICY_ID } from "./config";

const quoted = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

export function nearCliCommand(owner: string, method: string, args: Record<string, unknown>, tgas: number): string {
  return [
    "near contract call-function as-transaction",
    POLICY_ID,
    method,
    "json-args",
    quoted(JSON.stringify(args)),
    "prepaid-gas",
    quoted(`${tgas} Tgas`),
    "attached-deposit",
    quoted("1 yoctoNEAR"),
    "sign-as",
    owner,
    "network-config",
    NETWORK,
    "sign-with-keychain send",
  ].join(" ");
}
