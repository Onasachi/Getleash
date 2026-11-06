import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/**
 * The policy contract's release: the exact bytes deployed on mainnet and installed by every hosted setup
 * (sha256 `RELEASE_WASM_SHA256` in shared/src/setup.ts). It is committed, so a fresh clone runs the same
 * file the chain runs; README step 7 rebuilds it from source with Docker. A local `cargo near build` gives
 * other bytes (the build records its commit and environment), which the installer would refuse.
 */
export const RELEASE_WASM = join(REPO_ROOT, "contract/release/getleash_policy.wasm");
/** The wasm the local node, the demo and the setup scripts use: the release, unless GETLEASH_POLICY_WASM names another build. */
export const POLICY_WASM = process.env.GETLEASH_POLICY_WASM ? resolve(process.env.GETLEASH_POLICY_WASM) : RELEASE_WASM;
export const MOCK_FT_WASM = join(REPO_ROOT, "contract/tests/mock-ft/target/near/mock_ft.wasm");
