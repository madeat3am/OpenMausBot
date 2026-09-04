import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { composioEventMaterialDigest, routeComposioWebhook, verifyComposioWebhook } from "./composio-webhook.ts";
import { parseAutonomyPolicy } from "./autonomy-policy.ts";

const secret = "webhook-test-secret";
const now = Date.parse("2026-09-03T18:00:00Z");
const timestamp = String(now / 1_000);
const body = Buffer.from(JSON.stringify({ id: "evt-1", type: "composio.trigger.message", metadata: { log_id: "log-1", trigger_slug: "GMAIL_NEW_MESSAGE", connected_account_id: "personal" }, data: { message_id: "m-1" } }));

function signed(raw = body, at = timestamp, signingSecret = secret) {
  const id = "wh-1";
  const signature = createHmac("sha256", signingSecret).update(`${id}.${at}.`).update(raw).digest("base64");
  return { rawBody: raw, webhookId: id, webhookTimestamp: at, webhookSignature: `v1,${signature}`, secret: signingSecret, now };
}

describe("Composio webhook", () => {
  it("verifies the exact raw body and five-minute timestamp window", () => {
    expect(verifyComposioWebhook(signed())).toMatchObject({ id: "evt-1", metadata: { log_id: "log-1" } });
    expect(verifyComposioWebhook(signed(body, timestamp, "whsec_literal-value"))).toMatchObject({ id: "evt-1" });
    expect(() => verifyComposioWebhook({ ...signed(), rawBody: Buffer.from(`${body.toString()} `) })).toThrow(/signature/);
    expect(() => verifyComposioWebhook(signed(body, String(Number(timestamp) - 301)))).toThrow(/stale/);
  });

  it("routes only exact policy trigger and account bindings", () => {
    const { policy } = parseAutonomyPolicy({
      schema: "openmausbot.autonomy-policy.v1", revision: "test", rules: [],
      webhooks: [{ id: "gmail-personal", triggerSlugs: ["GMAIL_NEW_MESSAGE"], botId: "communications", connectedAccountIds: ["personal"] }],
    });
    const event = verifyComposioWebhook(signed());
    expect(routeComposioWebhook(policy, event)).toMatchObject({ botId: "communications" });
    expect(composioEventMaterialDigest(event)).toMatch(/^[a-f0-9]{64}$/);
  });
});
