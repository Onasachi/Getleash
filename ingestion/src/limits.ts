/**
 * Input limits (PLAN §4.4): file ≤ 10 MB, PDF ≤ 10 pages, image ≤ 4000 px per side, text extraction
 * ≤ 30 s, at most 3 jobs at once. Checked before anything reaches a model.
 */
export const LIMITS = {
  maxFileBytes: 10 * 1024 * 1024,
  maxPdfPages: 10,
  maxImagePixels: 4000,
  maxTextChars: 20_000,
  extractTimeoutMs: 30_000,
  maxConcurrentJobs: 3,
} as const;

export type FileKind = "pdf" | "png" | "jpeg" | "webp" | "text";

export function sniffKind(bytes: Uint8Array): FileKind | null {
  const head = (n: number) => Array.from(bytes.slice(0, n));
  if (head(5).join() === [0x25, 0x50, 0x44, 0x46, 0x2d].join()) return "pdf"; // %PDF-
  if (head(8).join() === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].join()) return "png";
  if (head(3).join() === [0xff, 0xd8, 0xff].join()) return "jpeg";
  if (head(4).join() === [0x52, 0x49, 0x46, 0x46].join() && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "webp";
  return null;
}

/** Width and height from PNG/JPEG headers, without decoding the image. */
export function imageSize(bytes: Uint8Array, kind: FileKind): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (kind === "png" && bytes.length >= 24) return { width: view.getUint32(16), height: view.getUint32(20) };
  if (kind === "jpeg") {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1]!;
      const length = view.getUint16(offset + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

export class LimitError extends Error {
  constructor(readonly code: "FILE_TOO_LARGE" | "UNSUPPORTED_FILE" | "TOO_MANY_PAGES" | "IMAGE_TOO_LARGE" | "TEXT_TOO_LONG" | "TIMEOUT", message: string) {
    super(message);
    this.name = "LimitError";
  }
}

export function checkFile(bytes: Uint8Array): FileKind {
  if (bytes.length > LIMITS.maxFileBytes) throw new LimitError("FILE_TOO_LARGE", `file is ${bytes.length} bytes (max 10 MB)`);
  const kind = sniffKind(bytes);
  if (!kind) throw new LimitError("UNSUPPORTED_FILE", "only PDF, PNG, JPEG and WebP files are accepted");
  if (kind === "png" || kind === "jpeg") {
    const size = imageSize(bytes, kind);
    if (!size) throw new LimitError("UNSUPPORTED_FILE", "could not read the image size");
    if (size.width > LIMITS.maxImagePixels || size.height > LIMITS.maxImagePixels) {
      throw new LimitError("IMAGE_TOO_LARGE", `image is ${size.width}×${size.height} (max ${LIMITS.maxImagePixels} px per side)`);
    }
  }
  return kind;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LimitError("TIMEOUT", `${what} took longer than ${ms} ms`)), ms);
    }),
  ]);
}

/** At most `max` jobs at once; the rest wait their turn. */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly max: number = LIMITS.maxConcurrentJobs) {}

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await job();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}
