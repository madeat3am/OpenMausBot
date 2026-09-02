import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  MESSAGE_FILE_MAX_BYTES,
  messageFileDisposition,
  messageFileRoots,
  messageReferencesFile,
  openMessageFile,
} from "./message-file.ts";

const suite = mkdtempSync(join(tmpdir(), "omb-message-file-"));
const workspace = join(suite, "workspace");
const outside = join(suite, "outside");

beforeEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterAll(() => rmSync(suite, { recursive: true, force: true }));

describe("message-linked files", () => {
  it("never widens an explicitly null pinned cwd to the configured folder", () => {
    expect(messageFileRoots({
      senderWorkspace: "/app/workspace",
      attachments: "/app/attachments",
      pinnedCwd: null,
      configuredCwd: "/later/project",
    })).toEqual(["/app/workspace", "/app/attachments"]);
    expect(messageFileRoots({
      senderWorkspace: "/app/workspace",
      attachments: "/app/attachments",
      pinnedCwd: undefined,
      configuredCwd: "/current/project",
    })[0]).toBe("/current/project");
  });

  it("matches Unix, Windows, and UNC links independently of the server OS", () => {
    expect(messageReferencesFile(
      "[Open the notes](file:///Users/milind/Project/release%20notes.md)",
      "/Users/milind/Project/release notes.md",
    )).toBe(true);
    expect(messageReferencesFile(
      "I created /Users/milind/Project/release notes.md for you.",
      "/Users/milind/Project/release notes.md",
    ))
      .toBe(false);
    expect(messageReferencesFile(
      "[Open it](C:\\Users\\Maus\\report.md)",
      "C:\\Users\\Maus\\report.md",
    )).toBe(true);
    expect(messageReferencesFile(
      "[Open it](file:///C:/Users/Maus/release%20notes.md)",
      "C:\\Users\\Maus\\release notes.md",
    )).toBe(true);
    expect(messageReferencesFile(
      "[Open it](file://server/share/phone%20report.md)",
      "\\\\server\\share\\phone report.md",
    )).toBe(true);
    expect(messageReferencesFile(
      "[Open A&amp;B](docs/A&amp;B.md \"download\")",
      "docs/A&B.md",
    )).toBe(true);
    expect(messageReferencesFile("<file:///Users/milind/report.md>", "/Users/milind/report.md"))
      .toBe(true);

    // Equivalent separators and dot segments are normalised within a path
    // flavour, but distinct path flavours and casing remain distinct.
    expect(messageReferencesFile(
      "[Open it](C:/Users/Maus/drafts/../report.md)",
      "C:\\Users\\Maus\\report.md",
    )).toBe(true);
    expect(messageReferencesFile("[Open it](/C:/Users/Maus/report.md)", "C:/Users/Maus/report.md"))
      .toBe(false);
    expect(messageReferencesFile("[Open it](C:/Users/Maus/report.md)", "c:/users/maus/report.md"))
      .toBe(false);
  });

  it("resolves only definitions used by rendered reference links", () => {
    expect(messageReferencesFile(
      "[Open the report][Download]\n\n[download]: /Users/milind/report.md",
      "/Users/milind/report.md",
    )).toBe(true);
    expect(messageReferencesFile(
      "[unused]: /project/.env",
      "/project/.env",
    )).toBe(false);
  });

  it("does not grant file paths from Markdown that is not a rendered link", () => {
    const path = "/project/.env";
    for (const markdown of [
      "```markdown\n[x](/project/.env)\n```",
      "~~~\n[x](/project/.env)\n~~~",
      "    [x](/project/.env)",
      "\t[x](/project/.env)",
      "> ```\n> [x](/project/.env)\n> ```",
      "- ```markdown\n  [x](/project/.env)\n  ```",
      "`[x](/project/.env)`",
      "``look at `[x](/project/.env)` here``",
      "\\[x](/project/.env)",
      "![x](/project/.env)",
      "![x](</project/.env>)",
      "![x][secret]\n\n[secret]: /project/.env",
      "<!-- [x](/project/.env) -->",
      "<attached-file path=\"/project/.env\" />",
      "I saved it at /project/.env.",
    ]) {
      expect(messageReferencesFile(markdown, path), markdown).toBe(false);
    }

    expect(messageReferencesFile(
      "`[sample](/project/.env)` but [open the real file](/project/.env)",
      path,
    )).toBe(true);
    expect(messageReferencesFile("\\![open](/project/.env)", path)).toBe(true);
    expect(messageReferencesFile(
      "[not a valid destination](/project/foo\\ bar.md)",
      "/project/foo\\ bar.md",
    )).toBe(false);
  });

  it("opens encoded relative and file URL links through a stable handle", async () => {
    const path = join(workspace, "release notes.md");
    writeFileSync(path, "# unchanged bytes\n");

    const relative = await openMessageFile("release%20notes.md#today", [workspace]);
    expect(relative).toMatchObject({
      bytes: 18,
      name: "release notes.md",
      mime: "text/markdown; charset=utf-8",
    });
    expect(await relative.handle.readFile("utf8")).toBe("# unchanged bytes\n");
    await relative.handle.close();

    const absolute = await openMessageFile(pathToFileURL(path).href, [workspace]);
    expect(await absolute.handle.readFile("utf8")).toBe("# unchanged bytes\n");
    await absolute.handle.close();
  });

  it("refuses traversal and a symlink that resolves outside the allowed root", async () => {
    const secret = join(outside, "secret.md");
    writeFileSync(secret, "not for this conversation");
    symlinkSync(secret, join(workspace, "escape.md"));

    await expect(openMessageFile("../outside/secret.md", [workspace]))
      .rejects.toMatchObject({ status: 403 });
    await expect(openMessageFile("escape.md", [workspace]))
      .rejects.toMatchObject({ status: 403 });
  });

  it("accepts only regular files no larger than the phone download ceiling", async () => {
    await expect(openMessageFile(".", [workspace]))
      .rejects.toMatchObject({ status: 400 });

    const large = join(workspace, "large.pdf");
    writeFileSync(large, "x");
    truncateSync(large, MESSAGE_FILE_MAX_BYTES + 1);
    await expect(openMessageFile("large.pdf", [workspace]))
      .rejects.toMatchObject({ status: 413 });
  });

  it("emits a safe UTF-8 attachment filename", () => {
    const header = messageFileDisposition("résumé \"final\".md");
    expect(header).toContain('filename="re_sume_ _final_.md"');
    expect(header).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.md");
    expect(header).not.toContain("\r");
    expect(header).not.toContain("\n");
  });
});
