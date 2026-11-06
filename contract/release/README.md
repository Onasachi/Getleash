# The policy contract's release

`getleash_policy.wasm` is the release of the policy contract v2: 83,900 bytes, sha256
`8eaccbf19a011b67eb70f603a97b992831bec2485478587ae6973768b7640a3d` (NEAR shows it as code hash
`AbwiVLX5f7regsZkTKWvHkYbN1ae8yj9Gsygrq7bTvV2`). It is the code `getleash.onanikes.near` runs on mainnet and the
code the installer gives every business set up through the factory (`RELEASE_WASM_SHA256` in `shared/src/setup.ts`).

The integration tests, the offline demo and the setup scripts run this file and check its hash
(`devkit/src/paths.ts`); set `GETLEASH_POLICY_WASM` to run another build instead. To rebuild it from source, see
step 7 of "Run it locally" in the repository's README: a reproducible build at commit `b11e68a` (Docker) gives
these exact bytes.
