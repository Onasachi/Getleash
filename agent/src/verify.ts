/**
 * TEE verification policy for NEAR AI Cloud responses (PLAN §4.3, F-09), following NEAR AI's
 * documented flow (docs/verified-facts.md, skill near-ai-cloud/references/*):
 *
 *   1. Signature over our exact bytes: `GET /v1/signature/{chat_id}` returns `text` =
 *      "<model>:<sha256(request)>:<sha256(response)>" (model TEE) or "<req>:<resp>" (gateway),
 *      signed with EIP-191. We recompute both hashes from the bytes we sent and received, and
 *      recover the signer.
 *   2. Attestation with a fresh nonce: `GET /v1/attestation/report?nonce=…` returns the TEE's
 *      signing address with an Intel TDX quote whose report_data must equal
 *      signer address (zero-padded to 32 bytes) ‖ our nonce.
 *   3. The TDX quote is verified against Intel's PCS (DCAP: certificate chain, signatures, TCB
 *      status, debug mode refused), with @phala/dcap-qvl.
 *   4. Model TEE only: the GPU evidence is verified by NVIDIA NRAS; the JWT must be signed by
 *      NRAS, report an overall pass, and carry our nonce.
 *
 * Badge: "Model response verified" only if every step passes for a model-TEE signature;
 * "Gateway evidence verified" for a gateway signature with steps 1–3; "Verification failed" if any
 * cryptographic check fails; otherwise "Verification unavailable". It proves where the inference
 * ran, not that the invoice is genuine or the extraction right. No measurement allow-list is
 * pinned (NEAR AI publishes none), so a verified badge means "a genuine, non-debug TDX/GPU TEE
 * holding this key produced these bytes".
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import { bytesToHex, hexToBytes } from "@getleash/shared";

import type { Badge, Verification } from "./extract.ts";

type Check = { name: string; ok: boolean; detail: string };

export function sha256Hex(data: string | Uint8Array): string {
  return bytesToHex(sha256(typeof data === "string" ? new TextEncoder().encode(data) : data));
}

function strip0x(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/** keccak256("\x19Ethereum Signed Message:\n" + len + text) (EIP-191 personal_sign). */
export function eip191Hash(text: string): Uint8Array {
  const message = new TextEncoder().encode(text);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`);
  const joined = new Uint8Array(prefix.length + message.length);
  joined.set(prefix, 0);
  joined.set(message, prefix.length);
  return keccak_256(joined);
}

/** Recovers the 0x-address that produced an EIP-191 signature (65 bytes r‖s‖v). */
export function recoverAddress(text: string, signatureHex: string): string {
  const sig = hexToBytes(strip0x(signatureHex).toLowerCase());
  if (sig.length !== 65) throw new Error("signature must be 65 bytes");
  const v = sig[64]!;
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) throw new Error("bad recovery byte");
  const signature = secp256k1.Signature.fromBytes(sig.slice(0, 64), "compact").addRecoveryBit(recovery);
  const publicKey = signature.recoverPublicKey(eip191Hash(text)).toBytes(false);
  return `0x${bytesToHex(keccak_256(publicKey.slice(1)).slice(-20))}`;
}

/** REPORTDATA (64 bytes) and TDATTRIBUTES of an Intel TDX quote, v4 or v5. */
export function tdxReportFields(quote: Uint8Array): { reportData: Uint8Array; debug: boolean } | null {
  if (quote.length < 48) return null;
  const version = quote[0]! | (quote[1]! << 8);
  // v4: 48-byte header, then the TD report body. v5: header, body type (2) and size (4), then body.
  const body = version === 4 ? 48 : version === 5 ? 54 : -1;
  if (body < 0 || quote.length < body + 584) return null;
  const tdAttributes = quote.slice(body + 120, body + 128);
  return { reportData: quote.slice(body + 520, body + 584), debug: (tdAttributes[0]! & 1) === 1 };
}

/** report_data must be: signer address zero-padded to 32 bytes ‖ our 32-byte nonce. */
export function reportDataBinds(reportData: Uint8Array, address: string, nonceHex: string): boolean {
  const expected = new Uint8Array(64);
  expected.set(hexToBytes(strip0x(address).toLowerCase()), 0);
  expected.set(hexToBytes(nonceHex), 32);
  return bytesToHex(reportData) === bytesToHex(expected);
}

export type SignatureResponse = {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo?: string;
  signature_kind?: "provider_tee" | "gateway";
};

type AttestationEntry = { signing_address?: string; intel_quote?: string; nvidia_payload?: string | object };
export type AttestationReport = { gateway_attestation?: AttestationEntry; model_attestations?: AttestationEntry[] };

/** Pluggable heavy verifiers (network calls to Intel PCS / NVIDIA NRAS). */
export type Verifiers = {
  /** DCAP verification of a TDX quote. Returns null when it cannot run (e.g. offline). */
  tdxQuote: (quote: Uint8Array) => Promise<{ ok: boolean; detail: string } | null>;
  /** NVIDIA NRAS verification of the GPU evidence against our nonce. */
  gpu: (payload: string | object, nonceHex: string) => Promise<{ ok: boolean; detail: string } | null>;
};

export type VerifyInput = {
  baseUrl: string;
  apiKey: string;
  model: string;
  chatId: string;
  requestBody: string;
  responseBody: string;
  verifiers: Verifiers;
  fetch?: typeof fetch;
  nonceHex?: string;
};

async function getJson<T>(f: typeof fetch, url: string, apiKey: string): Promise<{ status: number; body: T | null; text: string }> {
  const response = await f(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "x-no-aliasing": "true" }, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let body: T | null = null;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = null;
  }
  return { status: response.status, body, text };
}

function result(badge: Badge, checks: Check[], evidence: unknown): Verification {
  return { badge, checks, evidence };
}

export async function verifyCompletion(input: VerifyInput): Promise<Verification> {
  const f = input.fetch ?? fetch;
  const checks: Check[] = [];
  const evidence: Record<string, unknown> = { model: input.model, chatId: input.chatId };
  const base = input.baseUrl.replace(/\/$/, "");

  // 1. The signature over our exact request and response bytes.
  let sig: SignatureResponse | null = null;
  for (let attempt = 0; attempt < 5 && !sig; attempt++) {
    try {
      const r = await getJson<SignatureResponse>(
        f,
        `${base}/signature/${encodeURIComponent(input.chatId)}?model=${encodeURIComponent(input.model)}&signing_algo=ecdsa`,
        input.apiKey,
      );
      if (r.status === 200 && r.body?.signature) sig = r.body;
      else if (r.status !== 404 && !/not found|expired/i.test(r.text)) break;
    } catch {
      break;
    }
    if (!sig) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  if (!sig) {
    checks.push({ name: "response signature", ok: false, detail: "signature endpoint unavailable" });
    return result("VERIFICATION_UNAVAILABLE", checks, evidence);
  }
  evidence.signature = sig;
  const reqHash = sha256Hex(input.requestBody);
  const respHash = sha256Hex(input.responseBody);
  const parts = sig.text.split(":");
  const kind: "provider_tee" | "gateway" = sig.signature_kind ?? (parts.length >= 3 ? "provider_tee" : "gateway");
  const expectedText = kind === "provider_tee" ? `${input.model}:${reqHash}:${respHash}` : `${reqHash}:${respHash}`;
  const textOk = sig.text === expectedText;
  checks.push({ name: "signed text covers our exact request and response bytes", ok: textOk, detail: textOk ? kind : `got ${sig.text}` });
  let signer = "";
  try {
    signer = recoverAddress(sig.text, sig.signature);
  } catch (error) {
    checks.push({ name: "signature recovers", ok: false, detail: (error as Error).message });
    return result("VERIFICATION_FAILED", checks, evidence);
  }
  const signerOk = signer.toLowerCase() === sig.signing_address.toLowerCase();
  checks.push({ name: "EIP-191 signature recovers the stated signer", ok: signerOk, detail: signer });
  if (!textOk || !signerOk) return result("VERIFICATION_FAILED", checks, evidence);

  // 2. Fresh attestation binding that signer to a TEE.
  const nonce = input.nonceHex ?? bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  evidence.nonce = nonce;
  let report: AttestationReport | null = null;
  try {
    const r = await getJson<AttestationReport>(
      f,
      `${base}/attestation/report?model=${encodeURIComponent(input.model)}&signing_algo=ecdsa&nonce=${nonce}&provider=near&include_tls_fingerprint=false`,
      input.apiKey,
    );
    if (r.status === 200) report = r.body;
  } catch {
    report = null;
  }
  if (!report) {
    checks.push({ name: "attestation report", ok: false, detail: "attestation endpoint unavailable" });
    return result("VERIFICATION_UNAVAILABLE", checks, evidence);
  }
  const entry =
    kind === "provider_tee"
      ? report.model_attestations?.find((a) => a.signing_address?.toLowerCase() === signer.toLowerCase())
      : report.gateway_attestation?.signing_address?.toLowerCase() === signer.toLowerCase()
        ? report.gateway_attestation
        : undefined;
  if (!entry?.intel_quote) {
    checks.push({ name: "signer appears in a fresh attestation", ok: false, detail: `no ${kind} attestation for ${signer}` });
    return result("VERIFICATION_FAILED", checks, evidence);
  }
  evidence.attestation = { signing_address: entry.signing_address, intel_quote: entry.intel_quote };
  const quote = hexToBytes(strip0x(entry.intel_quote).toLowerCase());
  const fields = tdxReportFields(quote);
  if (!fields) {
    checks.push({ name: "TDX quote parses", ok: false, detail: "unrecognised quote layout" });
    return result("VERIFICATION_FAILED", checks, evidence);
  }
  const bound = reportDataBinds(fields.reportData, signer, nonce);
  checks.push({ name: "TDX report_data = signer ‖ our nonce", ok: bound, detail: bytesToHex(fields.reportData) });
  checks.push({ name: "TD is not in debug mode", ok: !fields.debug, detail: fields.debug ? "DEBUG bit set" : "debug off" });
  if (!bound || fields.debug) return result("VERIFICATION_FAILED", checks, evidence);

  // 3. The quote itself, against Intel's certificate chain and TCB data.
  const tdx = await input.verifiers.tdxQuote(quote).catch((error: Error) => ({ ok: false, detail: error.message }));
  if (tdx === null) {
    checks.push({ name: "TDX quote verified with Intel PCS", ok: false, detail: "verifier unavailable" });
    return result("VERIFICATION_UNAVAILABLE", checks, evidence);
  }
  checks.push({ name: "TDX quote verified with Intel PCS", ok: tdx.ok, detail: tdx.detail });
  if (!tdx.ok) return result("VERIFICATION_FAILED", checks, evidence);

  if (kind === "gateway") return result("GATEWAY_EVIDENCE_VERIFIED", checks, evidence);

  // 4. Model TEE: the GPU evidence, through NVIDIA NRAS, with our nonce.
  if (!entry.nvidia_payload) {
    checks.push({ name: "GPU attestation (NVIDIA NRAS)", ok: false, detail: "no GPU evidence in the report" });
    return result("VERIFICATION_UNAVAILABLE", checks, evidence);
  }
  const gpu = await input.verifiers.gpu(entry.nvidia_payload, nonce).catch((error: Error) => ({ ok: false, detail: error.message }));
  if (gpu === null) {
    checks.push({ name: "GPU attestation (NVIDIA NRAS)", ok: false, detail: "verifier unavailable" });
    return result("VERIFICATION_UNAVAILABLE", checks, evidence);
  }
  checks.push({ name: "GPU attestation (NVIDIA NRAS)", ok: gpu.ok, detail: gpu.detail });
  return result(gpu.ok ? "MODEL_RESPONSE_VERIFIED" : "VERIFICATION_FAILED", checks, evidence);
}

/** The production verifiers: Intel PCS via @phala/dcap-qvl, NVIDIA NRAS via jose. */
export async function networkVerifiers(): Promise<Verifiers> {
  return {
    tdxQuote: async (quote) => {
      const dcap = await import("@phala/dcap-qvl");
      const collateral = await dcap.getCollateralFromPcs(quote);
      const report = dcap.verify(quote, collateral, Math.floor(Date.now() / 1000));
      const rejected = ["Revoked", "Unknown"].includes(report.status);
      return { ok: !rejected, detail: `TCB ${report.status}${report.advisory_ids.length ? ` (${report.advisory_ids.join(", ")})` : ""}` };
    },
    gpu: async (payload, nonceHex) => {
      const { createRemoteJWKSet, jwtVerify } = await import("jose");
      const response = await fetch("https://nras.attestation.nvidia.com/v3/attest/gpu", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: typeof payload === "string" ? payload : JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return { ok: false, detail: `NRAS HTTP ${response.status}` };
      const body = (await response.json()) as [[string, string], Record<string, string>];
      const overall = body?.[0]?.[1];
      if (typeof overall !== "string") return { ok: false, detail: "NRAS returned no JWT" };
      const jwks = createRemoteJWKSet(new URL("https://nras.attestation.nvidia.com/.well-known/jwks.json"));
      const { payload: claims } = await jwtVerify(overall, jwks, { issuer: "https://nras.attestation.nvidia.com" });
      const pass = claims["x-nvidia-overall-att-result"] === true;
      const nonceOk = String(claims.eat_nonce ?? "").toLowerCase() === nonceHex.toLowerCase();
      return { ok: pass && nonceOk, detail: `overall ${String(claims["x-nvidia-overall-att-result"])}, nonce ${nonceOk ? "matches" : "differs"}` };
    },
  };
}
