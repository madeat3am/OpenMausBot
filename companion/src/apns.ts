import { createHash, createPrivateKey, createSign, KeyObject, randomUUID } from "node:crypto";
import * as http2 from "node:http2";

export type ApnsEnvironment = "development" | "production";

export interface PoppyPushRequest {
  deviceToken: string;
  /** Per-pairing opaque alias; the canonical item id never enters an APNs payload. */
  itemAlias: string;
  revision: number;
  /** Copied into the result so the integration can reject late invalidations. */
  registrationVersion?: string | number;
}

export interface ApnsTransportRequest {
  authority: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  signal: AbortSignal;
}

export interface ApnsTransportResponse {
  statusCode: number;
  headers?: Readonly<Record<string, string | undefined>>;
  body?: string;
}

/** A narrow seam for tests and for the owner of the eventual delivery loop. */
export interface ApnsTransport {
  request(input: ApnsTransportRequest): Promise<ApnsTransportResponse>;
  close(): Promise<void>;
}

export interface ApnsProviderConfig {
  teamId: string;
  keyId: string;
  privateKey: string | KeyObject;
  bundleId: string;
  environment: ApnsEnvironment;
  timeoutMs?: number;
  now?: () => number;
  requestId?: () => string;
  transport?: ApnsTransport;
}

export type ApnsResultStatus = "accepted" | "retryable" | "invalid-token" | "permanent";

export interface ApnsResult {
  status: ApnsResultStatus;
  /** The request APNs identifier, or the response's canonical identifier when present. */
  apnsId: string;
  /** Local observation time in ISO-8601 form. */
  timestamp: string;
  statusCode?: number;
  reason?: string;
  /** Apple response timestamp, in milliseconds since Unix epoch, for token invalidation. */
  invalidationTimestampMs?: number;
  retryAfterSeconds?: number;
  serverDate?: string;
  registrationVersion?: string | number;
}

export interface ApnsProvider {
  sendPoppyPush(request: PoppyPushRequest): Promise<ApnsResult>;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ID_LENGTH = 256;
const MAX_TOKEN_HEX_LENGTH = 1024;
const MAX_RESPONSE_BODY_BYTES = 16 * 1024;
const PROVIDER_TOKEN_REFRESH_MS = 40 * 60 * 1000;
const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  development: "api.development.push.apple.com",
  production: "api.push.apple.com",
};
const INVALID_TOKEN_REASONS = new Set(["BadDeviceToken", "Unregistered"]);
const RETRYABLE_REASONS = new Set([
  "ExpiredProviderToken",
  "IdleTimeout",
  "InternalServerError",
  "ProtocolError",
  "ServiceUnavailable",
  "Shutdown",
  "TooManyProviderTokenUpdates",
  "TooManyRequests",
]);

class ApnsTimeoutError extends Error {
  constructor() {
    super("APNs request timed out");
    this.name = "ApnsTimeoutError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function validateOpaqueId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > MAX_ID_LENGTH) {
    throw new TypeError(`${field} must be a non-empty opaque base64url-like identifier`);
  }
  return value;
}

function validateRegistrationVersion(value: string | number | undefined): string | number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("registrationVersion must be a positive safe integer");
    return value;
  }
  return validateOpaqueId(value, "registrationVersion");
}

function validateConfig(config: ApnsProviderConfig): Required<
  Pick<ApnsProviderConfig, "teamId" | "keyId" | "bundleId" | "environment" | "timeoutMs">
> & {
  privateKey: KeyObject;
  now: () => number;
  requestId: () => string;
  transport: ApnsTransport;
} {
  if (!isRecord(config)) throw new TypeError("APNs provider config must be an object");
  if (typeof config.teamId !== "string" || !/^[A-Za-z0-9]{10}$/.test(config.teamId)) {
    throw new TypeError("teamId must contain exactly 10 ASCII letters or digits");
  }
  if (typeof config.keyId !== "string" || !/^[A-Za-z0-9]{10}$/.test(config.keyId)) {
    throw new TypeError("keyId must contain exactly 10 ASCII letters or digits");
  }
  if (config.bundleId !== "com.openmausbot.app") {
    throw new TypeError("bundleId must be the project-owned com.openmausbot.app topic");
  }
  if (config.environment !== "development" && config.environment !== "production") {
    throw new TypeError("environment must be development or production");
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new RangeError("timeoutMs must be an integer from 1 through 120000");
  }

  if (typeof config.privateKey !== "string" && !(config.privateKey instanceof KeyObject)) {
    throw new TypeError("privateKey must be a PEM string or KeyObject");
  }
  const privateKey = typeof config.privateKey === "string"
    ? createPrivateKey(config.privateKey)
    : config.privateKey;
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ec") {
    throw new TypeError("privateKey must be an EC private key");
  }
  if (privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new TypeError("privateKey must use the P-256 curve for ES256");
  }

  const now = config.now ?? Date.now;
  const requestId = config.requestId ?? randomUUID;
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (typeof requestId !== "function") throw new TypeError("requestId must be a function");
  const transport = config.transport ?? createNativeHttp2Transport();
  if (!transport || typeof transport.request !== "function" || typeof transport.close !== "function") {
    throw new TypeError("transport must implement request and close");
  }
  return {
    teamId: config.teamId,
    keyId: config.keyId,
    privateKey,
    bundleId: config.bundleId,
    environment: config.environment,
    timeoutMs,
    now,
    requestId,
    transport,
  };
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function signProviderToken(config: ReturnType<typeof validateConfig>, issuedAtSeconds: number): string {
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const payload = base64Url(JSON.stringify({ iss: config.teamId, iat: issuedAtSeconds }));
  const signingInput = `${header}.${payload}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign({ key: config.privateKey, dsaEncoding: "ieee-p1363" });
  if (signature.length !== 64) throw new Error("ES256 signature must be 64 bytes");
  return `${signingInput}.${base64Url(signature)}`;
}

function collapseId(itemId: string, revision: number): string {
  return createHash("sha256").update(`${itemId}:${revision}`, "utf8").digest("hex");
}

function responseHeader(
  headers: Readonly<Record<string, string | undefined>> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

function responseDetails(body: string | undefined): { reason?: string; invalidationTimestampMs?: number } {
  if (!body) return {};
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) return {};
    const reason = typeof parsed.reason === "string" ? parsed.reason : undefined;
    const invalidationTimestampMs = typeof parsed.timestamp === "number" && Number.isSafeInteger(parsed.timestamp) && parsed.timestamp >= 0
      ? parsed.timestamp
      : undefined;
    return { ...(reason ? { reason } : {}), ...(invalidationTimestampMs === undefined ? {} : { invalidationTimestampMs }) };
  } catch {
    return {};
  }
}

function retryAfterSeconds(value: string | undefined, nowMs: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) && date >= nowMs ? Math.ceil((date - nowMs) / 1000) : undefined;
}

function classifyResponse(
  response: ApnsTransportResponse,
  requestId: string,
  timestamp: string,
  nowMs: number,
  registrationVersion: string | number | undefined,
): ApnsResult {
  const details = responseDetails(response.body);
  const reason = details.reason;
  const apnsId = responseHeader(response.headers, "apns-id") ?? requestId;
  const serverDate = responseHeader(response.headers, "date");
  const statusCode = response.statusCode;
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    return {
      status: "permanent",
      apnsId,
      timestamp,
      statusCode,
      reason: "InvalidAPNsStatus",
      ...(registrationVersion === undefined ? {} : { registrationVersion }),
    };
  }
  const base = {
    apnsId,
    timestamp,
    statusCode,
    ...(reason ? { reason } : {}),
    ...(statusCode === 410 && details.invalidationTimestampMs !== undefined
      ? { invalidationTimestampMs: details.invalidationTimestampMs }
      : {}),
    ...(serverDate ? { serverDate } : {}),
    ...(registrationVersion === undefined ? {} : { registrationVersion }),
  };
  if (statusCode === 200) return { status: "accepted", ...base };
  if (statusCode >= 200 && statusCode < 300) {
    return { status: "permanent", ...base, reason: reason ?? "UnexpectedAPNsStatus" };
  }
  if (statusCode === 410 || (reason !== undefined && INVALID_TOKEN_REASONS.has(reason))) {
    return { status: "invalid-token", ...base };
  }
  if (statusCode === 408 || statusCode === 429 || statusCode >= 500 || (reason !== undefined && RETRYABLE_REASONS.has(reason))) {
    const retryAfter = retryAfterSeconds(responseHeader(response.headers, "retry-after"), nowMs);
    return { status: "retryable", ...base, ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }) };
  }
  return { status: "permanent", ...base };
}

function errorResult(error: unknown, requestId: string, timestamp: string): ApnsResult {
  return {
    status: "retryable",
    apnsId: requestId,
    timestamp,
    reason: error instanceof ApnsTimeoutError ? "APNs request timed out" : "APNs transport failed",
  };
}

async function requestWithTimeout(
  transport: ApnsTransport,
  input: Omit<ApnsTransportRequest, "signal">,
  timeoutMs: number,
): Promise<ApnsTransportResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const transportPromise = transport.request({ ...input, signal: controller.signal });
  try {
    return await new Promise<ApnsTransportResponse>((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ApnsTimeoutError());
      }, timeoutMs);
      transportPromise.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface NativeSession {
  authority: string;
  session: http2.ClientHttp2Session;
  failures: Set<(error: Error) => void>;
}

/** Native reusable HTTP/2 transport used by the provider's fixed APNs authority. */
export function createNativeHttp2Transport(connect: typeof http2.connect = http2.connect): ApnsTransport {
  let current: NativeSession | undefined;
  let closed = false;

  const invalidate = (record: NativeSession, error: Error) => {
    if (current === record) current = undefined;
    for (const fail of record.failures) fail(error);
    record.failures.clear();
  };

  const sessionFor = (authority: string): NativeSession => {
    if (closed) throw new Error("APNs HTTP/2 transport is closed");
    if (current && current.authority === authority && !current.session.closed && !current.session.destroyed) {
      return current;
    }
    if (current) {
      current.session.close();
      current = undefined;
    }
    const session = connect(`https://${authority}`);
    const record: NativeSession = { authority, session, failures: new Set() };
    current = record;
    // These listeners remain for the session lifetime so a late event can never
    // become an unhandled EventEmitter error after an individual stream settles.
    session.on("error", (error: Error) => {
      invalidate(record, error);
      if (!session.destroyed) session.destroy();
    });
    session.on("close", () => invalidate(record, new Error("APNs HTTP/2 session closed")));
    session.on("goaway", () => {
      invalidate(record, new Error("APNs HTTP/2 session received GOAWAY"));
      session.close();
    });
    return record;
  };

  return {
    request(input) {
      return new Promise<ApnsTransportResponse>((resolve, reject) => {
        let record: NativeSession | undefined;
        let stream: http2.ClientHttp2Stream | undefined;
        let statusCode = 0;
        let responseHeaders: Record<string, string | undefined> = {};
        let body = "";
        let bodyBytes = 0;
        let settled = false;

        const cleanup = () => {
          input.signal.removeEventListener("abort", onAbort);
          record?.failures.delete(onSessionFailure);
        };
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          stream?.destroy();
          reject(error instanceof Error ? error : new Error("APNs HTTP/2 transport failed"));
        };
        const onStreamError = (error: Error) => fail(error);
        const onSessionFailure = (error: Error) => fail(error);
        const onAbort = () => {
          const error = new ApnsTimeoutError();
          if (record) {
            invalidate(record, error);
            record.session.destroy();
          } else fail(error);
        };

        if (input.signal.aborted) {
          fail(new ApnsTimeoutError());
          return;
        }
        input.signal.addEventListener("abort", onAbort, { once: true });
        try {
          record = sessionFor(input.authority);
          record.failures.add(onSessionFailure);
          stream = record.session.request(input.headers as http2.OutgoingHttpHeaders);
          stream.setEncoding("utf8");
          // Keep the handler for the stream lifetime so a late error remains handled.
          stream.on("error", onStreamError);
          stream.once("response", (headers) => {
            const rawStatus = headers[":status"];
            statusCode = typeof rawStatus === "number" ? rawStatus : Number(rawStatus);
            for (const [key, value] of Object.entries(headers)) {
              if (typeof value === "string") responseHeaders[key] = value;
            }
          });
          stream.on("data", (chunk: string) => {
            bodyBytes += Buffer.byteLength(chunk);
            if (bodyBytes > MAX_RESPONSE_BODY_BYTES) {
              fail(new Error("APNs response body exceeded limit"));
              return;
            }
            body += chunk;
          });
          stream.once("end", () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({ statusCode, headers: responseHeaders, body });
          });
          stream.end(input.body);
        } catch (error) {
          fail(error);
        }
      });
    },
    async close() {
      closed = true;
      const record = current;
      current = undefined;
      if (!record || record.session.closed || record.session.destroyed) return;
      await new Promise<void>((resolve) => {
        record.session.once("close", resolve);
        record.session.close();
      });
    },
  };
}

export function createApnsProvider(rawConfig: ApnsProviderConfig): ApnsProvider {
  const config = validateConfig(rawConfig);
  const authority = APNS_HOSTS[config.environment];
  let cachedToken: { value: string; issuedAtMs: number } | undefined;
  let closed = false;

  const tokenAt = (nowMs: number): NonNullable<typeof cachedToken> => {
    if (
      cachedToken
      && nowMs >= cachedToken.issuedAtMs
      && nowMs - cachedToken.issuedAtMs < PROVIDER_TOKEN_REFRESH_MS
    ) {
      return cachedToken;
    }
    const value = signProviderToken(config, Math.floor(nowMs / 1000));
    cachedToken = { value, issuedAtMs: nowMs };
    return cachedToken;
  };

  return {
    async sendPoppyPush(request): Promise<ApnsResult> {
      if (closed) throw new Error("APNs provider is closed");
      if (!isRecord(request)) throw new TypeError("Poppy push request must be an object");
      if (
        typeof request.deviceToken !== "string"
        || request.deviceToken.length < 2
        || request.deviceToken.length > MAX_TOKEN_HEX_LENGTH
        || request.deviceToken.length % 2 !== 0
        || !/^[0-9a-f]+$/.test(request.deviceToken)
      ) {
        throw new TypeError("deviceToken must encode 1 through 512 bytes as lowercase hexadecimal");
      }
      validateOpaqueId(request.itemAlias, "itemAlias");
      if (!Number.isSafeInteger(request.revision) || request.revision < 1) {
        throw new TypeError("revision must be a positive safe integer");
      }
      const registrationVersion = validateRegistrationVersion(request.registrationVersion);

      const nowMs = config.now();
      if (!Number.isFinite(nowMs) || nowMs <= 0) throw new RangeError("now must return a positive millisecond timestamp");
      const timestamp = new Date(nowMs).toISOString();
      const requestId = config.requestId();
      if (typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
        throw new TypeError("requestId must return a UUID");
      }
      const payload = JSON.stringify({
        aps: { alert: { title: "Poppy needs your review." }, sound: "default" },
        poppyInterface: 1,
        poppy: { itemId: request.itemAlias, revision: request.revision },
        kind: "poppy",
      });
      const token = tokenAt(nowMs);
      const headers: Record<string, string> = {
        ":method": "POST",
        ":path": `/3/device/${request.deviceToken}`,
        ":authority": authority,
        authorization: `bearer ${token.value}`,
        "apns-topic": config.bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-id": requestId,
        "apns-collapse-id": collapseId(request.itemAlias, request.revision),
        "content-type": "application/json",
      };
      try {
        const response = await requestWithTimeout(
          config.transport,
          { authority, path: headers[":path"], headers, body: payload },
          config.timeoutMs,
        );
        const result = classifyResponse(response, requestId, timestamp, nowMs, registrationVersion);
        // Apple explicitly permits a fresh JWT after ExpiredProviderToken. Only
        // clear the exact cached object used by this request: an older response
        // must not evict a token refreshed by a concurrent request.
        if (result.status === "retryable" && result.reason === "ExpiredProviderToken" && cachedToken === token) cachedToken = undefined;
        return result;
      } catch (error) {
        const result = errorResult(error, requestId, timestamp);
        return registrationVersion === undefined ? result : { ...result, registrationVersion };
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      cachedToken = undefined;
      await config.transport.close();
    },
  };
}
