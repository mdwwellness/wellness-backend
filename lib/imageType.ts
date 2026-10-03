// Photo formats the Customers' App may upload.
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RIFF = Buffer.from("RIFF");
const WEBP = Buffer.from("WEBP");

const has = (buf: Buffer, at: number, sig: Buffer) =>
  buf.subarray(at, at + sig.length).equals(sig);

/**
 * The image type from the file's own leading bytes. The Content-Type header is
 * whatever the client claims, so the bytes decide what actually gets stored
 * under a public image URL.
 */
export function sniffImage(buf: Buffer): { type: string; ext: string } | null {
  if (has(buf, 0, JPEG)) return { type: "image/jpeg", ext: "jpg" };
  if (has(buf, 0, PNG)) return { type: "image/png", ext: "png" };
  if (has(buf, 0, RIFF) && has(buf, 8, WEBP)) return { type: "image/webp", ext: "webp" };
  return null;
}
