import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { poppyReferenceFromDeepLink, poppyReferenceFromCommandLine, resolvePoppyReference, createPoppyNavigation } from "./poppy-link.mjs";
import { createTopicOpener } from "../desktop-receiver/open-topic.mjs";

test("Poppy deep links admit only an opaque alias and exact integer revision", () => {
  assert.deepEqual(poppyReferenceFromDeepLink("openmausbot://poppy?item=opaque_1&revision=2"), { itemAlias: "opaque_1", revision: 2 });
  for (const url of [
    "https://poppy?item=opaque&revision=1", "openmausbot://poppy?item=../x&revision=1",
    "openmausbot://poppy?item=x&revision=1&token=secret", "openmausbot://poppy?item=x&revision=1#action",
    "openmausbot://poppy?item=x&revision=01", "openmausbot://poppy?item=x&revision=1.2",
    "openmausbot://poppy?item=x&revision=9007199254740992", "openmausbot://user@poppy?item=x&revision=1",
  ]) assert.equal(poppyReferenceFromDeepLink(url), null);
  assert.deepEqual(poppyReferenceFromCommandLine(["app", "--flag", "openmausbot://poppy?item=x&revision=1"]), { itemAlias: "x", revision: 1 });
});

const config = { endpoint: "https://fixture.tailnet.ts.net", token: "fixture-paired-token" };
const reference = { itemAlias: "opaque", revision: 2 };
test("current item resolution uses paired auth, rejects stale IDs and never redirects", async () => {
  let captured;
  const result = await resolvePoppyReference(reference, config, async (url, options) => {
    captured = { url, options };
    return Response.json({ id: "opaque", revision: 3, botId: "bot_current", threadId: "topic_current" });
  });
  assert.equal(captured.url.pathname, "/api/poppy/v1/items/opaque");
  assert.equal(captured.options.headers.authorization, "Bearer fixture-paired-token");
  assert.equal(captured.options.redirect, "error");
  assert.deepEqual(result, { itemAlias: "opaque", revision: 3, botId: "bot_current", threadId: "topic_current" });
  for (const item of [
    { id: "another", revision: 3, botId: "b", threadId: "t" },
    { id: "opaque", revision: 1, botId: "b", threadId: "t" },
    { id: "opaque", revision: 3, botId: "b", threadId: "../t" },
  ]) await assert.rejects(resolvePoppyReference(reference, config, async () => Response.json(item)), /POPPY_ITEM_UNAVAILABLE/);
});

test("purged references drop silently; unknown references report unavailable", async () => {
  assert.equal(await resolvePoppyReference(reference, config, async () => new Response(null, { status: 410 })), null);
  await assert.rejects(resolvePoppyReference(reference, config, async () => new Response(null, { status: 404 })), /POPPY_ITEM_UNAVAILABLE/);
});

test("native topic dispatch contains no canonical identity or credential", async () => {
  for (const platform of ["darwin", "linux"]) {
    let captured;
    const open = createTopicOpener({ platform, spawnImpl(...args) {
      captured = args;
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    } });
    await open({ id: "opaque", revision: 3, botId: "private-bot", threadId: "private-thread" });
    assert.equal(captured[0], platform === "darwin" ? "/usr/bin/open" : "/usr/bin/xdg-open");
    assert.deepEqual(captured[1], ["openmausbot://poppy?item=opaque&revision=3"]);
    assert.equal(captured[2].stdio, "ignore");
    assert.equal(JSON.stringify(captured).includes("private"), false);
  }
});

function navigationFixture(resolveReference) {
  const sent = [], errors = [];
  const win = { origin: "https://fixture.tailnet.ts.net", isDestroyed: () => false, webContents: {
    isLoadingMainFrame: () => false, getURL: () => win.origin, send: (...args) => sent.push(args),
  } };
  const navigation = createPoppyNavigation({ loadConfig: async () => ({ ...config, uiOrigin: "https://fixture.tailnet.ts.net" }),
    resolveReference, onUnavailable: code => errors.push(code) });
  return { navigation, win, sent, errors };
}

test("native navigation never delivers into a different or changed server origin", async () => {
  let release, reads = 0;
  const f = navigationFixture(async () => { reads++; return await new Promise(resolve => { release = resolve; }); });
  f.navigation.queue("openmausbot://poppy?item=opaque&revision=2");
  f.win.origin = "https://another.tailnet.ts.net";
  await f.navigation.deliver(f.win);
  assert.equal(reads, 0);
  assert.deepEqual(f.errors, ["POPPY_SERVER_NOT_SELECTED"]);
  f.win.origin = "https://fixture.tailnet.ts.net";
  f.navigation.queue("openmausbot://poppy?item=opaque&revision=2");
  const opening = f.navigation.deliver(f.win);
  await Promise.resolve();
  f.win.origin = "https://another.tailnet.ts.net";
  release({ botId: "private", threadId: "private" });
  await opening;
  assert.deepEqual(f.sent, []);
});

test("a delayed earlier tap cannot replace the newest Poppy destination", async () => {
  let release;
  const f = navigationFixture(async reference => reference.itemAlias === "older"
    ? await new Promise(resolve => { release = resolve; }) : { itemAlias: "newer", revision: 1, botId: "b", threadId: "t" });
  f.navigation.queue("openmausbot://poppy?item=older&revision=1");
  const older = f.navigation.deliver(f.win);
  await Promise.resolve();
  f.navigation.queue("openmausbot://poppy?item=newer&revision=1");
  await f.navigation.deliver(f.win);
  release({ itemAlias: "older", revision: 1, botId: "old", threadId: "old" });
  await older;
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][1].target.itemAlias, "newer");
  await f.navigation.deliver(f.win);
  assert.equal(f.sent.length, 1);
});
