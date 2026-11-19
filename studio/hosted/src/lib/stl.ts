/** A quick check that bytes look like an STL (binary with a consistent size, or ASCII `solid`). */
export function looksLikeStl(b: Uint8Array): boolean {
  if (b.length >= 84) {
    const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(80, true);
    if (84 + 50 * n === b.length && n > 0) return true;
  }
  const head = new TextDecoder().decode(b.subarray(0, 512)).trimStart();
  return head.startsWith("solid") && /facet/.test(new TextDecoder().decode(b.subarray(0, 4096)));
}

/** Direct uploads through a function are limited by Vercel's request body limit (4.5 MB). */
export const DIRECT_UPLOAD_MAX = 4 * 1024 * 1024;
/** Presigned uploads go straight to Blob. */
export const UPLOAD_MAX = 200 * 1024 * 1024;
