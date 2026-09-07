import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isIP } from "node:net";

const ITEMS_PATH = "/api/poppy/v1/items";
const MAX_PAGE_ITEMS = 200;
const MAX_PAGES = 10_000;
const MAX_CURSOR_LENGTH = 512;
const MAX_ITEM_ID_LENGTH = 256;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const ITEM_ID_RE = /^[A-Za-z0-9_-]+$/;
const GENERIC_ALERT_TITLE = "Poppy needs your review.";
const GENERIC_ALERT_BODY = "Poppy needs your review.";

export class ReceiverError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "ReceiverError";
    this.code = code;
  }
}

function receiverError(code, message = code) {
  return new ReceiverError(code, message);
}

function isAllowedIPv4(host) {
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = octets;
  return a === 127 || (a === 100 && b >= 64 && b <= 127);
}

function isAllowedHost(host) {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  const ipKind = isIP(normalized);
  if (ipKind === 4) return isAllowedIPv4(normalized);
  if (ipKind === 6) {
    return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1" || normalized.startsWith("fd7a:115c:a1e0:");
  }
  return normalized === "localhost" || normalized.endsWith(".ts.net");
}

export function validatePrivateEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > 2048) {
    throw receiverError("INVALID_ENDPOINT");
  }
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw receiverError("INVALID_ENDPOINT");
  }
  if (!(["http:", "https:"].includes(parsed.protocol)) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw receiverError("INVALID_ENDPOINT");
  }
  if (!isAllowedHost(parsed.hostname)) {
    throw receiverError("NON_PRIVATE_ENDPOINT");
  }
  return parsed;
}

function validateConfig(config) {
  if (!config || typeof config !== "object") throw receiverError("INVALID_CONFIG");
  if (typeof config.deviceId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(config.deviceId)) {
    throw receiverError("INVALID_DEVICE_ID");
  }
  if (typeof config.token !== "string" || config.token.length < 1 || config.token.length > 4096) {
    throw receiverError("INVALID_TOKEN");
  }
  if (typeof config.statePath !== "string" || !config.statePath.startsWith("/")) {
    throw receiverError("INVALID_STATE_PATH");
  }
  const endpoint = validatePrivateEndpoint(config.endpoint);
  if (!config.adapter || typeof config.adapter.notify !== "function" || typeof config.adapter.openTopic !== "function") {
    throw receiverError("NATIVE_ADAPTER_UNAVAILABLE");
  }
  const requestTimeoutMs = config.requestTimeoutMs ?? 15_000;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1_000 || requestTimeoutMs > 120_000) {
    throw receiverError("INVALID_REQUEST_TIMEOUT");
  }
  return { ...config, endpoint, requestTimeoutMs, fetchImpl: config.fetchImpl ?? globalThis.fetch, now: config.now ?? (() => Date.now()) };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIsoDate(value) {
  return typeof value === "string" && value.length <= 64 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}

function validateNullableDate(value) {
  if (value !== null && !isIsoDate(value)) throw receiverError("MALFORMED_ITEM");
  return value;
}

export function validatePoppyItem(value) {
  if (!isPlainObject(value)) throw receiverError("MALFORMED_ITEM");
  if (typeof value.id !== "string" || value.id.length > MAX_ITEM_ID_LENGTH || !ITEM_ID_RE.test(value.id)) throw receiverError("MALFORMED_ITEM");
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw receiverError("MALFORMED_ITEM");
  if (typeof value.botId !== "string" || value.botId.length > MAX_ITEM_ID_LENGTH || !ITEM_ID_RE.test(value.botId)) throw receiverError("MALFORMED_ITEM");
  if (typeof value.threadId !== "string" || value.threadId.length > MAX_ITEM_ID_LENGTH || !ITEM_ID_RE.test(value.threadId)) throw receiverError("MALFORMED_ITEM");
  if (typeof value.sourceTaskId !== "string" || value.sourceTaskId.length > MAX_ITEM_ID_LENGTH || !ITEM_ID_RE.test(value.sourceTaskId)) throw receiverError("MALFORMED_ITEM");
  if (value.status !== "pending" && value.status !== "resolved") throw receiverError("MALFORMED_ITEM");
  if (typeof value.reviewStatus !== "string" || value.reviewStatus.length > 512) throw receiverError("MALFORMED_ITEM");
  validateNullableDate(value.readAt);
  validateNullableDate(value.dismissedAt);
  validateNullableDate(value.snoozedUntil);
  if (!isIsoDate(value.updatedAt) || typeof value.alertEligible !== "boolean") throw receiverError("MALFORMED_ITEM");
  return value;
}

function validatePage(value) {
  const allowedKeys = new Set(["cursor", "items", "hasMore", "nextPage"]);
  if (!isPlainObject(value) || Object.keys(value).some((key) => !allowedKeys.has(key)) || typeof value.cursor !== "string" || value.cursor.length < 1 || value.cursor.length > MAX_CURSOR_LENGTH || !Array.isArray(value.items) || value.items.length > MAX_PAGE_ITEMS || typeof value.hasMore !== "boolean") {
    throw receiverError("MALFORMED_PAGE");
  }
  const items = value.items.map(validatePoppyItem);
  if (value.hasMore && (value.nextPage === undefined || value.nextPage === null || value.nextPage === "")) throw receiverError("MALFORMED_PAGE");
  if (!value.hasMore && value.nextPage !== undefined && value.nextPage !== null && value.nextPage !== "") throw receiverError("MALFORMED_PAGE");
  return { cursor: value.cursor, items, hasMore: value.hasMore, nextPage: value.nextPage ?? null };
}

async function responseBody(response) {
  try {
    if (typeof response.json === "function") return await response.json();
    if (typeof response.text === "function") return JSON.parse(await response.text());
  } catch {
    return null;
  }
  return null;
}

function isSnapshotRequired(body) {
  return isPlainObject(body) && [body.reason, body.code, body.error].includes("snapshot-required");
}

function pageUrl(base, cursor, page = undefined) {
  const url = new URL(ITEMS_PATH, base);
  if (cursor) url.searchParams.set("cursor", cursor);
  if (page !== undefined) url.searchParams.set("page", page);
  return url;
}

function resolveNextPage(nextPage, base, cursor) {
  let url;
  if (typeof nextPage === "string") {
    if (nextPage.startsWith("/") || nextPage.startsWith("http://") || nextPage.startsWith("https://")) {
      try { url = new URL(nextPage, base); } catch { throw receiverError("MALFORMED_PAGE"); }
    } else if (nextPage.length <= MAX_CURSOR_LENGTH) {
      url = pageUrl(base, cursor, nextPage);
    } else {
      throw receiverError("MALFORMED_PAGE");
    }
  } else if (isPlainObject(nextPage) && typeof nextPage.page === "string" && nextPage.page.length <= MAX_CURSOR_LENGTH) {
    if (nextPage.cursor !== undefined && nextPage.cursor !== cursor) throw receiverError("MALFORMED_PAGE");
    url = pageUrl(base, cursor, nextPage.page);
  } else {
    throw receiverError("MALFORMED_PAGE");
  }
  if (url.origin !== base.origin || url.pathname !== ITEMS_PATH || url.username || url.password || url.hash) throw receiverError("MALFORMED_PAGE");
  if (url.searchParams.has("cursor") && url.searchParams.get("cursor") !== cursor) throw receiverError("MALFORMED_PAGE");
  url.searchParams.set("cursor", cursor);
  return url;
}

function deliveryKey(item) {
  return createHash("sha256").update(`${item.id}\u001f${item.revision}`).digest("hex");
}

function notificationIdentifier(key) {
  return `poppy-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

function isAlertable(item, now) {
  if (item.status !== "pending" || !item.alertEligible || item.readAt !== null || item.dismissedAt !== null) return false;
  return item.snoozedUntil === null || Date.parse(item.snoozedUntil) <= now;
}

function stateBinding(endpoint, deviceId) {
  return createHash("sha256").update(`${endpoint.origin}\u001f${deviceId}`).digest("hex");
}

function validateStoredState(value) {
  if (!isPlainObject(value) || value.version !== 2 || typeof value.binding !== "string" || !/^[a-f0-9]{64}$/.test(value.binding) || (value.cursor !== null && (typeof value.cursor !== "string" || value.cursor.length > MAX_CURSOR_LENGTH)) || !Array.isArray(value.deliveryKeys) || value.deliveryKeys.some((key) => typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key))) {
    throw receiverError("CORRUPT_STATE");
  }
  return { binding: value.binding, cursor: value.cursor, deliveryKeys: new Set(value.deliveryKeys) };
}

async function loadState(path, binding) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const details = await handle.stat();
    if (!details.isFile() || details.size > MAX_STATE_BYTES ||
        (typeof process.getuid === "function" && details.uid !== process.getuid())) throw receiverError("CORRUPT_STATE");
    if ((details.mode & 0o777) !== 0o600) throw receiverError("STATE_PERMISSIONS");
    const stored = validateStoredState(JSON.parse(await handle.readFile({ encoding: "utf8" })));
    if (stored.binding !== binding) return { binding, cursor: null, deliveryKeys: new Set() };
    return stored;
  } catch (error) {
    if (error?.code === "ENOENT") return { binding, cursor: null, deliveryKeys: new Set() };
    if (error instanceof ReceiverError) throw error;
    throw receiverError("CORRUPT_STATE");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const payload = JSON.stringify({ version: 2, binding: state.binding, cursor: state.cursor, deliveryKeys: [...state.deliveryKeys] }) + "\n";
  try {
    await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    const details = await stat(path);
    if ((details.mode & 0o777) !== 0o600) throw receiverError("STATE_PERMISSIONS");
  } catch (error) {
    try { await unlink(temporary); } catch { /* no-op: the atomic write either happened or did not */ }
    if (error instanceof ReceiverError) throw error;
    throw receiverError("STATE_WRITE_FAILED");
  }
}

export class PoppyDesktopReceiver {
  constructor(config) {
    this.config = validateConfig(config);
    this.binding = stateBinding(this.config.endpoint, this.config.deviceId);
    this.state = null;
    this.inFlight = null;
    this.timer = null;
  }

  async ensureState() {
    if (!this.state) this.state = await loadState(this.config.statePath, this.binding);
    return this.state;
  }

  async request(url) {
    let response;
    try {
      response = await this.config.fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        headers: { accept: "application/json", authorization: `Bearer ${this.config.token}` },
      });
    } catch {
      throw receiverError("NETWORK_UNAVAILABLE");
    }
    const body = await responseBody(response);
    if (response.status === 409 || response.status === 410) {
      if (isSnapshotRequired(body)) return { snapshotRequired: true };
    }
    if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
      throw receiverError("HTTP_UNAVAILABLE");
    }
    return { body };
  }

  async fetchSnapshot() {
    const pageResult = await this.request(pageUrl(this.config.endpoint, null));
    if (pageResult.snapshotRequired) throw receiverError("SNAPSHOT_REQUIRED");
    const first = validatePage(pageResult.body);
    const snapshotCursor = first.cursor;
    const items = [...first.items];
    let page = first;
    let pages = 1;
    while (page.hasMore) {
      if (++pages > MAX_PAGES) throw receiverError("PAGINATION_LIMIT");
      const next = resolveNextPage(page.nextPage, this.config.endpoint, snapshotCursor);
      const nextResult = await this.request(next);
      if (nextResult.snapshotRequired) throw receiverError("SNAPSHOT_CHANGED");
      page = validatePage(nextResult.body);
      if (page.cursor !== snapshotCursor) throw receiverError("SNAPSHOT_CHANGED");
      items.push(...page.items);
    }
    return { cursor: snapshotCursor, items };
  }

  async poll() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.pollOnce().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async pollOnce() {
    const state = await this.ensureState();
    const snapshot = await this.fetchSnapshot();
    const now = this.config.now();
    const planned = new Set();
    const actionable = [];
    for (const item of snapshot.items) {
      const key = deliveryKey(item);
      if (isAlertable(item, now) && !state.deliveryKeys.has(key) && !planned.has(key)) {
        planned.add(key);
        actionable.push({ item, key });
      }
    }
    for (const { item, key } of actionable) {
      await this.config.adapter.notify({
        identifier: notificationIdentifier(key),
        title: GENERIC_ALERT_TITLE,
        body: GENERIC_ALERT_BODY,
        itemAlias: item.id,
        revision: item.revision,
        onActivate: () => this.activate(item.id, item.revision),
      });
      state.deliveryKeys.add(key);
      await saveState(this.config.statePath, state);
    }
    state.cursor = snapshot.cursor;
    await saveState(this.config.statePath, state);
    return { cursor: snapshot.cursor, seen: snapshot.items.length, notified: actionable.length };
  }

  async activate(itemId, observedRevision = undefined) {
    if (typeof itemId !== "string" || !ITEM_ID_RE.test(itemId)) throw receiverError("INVALID_ITEM_ID");
    if (observedRevision !== undefined && (!Number.isSafeInteger(observedRevision) || observedRevision < 1)) throw receiverError("INVALID_REVISION");
    const url = new URL(`${ITEMS_PATH}/${encodeURIComponent(itemId)}`, this.config.endpoint);
    let response;
    try {
      response = await this.config.fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        headers: { accept: "application/json", authorization: `Bearer ${this.config.token}` },
      });
    } catch {
      await this.config.adapter.showUnavailable?.();
      return { status: "unavailable" };
    }
    if (response.status === 410) return { status: "gone" };
    if (response.status === 404) {
      await this.config.adapter.showUnavailable?.();
      return { status: "unavailable" };
    }
    if (response.status < 200 || response.status >= 300) throw receiverError("HTTP_UNAVAILABLE");
    let current;
    try { current = validatePoppyItem(await responseBody(response)); } catch { await this.config.adapter.showUnavailable?.(); return { status: "unavailable" }; }
    if (current.id !== itemId || (observedRevision !== undefined && current.revision < observedRevision)) {
      await this.config.adapter.showUnavailable?.();
      return { status: "unavailable" };
    }
    await this.config.adapter.openTopic(current);
    return { status: "opened", item: current };
  }

  start() {
    if (this.timer) return;
    const interval = this.config.pollIntervalMs ?? 30_000;
    if (!Number.isInteger(interval) || interval < 1_000) throw receiverError("INVALID_POLL_INTERVAL");
    void this.poll().catch(() => undefined);
    this.timer = setInterval(() => { void this.poll().catch(() => undefined); }, interval);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export function createPoppyDesktopReceiver(config) {
  return new PoppyDesktopReceiver(config);
}

export const poppyReceiverConstants = Object.freeze({ ITEMS_PATH, MAX_PAGE_ITEMS, GENERIC_ALERT_TITLE, GENERIC_ALERT_BODY });
