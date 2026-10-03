import { UTApi, UTFile } from "uploadthing/server";
import { logger } from "./logger.ts";

let utapi: UTApi | null = null;

function getUtapi(): UTApi {
  if (!utapi) {
    const token = process.env.UPLOADTHING_TOKEN;
    if (!token) {
      throw new Error(
        "Missing env var UPLOADTHING_TOKEN on the backend server (WellnessBackend .env). " +
          "The frontend .env.local token is not shared automatically - copy UPLOADTHING_TOKEN there and restart the API.",
      );
    }
    utapi = new UTApi({ token });
  }
  return utapi;
}

export function isUploadConfigured(): boolean {
  return Boolean(process.env.UPLOADTHING_TOKEN);
}

/**
 * Upload a buffer (invoice PDF, profile photo, ...) to UploadThing (server-side).
 * Returns the public file URL for WhatsApp / download links.
 */
export async function uploadBuffer(args: {
  buffer: Buffer;
  filename: string;
  type: string;
}): Promise<string> {
  const file = new UTFile([new Uint8Array(args.buffer)], args.filename, {
    type: args.type,
  });

  const results = await getUtapi().uploadFiles([file]);
  const result = results[0];

  if (!result || result.error) {
    throw new Error(result?.error?.message ?? "UploadThing upload failed");
  }

  const url = result.data?.ufsUrl ?? result.data?.url;
  if (!url) {
    throw new Error("UploadThing returned no file URL");
  }

  return url;
}

// UploadThing serves files at https://utfs.io/f/<key> or
// https://<app>.ufs.sh/f/<key>. Anything else (a URL staff pasted, another
// host) is not ours to delete.
function uploadThingKey(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname;
  if (parsed.protocol !== "https:" || (host !== "utfs.io" && !host.endsWith(".ufs.sh"))) {
    return null;
  }
  return parsed.pathname.split("/").pop() || null;
}

/**
 * Best-effort delete of a file we uploaded earlier (a replaced profile photo).
 * Never throws: a leftover file only costs storage, so failures are logged.
 */
export async function deleteUploadedFile(url: string): Promise<void> {
  const key = uploadThingKey(url);
  if (!key) return;
  try {
    await getUtapi().deleteFiles(key);
  } catch (err) {
    logger.warn("Deleting an old UploadThing file failed", {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
