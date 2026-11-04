/**
 * Hex and Borsh helpers (browser-safe). The v2 contract takes Borsh arguments from the agent and
 * executor and returns Borsh from its views (docs/decisions.md D-28); these mirror its layout.
 * The reader is strict: booleans must be 0 or 1, enum indexes must exist, and nothing may be left
 * over, so a wrong layout fails loudly instead of decoding into nonsense.
 */

export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** base64url without padding (RFC 4648 §5): what Telegram allows in a deep link's start parameter. */
export function toBase64Url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The bytes of a base64url text (no padding), or null if it isn't one. */
export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  try {
    const plain = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(plain, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Exactly 32 bytes from 64 hex characters. */
export function hex32(hex: string): Uint8Array {
  const bytes = hexToBytes(hex);
  if (bytes.length !== 32) throw new Error("expected 32 bytes (64 hex characters)");
  return bytes;
}

export class BorshWriter {
  private chunks: Uint8Array[] = [];

  bytes(value: Uint8Array): this {
    this.chunks.push(value);
    return this;
  }

  u8(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new RangeError(`u8 ${value}`);
    return this.bytes(Uint8Array.of(value));
  }

  bool(value: boolean): this {
    return this.u8(value ? 1 : 0);
  }

  u32(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new RangeError(`u32 ${value}`);
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, true);
    return this.bytes(out);
  }

  u64(value: string | number | bigint): this {
    return this.uint(BigInt(value), 8);
  }

  u128(value: string | number | bigint): this {
    return this.uint(BigInt(value), 16);
  }

  string(value: string): this {
    const utf8 = new TextEncoder().encode(value);
    return this.u32(utf8.length).bytes(utf8);
  }

  finish(): Uint8Array {
    const length = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  private uint(value: bigint, bytes: number): this {
    if (value < 0n || value >= 1n << BigInt(bytes * 8)) {
      throw new RangeError(`value ${value} does not fit in ${bytes} bytes`);
    }
    const out = new Uint8Array(bytes);
    let v = value;
    for (let i = 0; i < bytes; i++) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return this.bytes(out);
  }
}

export class BorshReader {
  private at = 0;

  constructor(private readonly buf: Uint8Array) {}

  private take(n: number): Uint8Array {
    if (this.at + n > this.buf.length) throw new Error("borsh: unexpected end of data");
    const out = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }

  u8(): number {
    return this.take(1)[0]!;
  }

  bool(): boolean {
    const b = this.u8();
    if (b > 1) throw new Error(`borsh: invalid bool ${b}`);
    return b === 1;
  }

  u16(): number {
    const b = this.take(2);
    return b[0]! | (b[1]! << 8);
  }

  u32(): number {
    const b = this.take(4);
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
  }

  private uint(bytes: number): bigint {
    const b = this.take(bytes);
    let v = 0n;
    for (let i = bytes - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
    return v;
  }

  u64(): bigint {
    return this.uint(8);
  }

  u128(): bigint {
    return this.uint(16);
  }

  /** A u64 that must fit a JS number (ids). */
  id(): number {
    const v = this.u64();
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("borsh: id too large");
    return Number(v);
  }

  fixed(n: number): Uint8Array {
    return this.take(n).slice();
  }

  string(): string {
    const len = this.u32();
    return new TextDecoder("utf-8", { fatal: true }).decode(this.take(len));
  }

  enumOf<const T extends readonly string[]>(names: T): T[number] {
    const i = this.u8();
    const name = names[i];
    if (name === undefined) throw new Error(`borsh: enum index ${i} out of range`);
    return name;
  }

  option<T>(read: (r: this) => T): T | null {
    const tag = this.u8();
    if (tag === 0) return null;
    if (tag !== 1) throw new Error(`borsh: invalid option tag ${tag}`);
    return read(this);
  }

  vec<T>(read: (r: this) => T): T[] {
    const n = this.u32();
    const out: T[] = [];
    for (let i = 0; i < n; i++) out.push(read(this));
    return out;
  }

  /** Throws if any bytes are left: the layout must match exactly. */
  done(): void {
    if (this.at !== this.buf.length) throw new Error(`borsh: ${this.buf.length - this.at} trailing bytes`);
  }
}
