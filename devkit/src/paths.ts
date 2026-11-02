import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const POLICY_WASM = join(REPO_ROOT, "contract/target/near/getleash_policy.wasm");
export const MOCK_FT_WASM = join(REPO_ROOT, "contract/tests/mock-ft/target/near/mock_ft.wasm");
