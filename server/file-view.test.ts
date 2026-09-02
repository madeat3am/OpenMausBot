// file-view.ts: the containment that keeps a linked path inside the data
// directory, the mime table, and the errors a bad link produces.
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { contentDispositionFor, mimeForViewableFile, resolveViewableFile, viewableFileRoots } from "./file-view.ts";

// The vitest setup gives this file a throwaway home, and DATA_DIR is the
// .openmausbot directory inside it. The home itself is "outside".
const DATA = DATA_DIR;
const ROOT = dirname(DATA_DIR);

const inside = join(DATA, "documents", "report.md");
const outside = join(ROOT, "elsewhere.md");

beforeAll(() => {
  mkdirSync(join(DATA, "documents"), { recursive: true });
  writeFileSync(inside, "# Report\n\nhello\n");
  writeFileSync(outside, "not yours\n");
  symlinkSync(outside, join(DATA, "documents", "escape.md"));
});

afterAll(() => rmSync(DATA, { recursive: true, force: true }));

const status = (fn: () => unknown): number => {
  try {
    fn();
  } catch (error) {
    return (error as { status: number }).status;
  }
  throw new Error("expected a status error");
};

describe("resolveViewableFile", () => {
  it("serves a regular file under the data directory", () => {
    const file = resolveViewableFile(inside);
    expect(file.path).toBe(realpathSync(inside));
    expect(file.name).toBe("report.md");
    expect(file.mime).toBe("text/markdown; charset=utf-8");
    expect(file.bytes).toBe(16);
  });

  it("accepts the file:// form bots also emit", () => {
    expect(resolveViewableFile(pathToFileURL(inside).href).name).toBe("report.md");
  });

  it("includes the data directory in its roots", () => {
    expect(viewableFileRoots()).toContain(realpathSync(DATA));
  });

  it("refuses a path outside the data directory", () => {
    expect(status(() => resolveViewableFile(outside))).toBe(403);
  });

  it("refuses a symlink that escapes the data directory", () => {
    expect(status(() => resolveViewableFile(join(DATA, "documents", "escape.md")))).toBe(403);
  });

  it("refuses traversal that lands outside", () => {
    expect(status(() => resolveViewableFile(join(DATA, "documents", "..", "..", "elsewhere.md")))).toBe(403);
  });

  it("refuses a directory", () => {
    expect(status(() => resolveViewableFile(join(DATA, "documents")))).toBe(400);
  });

  it("refuses relative, empty, and malformed paths", () => {
    expect(status(() => resolveViewableFile("documents/report.md"))).toBe(400);
    expect(status(() => resolveViewableFile(""))).toBe(400);
    expect(status(() => resolveViewableFile(undefined))).toBe(400);
    expect(status(() => resolveViewableFile("file://not a url\0"))).toBe(400);
  });

  it("reports a missing file as 404", () => {
    expect(status(() => resolveViewableFile(join(DATA, "documents", "gone.md")))).toBe(404);
  });
});

describe("mimeForViewableFile", () => {
  it("serves markdown and code as text, markup as text, unknown as a download", () => {
    expect(mimeForViewableFile("/x/a.md")).toBe("text/markdown; charset=utf-8");
    expect(mimeForViewableFile("/x/a.swift")).toBe("text/plain; charset=utf-8");
    expect(mimeForViewableFile("/x/a.html")).toBe("text/plain; charset=utf-8");
    expect(mimeForViewableFile("/x/a.svg")).toBe("text/plain; charset=utf-8");
    expect(mimeForViewableFile("/x/a.pdf")).toBe("application/pdf");
    expect(mimeForViewableFile("/x/a.bin")).toBe("application/octet-stream");
  });
});

describe("contentDispositionFor", () => {
  it("keeps the quoted name ASCII and the starred name exact", () => {
    expect(contentDispositionFor('ré"port.md')).toBe(
      `inline; filename="r__port.md"; filename*=UTF-8''r%C3%A9%22port.md`,
    );
  });
});
