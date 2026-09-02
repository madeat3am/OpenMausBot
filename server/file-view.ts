// Serving a bot-created file to a client that has no disk to read.
//
// When a reply links a document it wrote, the desktop app reads that path
// straight off the local disk (electron/save-file.mjs). The phone sees the
// same link and has nothing behind it, so it asks the server for the bytes
// instead. The containment rule is the same one the desktop applies: the
// canonical path must sit under the data directory, and it must be a regular
// file. Paths arrive from model-rendered markdown, so they are untrusted.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./config.ts";

export const VIEW_FILE_MAX_BYTES = 25 * 1024 * 1024;

export interface ViewableFile {
  path: string;
  name: string;
  mime: string;
  bytes: number;
}

function statusError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/** Extensions served as something other than plain text. HTML and SVG are
 * deliberately absent: a bot-written page is shown as its source, never
 * rendered as markup by whatever fetched it. */
const KNOWN_TYPES: Readonly<Record<string, string>> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** Source and config files a bot commonly writes; shown as text. Anything
 * not listed here or above is an opaque download. */
const TEXT_EXTENSIONS = new Set([
  ".log", ".yaml", ".yml", ".toml", ".ini", ".env", ".xml", ".html", ".htm", ".svg", ".css",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs", ".swift", ".kt",
  ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".sh", ".zsh", ".bash", ".sql", ".diff", ".patch",
]);

export function mimeForViewableFile(path: string): string {
  const extension = extname(path).toLowerCase();
  const known = KNOWN_TYPES[extension];
  if (known) return known.startsWith("text/") || known === "application/json" ? `${known}; charset=utf-8` : known;
  if (TEXT_EXTENSIONS.has(extension)) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

/** Where bot-created files may be read from: the data directory, and the
 * default one, which differ only when OMB_DATA_DIR points elsewhere. */
export function viewableFileRoots(): string[] {
  const roots = new Set<string>();
  for (const candidate of [DATA_DIR, join(homedir(), ".openmausbot")]) {
    try {
      roots.add(realpathSync(candidate));
    } catch {
      // A root that does not exist cannot contain anything.
    }
  }
  return [...roots];
}

function normalizeRequestedPath(rawPath: unknown): string {
  if (typeof rawPath !== "string" || !rawPath.trim()) throw statusError(400, "path is required");
  const trimmed = rawPath.trim();
  if (trimmed.includes("\0")) throw statusError(400, "That file path is invalid");
  if (/^file:\/\//i.test(trimmed)) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      throw statusError(400, "That file path is invalid");
    }
  }
  if (!isAbsolute(trimmed)) throw statusError(400, "That file path is invalid");
  return trimmed;
}

/** Resolve a linked path to a file this server is willing to serve, or
 * throw an error carrying the HTTP status that explains why not. */
export function resolveViewableFile(rawPath: unknown, roots: string[] = viewableFileRoots()): ViewableFile {
  const requested = normalizeRequestedPath(rawPath);
  let path: string;
  try {
    path = realpathSync(requested);
  } catch {
    throw statusError(404, "That file no longer exists");
  }
  const contained = roots.some((root) => path === root || path.startsWith(root + sep));
  if (!contained) throw statusError(403, "Only files created by your bots can be viewed");
  const stats = statSync(path);
  if (!stats.isFile()) throw statusError(400, "That path is not a file");
  if (stats.size > VIEW_FILE_MAX_BYTES) {
    throw statusError(413, `That file is larger than ${VIEW_FILE_MAX_BYTES} bytes`);
  }
  return { path, name: basename(path), mime: mimeForViewableFile(path), bytes: stats.size };
}

export function readViewableFile(file: ViewableFile): Buffer {
  return readFileSync(file.path);
}

/** A Content-Disposition value that survives header encoding: ASCII-only in
 * the quoted form, the real name in the RFC 5987 form. */
export function contentDispositionFor(name: string): string {
  const ascii = name.replace(/["\\]/g, "_").replace(/[^\x20-\x7e]/g, "_");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
