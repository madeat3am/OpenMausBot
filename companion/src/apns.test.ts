import { createVerify, generateKeyPairSync, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type * as http2 from "node:http2";

import { describe, expect, it } from "vitest";

import {
  createApnsProvider,
  createNativeHttp2Transport,
  type ApnsTransport,
  type ApnsTransportRequest,
} from "./apns.ts";

const NOW = Date.parse("2026-09-07T15:00:00.000Z");
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function provider(transport: ApnsTransport, overrides: Record<string, unknown> = {}) {
  return createApnsProvider({
    teamId: "TEAM123456",
    keyId: "KEY1234567",
    privateKey: privateKeyPem,
    bundleId: "com.openmausbot.app",
    environment: "development",
    now: () => NOW,
    requestId: () => "11111111-1111-4111-8111-111111111111",
    transport,
    ...overrides,
  });
}

function requestCapture(response: { statusCode: number; headers?: Record<string, string>; body?: string }) {
  const calls: ApnsTransportRequest[] = [];
  const transport: ApnsTransport = {
    async request(input) {
      calls.push(input);
      return response;
    },
    async close() {},
  };
  return { calls, transport };
}

describe("native APNs Poppy provider", () => {
  it("signs ES256 and sends only the generic opaque Poppy payload", async () => {
    const { calls, transport } = requestCapture({
      statusCode: 200,
      headers: { "apns-id": "22222222-2222-4222-8222-222222222222", date: "Mon, 07 Sep 2026 15:00:01 GMT" },
    });
    const result = await provider(transport).sendPoppyPush({
      deviceToken: "aabbccdd",
      itemAlias: "item_opaque_1",
      revision: 3,
      registrationVersion: "v1",
    });

    expect(result).toMatchObject({ status: "accepted", apnsId: "22222222-2222-4222-8222-222222222222", statusCode: 200, registrationVersion: "v1" });
    expect(result.timestamp).toBe("2026-09-07T15:00:00.000Z");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.authority).toBe("api.development.push.apple.com");
    expect(call.path).toBe("/3/device/aabbccdd");
    const payload = JSON.parse(call.body) as Record<string, unknown>;
    expect(payload).toEqual({
      aps: { alert: { title: "Poppy needs your review." }, sound: "default" },
      poppyInterface: 1,
      poppy: { itemId: "item_opaque_1", revision: 3 },
      kind: "poppy",
    });
    expect(JSON.stringify(payload)).not.toContain("client");
    expect(call.headers["apns-topic"]).toBe("com.openmausbot.app");
    expect(call.headers["apns-push-type"]).toBe("alert");
    expect(call.headers["apns-collapse-id"]).toMatch(/^[0-9a-f]{64}$/);

    const [header, encodedPayload, encodedSignature] = call.headers.authorization!.slice(7).split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(JSON.parse(Buffer.from(encodedPayload!, "base64url").toString())).toEqual({ iss: "TEAM123456", iat: 1788793200 });
    const verifier = createVerify("SHA256");
    verifier.update(`${header}.${encodedPayload}`);
    verifier.end();
    expect(verifier.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(encodedSignature!, "base64url"))).toBe(true);
  });

  const responses: Array<[
    { statusCode: number; headers?: Record<string, string>; body?: string },
    "invalid-token" | "retryable" | "permanent",
  ]> = [
    [{ statusCode: 400, body: JSON.stringify({ reason: "BadDeviceToken" }) }, "invalid-token"],
    [{ statusCode: 410, body: JSON.stringify({ reason: "Unregistered", timestamp: 1788793201000 }) }, "invalid-token"],
    [{ statusCode: 429, headers: { "retry-after": "9" } }, "retryable"],
    [{ statusCode: 503, body: JSON.stringify({ reason: "ServiceUnavailable" }) }, "retryable"],
    [{ statusCode: 400, body: JSON.stringify({ reason: "BadTopic" }) }, "permanent"],
    [{ statusCode: 99 }, "permanent"],
  ];
  it.each(responses)("classifies APNs response %j", async (response, expected) => {
    const { transport } = requestCapture(response);
    const result = await provider(transport).sendPoppyPush({
      deviceToken: "aabb",
      itemAlias: "item",
      revision: 1,
    });
    expect(result.status).toBe(expected);
    if (response.headers?.["retry-after"]) expect(result.retryAfterSeconds).toBe(9);
    else expect(result.retryAfterSeconds).toBeUndefined();
    if (response.statusCode === 410) expect(result.invalidationTimestampMs).toBe(1788793201000);
  });

  it("aborts a stalled transport at the configured timeout", async () => {
    let aborted = false;
    const transport: ApnsTransport = {
      request(input) {
        input.signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise(() => undefined);
      },
      async close() {},
    };
    const result = await provider(transport, { timeoutMs: 5, requestId: randomUUID }).sendPoppyPush({
      deviceToken: "aabb",
      itemAlias: "item",
      revision: 1,
    });
    expect(result.status).toBe("retryable");
    expect(result.reason).toBe("APNs request timed out");
    expect(aborted).toBe(true);
  });

  it("rejects caller data that cannot be an opaque APNs registration or identifier", async () => {
    expect(() => provider(requestCapture({ statusCode: 200 }).transport, { bundleId: "client name" })).toThrow();
    expect(() => provider(requestCapture({ statusCode: 200 }).transport, { environment: "staging" })).toThrow();
    await expect(provider(requestCapture({ statusCode: 200 }).transport).sendPoppyPush({
      deviceToken: "AABB",
      itemAlias: "item",
      revision: 1,
    })).rejects.toThrow();
    await expect(provider(requestCapture({ statusCode: 200 }).transport).sendPoppyPush({
      deviceToken: "a",
      itemAlias: "item",
      revision: 1,
    })).rejects.toThrow("1 through 512 bytes");
    await expect(provider(requestCapture({ statusCode: 200 }).transport).sendPoppyPush({
      deviceToken: "aa".repeat(513),
      itemAlias: "item",
      revision: 1,
    })).rejects.toThrow("1 through 512 bytes");
  });

  it("accepts only APNs' exact 200 success status", async () => {
    const { transport } = requestCapture({ statusCode: 201 });
    await expect(provider(transport).sendPoppyPush({
      deviceToken: "aabb",
      itemAlias: "item",
      revision: 1,
    })).resolves.toMatchObject({ status: "permanent", reason: "UnexpectedAPNsStatus" });
  });

  it("does not expose private transport error details", async () => {
    const transport: ApnsTransport = {
      async request() {
        throw new Error("connect failed for private-host.internal with credential xyz");
      },
      async close() {},
    };
    await expect(provider(transport).sendPoppyPush({
      deviceToken: "aabb",
      itemAlias: "item",
      revision: 1,
    })).resolves.toMatchObject({ status: "retryable", reason: "APNs transport failed" });
  });
});

class FakeStream extends EventEmitter {
  destroyed = false;
  body = "";

  constructor(
    private readonly responseBody: string,
    private readonly autoRespond: boolean,
  ) {
    super();
  }

  setEncoding() {}

  end(body: string) {
    this.body = body;
    if (!this.autoRespond) return;
    queueMicrotask(() => {
      if (this.destroyed) return;
      this.emit("response", { ":status": 200 });
      if (this.responseBody) this.emit("data", this.responseBody);
      this.emit("end");
    });
  }

  destroy() {
    this.destroyed = true;
    return this;
  }
}

class FakeSession extends EventEmitter {
  closed = false;
  destroyed = false;
  closeCalls = 0;
  autoRespond = true;
  responseBody = "";
  readonly requests: Array<{ headers: http2.OutgoingHttpHeaders; stream: FakeStream }> = [];

  request(headers: http2.OutgoingHttpHeaders) {
    const stream = new FakeStream(this.responseBody, this.autoRespond);
    this.requests.push({ headers, stream });
    return stream;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.closeCalls += 1;
    queueMicrotask(() => this.emit("close"));
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    queueMicrotask(() => this.emit("close"));
  }
}

describe("native APNs HTTP/2 lifecycle", () => {
  it("caches provider JWTs, reuses a session, reconnects after failure, and closes", async () => {
    let now = NOW;
    let requestNumber = 0;
    const sessions: FakeSession[] = [];
    const connect = ((_authority: string) => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    }) as unknown as typeof http2.connect;
    const transport = createNativeHttp2Transport(connect);
    const apns = createApnsProvider({
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      privateKey: privateKeyPem,
      bundleId: "com.openmausbot.app",
      environment: "development",
      now: () => now,
      requestId: () => `11111111-1111-4111-8111-${String(++requestNumber).padStart(12, "0")}`,
      transport,
    });
    const push = () => apns.sendPoppyPush({ deviceToken: "aabb", itemAlias: "item", revision: 1 });

    await expect(push()).resolves.toMatchObject({ status: "accepted" });
    now += 60_000;
    await expect(push()).resolves.toMatchObject({ status: "accepted" });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.requests).toHaveLength(2);
    expect(sessions[0]!.requests[0]!.headers.authorization).toBe(sessions[0]!.requests[1]!.headers.authorization);

    now += 40 * 60 * 1000;
    await expect(push()).resolves.toMatchObject({ status: "accepted" });
    expect(sessions[0]!.requests[2]!.headers.authorization).not.toBe(sessions[0]!.requests[1]!.headers.authorization);

    sessions[0]!.autoRespond = false;
    const failedPush = push();
    await Promise.resolve();
    const failedStream = sessions[0]!.requests[3]!.stream;
    sessions[0]!.emit("error", new Error("private network detail"));
    await expect(failedPush).resolves.toMatchObject({ status: "retryable", reason: "APNs transport failed" });
    expect(() => failedStream.emit("error", new Error("late stream error"))).not.toThrow();

    await expect(push()).resolves.toMatchObject({ status: "accepted" });
    expect(sessions).toHaveLength(2);
    expect(sessions[1]!.requests[0]!.headers.authorization).toBe(sessions[0]!.requests[2]!.headers.authorization);

    sessions[1]!.emit("goaway");
    expect(sessions[1]!.closeCalls).toBe(1);
    await expect(push()).resolves.toMatchObject({ status: "accepted" });
    expect(sessions).toHaveLength(3);
    await apns.close();
    expect(sessions[2]!.closeCalls).toBe(1);
    await apns.close();
    expect(sessions[2]!.closeCalls).toBe(1);
    await expect(push()).rejects.toThrow("provider is closed");
  });

  it("replaces a stalled native session before retrying", async () => {
    const sessions: FakeSession[] = [];
    const connect = ((_authority: string) => {
      const session = new FakeSession();
      session.autoRespond = sessions.length > 0;
      sessions.push(session);
      return session;
    }) as unknown as typeof http2.connect;
    const apns = provider(createNativeHttp2Transport(connect), { timeoutMs: 5 });
    const push = () => apns.sendPoppyPush({ deviceToken: "aabb", itemAlias: "item", revision: 1 });
    await expect(push()).resolves.toMatchObject({ status: "retryable", reason: "APNs request timed out" });
    expect(sessions[0]!.destroyed).toBe(true);
    await expect(push()).resolves.toMatchObject({ status: "accepted" });
    expect(sessions).toHaveLength(2);
    await apns.close();
  });

  it("bounds native APNs response bodies", async () => {
    const sessions: FakeSession[] = [];
    const connect = ((_authority: string) => {
      const session = new FakeSession();
      session.responseBody = "x".repeat(16 * 1024 + 1);
      sessions.push(session);
      return session;
    }) as unknown as typeof http2.connect;
    const apns = provider(createNativeHttp2Transport(connect));

    await expect(apns.sendPoppyPush({
      deviceToken: "aabb",
      itemAlias: "item",
      revision: 1,
    })).resolves.toMatchObject({ status: "retryable", reason: "APNs transport failed" });
    expect(sessions[0]!.requests[0]!.stream.destroyed).toBe(true);
    await apns.close();
  });
});
