import { UTApi, UTFile } from "uploadthing/server";

let utapi: UTApi | null = null;

function getUtapi(): UTApi {
  if (!utapi) {
    const token = process.env.UPLOADTHING_TOKEN;
    if (!token) {
      throw new Error(
        "Missing env var UPLOADTHING_TOKEN on the backend server (WellnessBackend .env). " +
          "The frontend .env.local token is not shared automatically — copy UPLOADTHING_TOKEN there and restart the API.",
      );
    }
    utapi = new UTApi({ token });
  }
  return utapi;
}

/**
 * Upload a PDF buffer to UploadThing (server-side).
 * Returns the public file URL for WhatsApp / download links.
 */
export async function uploadPdfBuffer(args: {
  buffer: Buffer;
  filename: string;
}): Promise<string> {
  const file = new UTFile([new Uint8Array(args.buffer)], args.filename, {
    type: "application/pdf",
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
