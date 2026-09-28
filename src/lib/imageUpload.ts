import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env";
import { ValidationError } from "./errors";

export const UPLOAD_ROOT = path.resolve(__dirname, "../../uploads");

const UPLOAD_NAMESPACES = ["products", "categories", "returns"] as const;
export type UploadNamespace = (typeof UPLOAD_NAMESPACES)[number];

function dirFor(namespace: UploadNamespace): string {
  return path.join(UPLOAD_ROOT, namespace);
}

function publicPrefixFor(namespace: UploadNamespace): string {
  return `/uploads/${namespace}/`;
}

interface ImageSignature {
  ext: string;
  matches: (buf: Buffer) => boolean;
}

// Detected from the file's actual bytes, never trusted from the client's filename or
// Content-Type — a renamed .exe claiming to be image/jpeg won't match any of these.
const SIGNATURES: ImageSignature[] = [
  { ext: "jpg", matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    ext: "png",
    matches: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    ext: "gif",
    matches: (b) => b.length >= 6 && ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("ascii")),
  },
  {
    ext: "webp",
    matches: (b) => b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP",
  },
];

function detectImageExt(buffer: Buffer): string | undefined {
  return SIGNATURES.find((sig) => sig.matches(buffer))?.ext;
}

export async function ensureUploadDirs(): Promise<void> {
  await Promise.all(UPLOAD_NAMESPACES.map((namespace) => fs.mkdir(dirFor(namespace), { recursive: true })));
}

/**
 * Validates the buffer is actually one of the supported image formats by content (magic
 * bytes), writes it under a random filename (never the client's own name — avoids path
 * traversal, collisions, and any meaning being read into it), and returns the absolute
 * public URL to store on the owning row (ProductImage.url, ProductCategory.logoUrl, ...) —
 * same field/shape as an externally-hosted image, so nothing downstream needs to
 * special-case where a photo actually came from.
 */
export async function saveUploadedImage(namespace: UploadNamespace, buffer: Buffer): Promise<{ url: string }> {
  const ext = detectImageExt(buffer);
  if (!ext) {
    throw new ValidationError("Unsupported or corrupt image — only JPEG, PNG, GIF, and WebP are accepted.");
  }

  const filename = `${crypto.randomUUID()}.${ext}`;
  await fs.writeFile(path.join(dirFor(namespace), filename), buffer);

  return { url: `${env.PUBLIC_BASE_URL}${publicPrefixFor(namespace)}${filename}` };
}

/** Best-effort delete of the on-disk file backing a stored image url — a silent no-op for
 * externally-hosted URLs, which never point into any of our own uploads folders at all.
 * Namespace is inferred from the URL itself, so callers don't need to track where a given
 * url came from — just pass whatever's currently stored before overwriting/clearing it. */
export async function deleteUploadedImageIfLocal(url: string): Promise<void> {
  for (const namespace of UPLOAD_NAMESPACES) {
    const prefix = `${env.PUBLIC_BASE_URL}${publicPrefixFor(namespace)}`;
    if (!url.startsWith(prefix)) continue;

    const filename = url.slice(prefix.length);
    // filename is always our own randomUUID() + a known extension at write time, but guard
    // anyway against a stray "/" or ".." ever reaching fs.unlink via a malformed stored URL.
    if (/^[0-9a-f-]+\.(jpg|png|gif|webp)$/i.test(filename)) {
      await fs.unlink(path.join(dirFor(namespace), filename)).catch(() => {});
    }
    return;
  }
}
