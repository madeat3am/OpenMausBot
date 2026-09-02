// A folder uploaded from the phone, one file at a time.
//
// On the desktop a folder is attached by path: the bot can already read it.
// The phone's folders live on the phone, so it sends each file with its
// relative path, and the folder is rebuilt here under the attachments
// directory. The message then carries the rebuilt folder's path in the
// same <attached-file> tag a desktop folder gets, so bots see no difference.
//
// Every name arrives from the phone and is treated as untrusted: separators
// and traversal are refused rather than cleaned, reserved characters are
// replaced, and one folder is bounded in files, bytes, and depth.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ATTACHMENTS_DIR, FILE_MAX_BYTES, validateAttachmentUploadId } from "./attachments.ts";

export const FOLDERS_DIR = join(ATTACHMENTS_DIR, "folders");
export const FOLDER_MAX_FILES = 500;
export const FOLDER_MAX_BYTES = 200 * 1024 * 1024;
export const FOLDER_MAX_DEPTH = 32;

export interface FolderLimits {
  maxFiles: number;
  maxBytes: number;
}

export interface SavedFolderFile {
  path: string;
  folderPath: string;
  bytes: number;
}

const PARTIAL_NAME = /^\.openmaus-upload-[0-9a-f-]+\.partial$/i;

function statusError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/** One path segment: no separators, no traversal, no control or reserved
 * characters, and something visible left once those are gone. */
export function sanitizeSegment(value: unknown, what: string): string {
  if (typeof value !== "string") throw statusError(400, `${what} is required`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) throw statusError(400, `${what} is required`);
  if (normalized === "." || normalized === "..") throw statusError(400, `${what} must not be a traversal`);
  if (/[\\/]/.test(normalized) || /%(?:00|2f|5c)/i.test(normalized)) {
    throw statusError(400, `${what} must not contain a path separator`);
  }
  const safe = Array.from(normalized, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 || "<>:\"|?*".includes(character) ? "_" : character;
  }).join("").replace(/[.\s]+$/, "");
  if (!safe || Buffer.byteLength(safe) > 255) throw statusError(400, `${what} must be a valid name`);
  return safe;
}

export function sanitizeFolderName(value: unknown): string {
  return sanitizeSegment(value, "folder");
}

/** The relative path of one file inside the folder, as safe segments. */
export function sanitizeRelativePath(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) throw statusError(400, "path is required");
  const segments = value.split("/");
  if (segments.length > FOLDER_MAX_DEPTH) throw statusError(400, `path is nested deeper than ${FOLDER_MAX_DEPTH}`);
  return segments.map((segment) => sanitizeSegment(segment, "path"));
}

export function folderPath(uploadId: string, folderName: string): string {
  return join(FOLDERS_DIR, uploadId, folderName);
}

/** Files and bytes already in a folder, ignoring in-flight partials. */
export function folderUsage(root: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (directory: string) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && !PARTIAL_NAME.test(entry.name)) {
        files += 1;
        try {
          bytes += statSync(path).size;
        } catch {
          // removed underneath the scan
        }
      }
    }
  };
  walk(root);
  return { files, bytes };
}

/** Stream one file of a folder into place. A retry of the same file
 * replaces it; a failed or empty upload leaves nothing behind. */
export async function saveFolderFile(
  chunks: AsyncIterable<Uint8Array>,
  options: { uploadId: string | undefined; folder: unknown; relativePath: unknown; expectedBytes?: number },
  limits: FolderLimits = { maxFiles: FOLDER_MAX_FILES, maxBytes: FOLDER_MAX_BYTES },
): Promise<SavedFolderFile> {
  const uploadId = validateAttachmentUploadId(options.uploadId);
  if (!uploadId) throw statusError(400, "uploadId is required");
  const folderName = sanitizeFolderName(options.folder);
  const segments = sanitizeRelativePath(options.relativePath);
  const expectedBytes = options.expectedBytes;
  if (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)) {
    throw statusError(400, "content-length must be a non-negative integer");
  }
  if (expectedBytes !== undefined && expectedBytes > FILE_MAX_BYTES) {
    throw statusError(413, `file exceeds ${FILE_MAX_BYTES} bytes`);
  }

  const root = folderPath(uploadId, folderName);
  const target = join(root, ...segments);
  const replacing = existsSync(target);
  if (replacing && !statSync(target).isFile()) {
    throw statusError(409, "path names a directory in this folder");
  }
  const usage = folderUsage(root);
  const existingBytes = replacing ? statSync(target).size : 0;
  if (!replacing && usage.files >= limits.maxFiles) {
    throw statusError(413, `folder exceeds ${limits.maxFiles} files`);
  }
  const otherBytes = usage.bytes - existingBytes;
  if (otherBytes + (expectedBytes ?? 0) > limits.maxBytes) {
    throw statusError(413, `folder exceeds ${limits.maxBytes} bytes`);
  }

  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const partialPath = join(dirname(target), `.openmaus-upload-${randomUUID()}.partial`);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let bytes = 0;
  let closed = false;
  try {
    file = await open(partialPath, "wx", 0o600);
    for await (const value of chunks) {
      const chunk = Buffer.isBuffer(value)
        ? value
        : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      if (chunk.byteLength === 0) continue;
      if (bytes + chunk.byteLength > FILE_MAX_BYTES) {
        throw statusError(413, `file exceeds ${FILE_MAX_BYTES} bytes`);
      }
      if (otherBytes + bytes + chunk.byteLength > limits.maxBytes) {
        throw statusError(413, `folder exceeds ${limits.maxBytes} bytes`);
      }
      let offset = 0;
      while (offset < chunk.byteLength) {
        const result = await file.write(chunk, offset, chunk.byteLength - offset, null);
        if (result.bytesWritten === 0) throw new Error("file write made no progress");
        offset += result.bytesWritten;
      }
      bytes += chunk.byteLength;
    }
    if (bytes === 0) throw statusError(400, "empty file");
    await file.close();
    closed = true;
    renameSync(partialPath, target);
    return { path: target, folderPath: root, bytes };
  } catch (error) {
    if (file && !closed) await file.close().catch(() => undefined);
    try {
      unlinkSync(partialPath);
    } catch {
      // never written, or already moved into place
    }
    throw error;
  }
}
