import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const m = vi.hoisted(() => ({
  deleteFiles: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("uploadthing/server", () => ({
  UTApi: class {
    deleteFiles = m.deleteFiles;
  },
  UTFile: class {},
}));
vi.mock("./logger.ts", () => ({ logger: m.logger }));

import { deleteUploadedFile } from "./uploadthing.ts";

const originalToken = process.env.UPLOADTHING_TOKEN;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.UPLOADTHING_TOKEN = "test-token";
  m.deleteFiles.mockResolvedValue({ success: true, deletedCount: 1 });
});

afterAll(() => {
  if (originalToken === undefined) delete process.env.UPLOADTHING_TOKEN;
  else process.env.UPLOADTHING_TOKEN = originalToken;
});

describe("deleteUploadedFile", () => {
  it("deletes by the last path segment of an UploadThing URL", async () => {
    await deleteUploadedFile("https://utfs.io/f/abc123_photo.jpg");
    await deleteUploadedFile("https://x1y2z3.ufs.sh/f/def456");
    expect(m.deleteFiles.mock.calls).toEqual([["abc123_photo.jpg"], ["def456"]]);
  });

  it("leaves any other URL alone", async () => {
    for (const url of [
      "https://example.com/f/abc",
      "https://utfs.io.evil.com/f/abc",
      "http://utfs.io/f/abc",
      "https://utfs.io/",
      "not a url",
      "",
    ]) {
      await deleteUploadedFile(url);
    }
    expect(m.deleteFiles).not.toHaveBeenCalled();
  });

  it("logs a failure instead of throwing", async () => {
    m.deleteFiles.mockRejectedValue(new Error("UploadThing down"));
    await expect(deleteUploadedFile("https://utfs.io/f/abc")).resolves.toBeUndefined();
    expect(m.logger.warn).toHaveBeenCalledWith("Deleting an old UploadThing file failed", {
      key: "abc",
      error: "UploadThing down",
    });
  });
});
