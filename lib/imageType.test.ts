import { describe, it, expect } from "vitest";
import { sniffImage } from "./imageType.ts";

const latin1 = (s: string) => Buffer.from(s, "latin1");

describe("sniffImage", () => {
  it("recognises JPEG, PNG and WEBP by their signatures", () => {
    expect(sniffImage(latin1("\xff\xd8\xff\xe0\x00\x10JFIF"))).toEqual({ type: "image/jpeg", ext: "jpg" });
    expect(sniffImage(latin1("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"))).toEqual({ type: "image/png", ext: "png" });
    expect(sniffImage(latin1("RIFF\x24\x00\x00\x00WEBPVP8 "))).toEqual({ type: "image/webp", ext: "webp" });
  });

  it("rejects other RIFF files, look-alikes and short or empty buffers", () => {
    expect(sniffImage(latin1("RIFF\x24\x00\x00\x00WAVEfmt "))).toBeNull(); // a WAV file
    expect(sniffImage(latin1("GIF89a"))).toBeNull();
    expect(sniffImage(latin1("<svg xmlns"))).toBeNull();
    expect(sniffImage(latin1("\x89PNG"))).toBeNull(); // truncated PNG signature
    expect(sniffImage(latin1("\xff\xd8"))).toBeNull();
    expect(sniffImage(latin1("RIFF"))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});
