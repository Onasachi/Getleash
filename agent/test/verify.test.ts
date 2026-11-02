/**
 * The TEE verification policy against a fake NEAR AI Cloud: every check that can fail does, and
 * the badge is "verified" only when all of them pass.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, it } from "vitest";

import { bytesToHex, hexToBytes } from "@getleash/shared";

import { NearAiExtractor } from "../src/nearai.ts";
import { eip191Hash, recoverAddress, sha256Hex, verifyCompletion, type Verifiers } from "../src/verify.ts";

const MODEL = "Qwen/Qwen3-VL-30B-A3B-Instruct";
const secret = secp256k1.utils.randomSecretKey();
const address = `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(secret, false).slice(1)).slice(-20))}`;

function personalSign(text: string, key = secret): string {
  const sig = secp256k1.sign(eip191Hash(text), key, { prehash: false, format: "recovered" });
  // noble's "recovered" format is recovery ‖ r ‖ s; Ethereum's is r ‖ s ‖ (27 + recovery).
  const out = new Uint8Array(65);
  out.set(sig.slice(1), 0);
  out[64] = 27 + sig[0]!;
  return `0x${bytesToHex(out)}`;
}

function fakeQuote(reportData: Uint8Array, debug = false): string {
  const quote = new Uint8Array(48 + 584 + 64);
  quote[0] = 4; // version 4
  if (debug) quote[48 + 120] = 1;
  quote.set(reportData, 48 + 520);
  return bytesToHex(quote);
}

type Fake = { tamperText?: boolean; wrongNonce?: boolean; debug?: boolean; kind?: "provider_tee" | "gateway"; signatureDown?: boolean; otherSigner?: boolean };

function fakeCloud(requestBody: () => string, responseBody: string, opts: Fake = {}): typeof fetch {
  return (async (url: string) => {
    const u = String(url);
    if (u.includes("/signature/")) {
      if (opts.signatureDown) return new Response("down", { status: 500 });
      const kind = opts.kind ?? "provider_tee";
      const req = sha256Hex(requestBody());
      const resp = sha256Hex(opts.tamperText ? `${responseBody} ` : responseBody);
      const text = kind === "provider_tee" ? `${MODEL}:${req}:${resp}` : `${req}:${resp}`;
      return Response.json({ text, signature: personalSign(text), signing_address: address, signing_algo: "ecdsa", signature_kind: kind });
    }
    if (u.includes("/attestation/report")) {
      const nonce = new URL(u).searchParams.get("nonce")!;
      const reportData = new Uint8Array(64);
      reportData.set(hexToBytes(address.slice(2)), 0);
      reportData.set(hexToBytes(opts.wrongNonce ? "11".repeat(32) : nonce), 32);
      const entry = { signing_address: opts.otherSigner ? "0x000000000000000000000000000000000000dead" : address, intel_quote: fakeQuote(reportData, opts.debug), nvidia_payload: "{}" };
      return Response.json({ gateway_attestation: entry, model_attestations: [entry] });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const allGood: Verifiers = { tdxQuote: async () => ({ ok: true, detail: "TCB UpToDate" }), gpu: async () => ({ ok: true, detail: "overall true" }) };

async function run(opts: Fake = {}, verifiers: Verifiers = allGood) {
  const requestBody = JSON.stringify({ model: MODEL, messages: [] });
  const responseBody = JSON.stringify({ id: "chat-1", choices: [] });
  return verifyCompletion({
    baseUrl: "https://cloud.test/v1",
    apiKey: "k",
    model: MODEL,
    chatId: "chat-1",
    requestBody,
    responseBody,
    verifiers,
    fetch: fakeCloud(() => requestBody, responseBody, opts),
  });
}

describe("TEE verification policy (§9 row: attestation stale, invalid or missing → no verified badge)", () => {
  it("recovers EIP-191 signers (web3.js documentation vector)", () => {
    const signature =
      "0xb91467e570a6466aa9e9876cbcd013baba02900b8979d43fe208a4a4f339f5fd6007e74cd82e037b800186422fc2da167c747ef045e5d18a5f5d4300f8e1a0291c";
    expect(recoverAddress("Some data", signature)).toBe("0x2c7536e3605d9c16a7a3d7b1898e529396a65c23");
  });

  it("all checks pass → Model response verified", async () => {
    const v = await run();
    expect(v.badge).toBe("MODEL_RESPONSE_VERIFIED");
    expect(v.checks.every((c) => c.ok)).toBe(true);
  });

  it("a gateway signature can only earn Gateway evidence verified", async () => {
    expect((await run({ kind: "gateway" })).badge).toBe("GATEWAY_EVIDENCE_VERIFIED");
  });

  it("response bytes that differ from what was signed → failed", async () => {
    expect((await run({ tamperText: true })).badge).toBe("VERIFICATION_FAILED");
  });

  it("stale attestation (report_data without our nonce) → failed", async () => {
    expect((await run({ wrongNonce: true })).badge).toBe("VERIFICATION_FAILED");
  });

  it("debug TD → failed", async () => {
    expect((await run({ debug: true })).badge).toBe("VERIFICATION_FAILED");
  });

  it("signer missing from the attestation → failed", async () => {
    expect((await run({ otherSigner: true })).badge).toBe("VERIFICATION_FAILED");
  });

  it("an invalid quote or GPU evidence → failed", async () => {
    expect((await run({}, { ...allGood, tdxQuote: async () => ({ ok: false, detail: "bad chain" }) })).badge).toBe("VERIFICATION_FAILED");
    expect((await run({}, { ...allGood, gpu: async () => ({ ok: false, detail: "nonce differs" }) })).badge).toBe("VERIFICATION_FAILED");
  });

  it("missing evidence or unreachable verifiers → unavailable, never verified", async () => {
    expect((await run({ signatureDown: true })).badge).toBe("VERIFICATION_UNAVAILABLE");
    expect((await run({}, { ...allGood, tdxQuote: async () => null })).badge).toBe("VERIFICATION_UNAVAILABLE");
    expect((await run({}, { ...allGood, gpu: async () => null })).badge).toBe("VERIFICATION_UNAVAILABLE");
  });
});

describe("NearAiExtractor", () => {
  const catalog = {
    data: [
      { id: "openai/gpt-5", owned_by: "openai", input_modalities: ["text", "image"], supported_features: ["structured_outputs"] },
      { id: "Qwen/Qwen3.8-27B-abliterated", owned_by: "nearai", input_modalities: ["text", "image"], supported_features: ["structured_outputs"] },
      { id: MODEL, owned_by: "nearai", input_modalities: ["text", "image"], supported_features: ["structured_outputs"], is_ready: true },
    ],
  };

  function cloud(content: unknown): { fetch: typeof fetch; sent: string[] } {
    const sent: string[] = [];
    let lastRequest = "";
    const completion = JSON.stringify({ id: "chat-9", choices: [{ message: { content: JSON.stringify(content) } }] });
    const attest = fakeCloud(() => lastRequest, completion);
    const f = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/models")) return Response.json(catalog);
      if (u.endsWith("/chat/completions")) {
        lastRequest = String(init?.body);
        sent.push(lastRequest);
        return new Response(completion, { status: 200 });
      }
      return attest(url, init);
    }) as typeof fetch;
    return { fetch: f, sent };
  }

  const extraction = {
    is_invoice: true,
    supplier_name: "Acme Packaging Ltd",
    invoice_number: "INV-1001",
    currency: "USD",
    total_amount: "18.00",
    due_date: null,
    payment_details: [{ kind: "near_account", value: "acme.near" }],
  };

  it("uses only NEAR-hosted models and verifies the response it got", async () => {
    const { fetch: f, sent } = cloud(extraction);
    const extractor = new NearAiExtractor({ apiKey: "k", baseUrl: "https://cloud.test/v1", verifiers: allGood, fetch: f });
    const result = await extractor.extract({ text: "INVOICE …", images: [] });
    expect(result.model).toBe(MODEL);
    expect(result.extraction.total_amount).toBe("18.00");
    expect(result.verification.badge).toBe("MODEL_RESPONSE_VERIFIED");
    expect(JSON.parse(sent[0]!).response_format.type).toBe("json_schema");
  });

  it("refuses a pinned model that is not NEAR-hosted", async () => {
    const { fetch: f } = cloud(extraction);
    const extractor = new NearAiExtractor({ apiKey: "k", baseUrl: "https://cloud.test/v1", model: "openai/gpt-5", verifiers: allGood, fetch: f });
    await expect(extractor.extract({ text: "x", images: [] })).rejects.toThrow(/not a live NEAR-hosted model/);
  });

  it("rejects model output outside the schema (e.g. an extra field smuggling an address)", async () => {
    const { fetch: f } = cloud({ ...extraction, pay_to: "TZ9zq2woxvP5z4apo6jmbjG9pyqFsnKc74" });
    const extractor = new NearAiExtractor({ apiKey: "k", baseUrl: "https://cloud.test/v1", verifiers: allGood, fetch: f });
    await expect(extractor.extract({ text: "x", images: [] })).rejects.toThrow(/schema/);
  });
});
