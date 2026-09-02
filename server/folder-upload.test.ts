// folder-upload.ts: rebuilding a phone's folder under the attachments
// directory — the name rules that keep every file inside it, the caps, and
// what a retry does.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ATTACHMENTS_DIR, FILE_MAX_BYTES } from "./attachments.ts";
import {
  FOLDERS_DIR,
  folderPath,
  folderUsage,
  sanitizeFolderName,
  sanitizeRelativePath,
  saveFolderFile,
} from "./folder-upload.ts";

async function* bytesOf(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield Buffer.from(part);
}

const status = async (promise: Promise<unknown>): Promise<number> => {
  try {
    await promise;
  } catch (error) {
    return (error as { status: number }).status;
  }
  throw new Error("expected a status error");
};

describe("name rules", () => {
  it("keeps ordinary names and replaces reserved characters", () => {
    expect(sanitizeFolderName("Project Notes")).toBe("Project Notes");
    expect(sanitizeFolderName('a<b>:"c|d?e*f')).toBe("a_b___c_d_e_f");
    expect(sanitizeFolderName("trailing. ")).toBe("trailing");
  });

  it("refuses separators, traversal and empties", () => {
    for (const bad of ["", "  ", ".", "..", "a/b", "a\\b", "a%2Fb", "a%00b", "\t"]) {
      expect(() => sanitizeFolderName(bad), bad).toThrow();
    }
    expect(() => sanitizeFolderName(undefined)).toThrow();
  });

  it("splits a relative path into safe segments", () => {
    expect(sanitizeRelativePath("src/lib/util.ts")).toEqual(["src", "lib", "util.ts"]);
    expect(() => sanitizeRelativePath("src/../secret")).toThrow();
    expect(() => sanitizeRelativePath("/etc/passwd")).toThrow();
    expect(() => sanitizeRelativePath("a//b")).toThrow();
    expect(() => sanitizeRelativePath("")).toThrow();
    expect(() => sanitizeRelativePath(Array.from({ length: 40 }, () => "d").join("/"))).toThrow();
  });
});

describe("saveFolderFile", () => {
  it("rebuilds the folder under attachments/folders/<uploadId>/<name>", async () => {
    const uploadId = randomUUID();
    const saved = await saveFolderFile(bytesOf("hello ", "world"), {
      uploadId,
      folder: "Notes",
      relativePath: "week 1/monday.md",
    });
    const root = folderPath(uploadId, "Notes");
    expect(root).toBe(join(FOLDERS_DIR, uploadId, "Notes"));
    expect(root.startsWith(ATTACHMENTS_DIR)).toBe(true);
    expect(saved).toEqual({ path: join(root, "week 1", "monday.md"), folderPath: root, bytes: 11 });
    expect(readFileSync(saved.path, "utf8")).toBe("hello world");
    expect(readdirSync(join(root, "week 1")).filter((name) => name.includes("partial"))).toEqual([]);
    expect(folderUsage(root)).toEqual({ files: 1, bytes: 11 });
  });

  it("replaces the same file on retry and keeps siblings", async () => {
    const uploadId = randomUUID();
    const options = { uploadId, folder: "Notes", relativePath: "a.txt" };
    await saveFolderFile(bytesOf("first"), options);
    await saveFolderFile(bytesOf("b"), { ...options, relativePath: "b.txt" });
    const again = await saveFolderFile(bytesOf("second"), options);
    expect(readFileSync(again.path, "utf8")).toBe("second");
    expect(folderUsage(again.folderPath)).toEqual({ files: 2, bytes: 7 });
  });

  it("requires a uploadId and refuses bad names", async () => {
    expect(await status(saveFolderFile(bytesOf("x"), { uploadId: undefined, folder: "N", relativePath: "a" }))).toBe(400);
    expect(await status(saveFolderFile(bytesOf("x"), { uploadId: "nope", folder: "N", relativePath: "a" }))).toBe(400);
    const uploadId = randomUUID();
    expect(await status(saveFolderFile(bytesOf("x"), { uploadId, folder: "../N", relativePath: "a" }))).toBe(400);
    expect(await status(saveFolderFile(bytesOf("x"), { uploadId, folder: "N", relativePath: "../a" }))).toBe(400);
    expect(existsSync(join(FOLDERS_DIR, uploadId))).toBe(false);
  });

  it("refuses an empty file and leaves nothing behind", async () => {
    const uploadId = randomUUID();
    expect(await status(saveFolderFile(bytesOf(), { uploadId, folder: "N", relativePath: "empty.txt" }))).toBe(400);
    const root = folderPath(uploadId, "N");
    expect(readdirSync(root)).toEqual([]);
  });

  it("caps one file, the folder's file count, and the folder's bytes", async () => {
    const uploadId = randomUUID();
    const big = { uploadId, folder: "N", relativePath: "big.bin", expectedBytes: FILE_MAX_BYTES + 1 };
    expect(await status(saveFolderFile(bytesOf("x"), big))).toBe(413);

    const limits = { maxFiles: 2, maxBytes: 10 };
    await saveFolderFile(bytesOf("aaaa"), { uploadId, folder: "N", relativePath: "1" }, limits);
    await saveFolderFile(bytesOf("bbbb"), { uploadId, folder: "N", relativePath: "2" }, limits);
    expect(await status(saveFolderFile(bytesOf("c"), { uploadId, folder: "N", relativePath: "3" }, limits))).toBe(413);
    // replacing an existing file is not a new file, but the bytes still count
    await saveFolderFile(bytesOf("aa"), { uploadId, folder: "N", relativePath: "1" }, limits);
    expect(await status(saveFolderFile(bytesOf("bbbbbbbbb"), { uploadId, folder: "N", relativePath: "2" }, limits))).toBe(413);
    expect(readFileSync(join(folderPath(uploadId, "N"), "2"), "utf8")).toBe("bbbb");
    expect(await status(saveFolderFile(bytesOf("x"), { uploadId, folder: "N", relativePath: "1", expectedBytes: 20 }, limits))).toBe(413);
  });

  it("refuses to write over a directory", async () => {
    const uploadId = randomUUID();
    await saveFolderFile(bytesOf("x"), { uploadId, folder: "N", relativePath: "dir/file" });
    expect(await status(saveFolderFile(bytesOf("x"), { uploadId, folder: "N", relativePath: "dir" }))).toBe(409);
    expect(statSync(join(folderPath(uploadId, "N"), "dir")).isDirectory()).toBe(true);
  });
});
