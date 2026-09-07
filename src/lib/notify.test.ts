import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildNotificationOptions,
  requestNotificationPermission,
  showNotification,
  type NotifyFrame,
} from "./notify";

const frame: NotifyFrame = {
  kind: "done",
  botId: "bot-1",
  botName: "Maus",
  threadId: "thread-1",
  title: "Maus finished",
  body: "All done",
};
const knownBot = { name: "Maus", chiefOfStaff: false };

function installNotification(permission: NotificationPermission, focused = false) {
  const notices: Array<{ title: string; options?: NotificationOptions; onclick: (() => void) | null }> = [];
  const requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  class FakeNotification {
    static permission = permission;
    static requestPermission = requestPermission;
    onclick: (() => void) | null = null;
    constructor(public title: string, public options?: NotificationOptions) {
      notices.push(this);
    }
  }
  vi.stubGlobal("Notification", FakeNotification);
  vi.stubGlobal("document", { hasFocus: () => focused });
  vi.stubGlobal("window", { focus: vi.fn() });
  return { notices, requestPermission };
}

afterEach(() => vi.unstubAllGlobals());

describe("desktop notifications", () => {
  it("does not request permission from a background notification frame", () => {
    const { notices, requestPermission } = installNotification("default");
    showNotification(frame, vi.fn(), undefined, undefined, knownBot);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(notices).toHaveLength(0);
  });

  it("requests permission through the explicit settings action", async () => {
    const { requestPermission } = installNotification("default");
    await requestNotificationPermission();
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it("shows a notification after permission is granted", () => {
    const { notices } = installNotification("granted");
    showNotification(frame, vi.fn(), undefined, undefined, knownBot);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ title: frame.title, options: { body: frame.body, tag: `openmausbot:${frame.botId}` } });
  });

  it("never emits an OS alert for a versioned Poppy frame", () => {
    const { notices } = installNotification("granted");

    showNotification({
      ...frame,
      kind: "poppy",
      poppyInterface: 1,
      poppy: { itemId: "opaque-item", revision: 2 },
      title: "sensitive report title",
      body: "sensitive report body",
    }, vi.fn(), undefined, undefined, knownBot);

    expect(notices).toHaveLength(0);
  });

  it("stays silent for legacy frames without a hydrated bot profile", () => {
    const { notices } = installNotification("granted");
    const legacy = { ...frame, botName: "Poppy", title: "private client", body: "private report" };

    showNotification(legacy, vi.fn(), undefined, undefined, undefined);
    showNotification(legacy, vi.fn(), undefined, undefined, null);

    expect(notices).toHaveLength(0);
  });

  it("fails closed for an unsupported hub version even without other hub markers", () => {
    const { notices } = installNotification("granted");
    showNotification({ ...frame, poppyInterface: 2 }, vi.fn(), undefined, undefined, knownBot);
    expect(notices).toHaveLength(0);
  });

  it("suppresses legacy frames only for the canonical Poppy profile", () => {
    const { notices } = installNotification("granted");

    showNotification(frame, vi.fn(), undefined, undefined, {
      name: "Poppy",
      chiefOfStaff: true,
    });
    showNotification(frame, vi.fn(), undefined, undefined, {
      name: "Poppy",
      chiefOfStaff: false,
    });
    showNotification(frame, vi.fn(), undefined, undefined, {
      name: "Moxie",
      chiefOfStaff: true,
    });

    expect(notices).toHaveLength(2);
  });

  it("stays quiet only when the exact target thread is already visible", () => {
    const { notices } = installNotification("granted", true);

    showNotification(frame, vi.fn(), undefined, frame.threadId, knownBot);

    expect(notices).toHaveLength(0);
  });

  it("still alerts a focused app when another task is visible", () => {
    const { notices } = installNotification("granted", true);

    showNotification(frame, vi.fn(), undefined, "another-thread", knownBot);

    expect(notices).toHaveLength(1);
  });

  it("opens the exact detached task carried by the notification", () => {
    const { notices } = installNotification("granted");
    const onOpen = vi.fn();

    showNotification({ ...frame, threadId: "detached-routine-thread" }, onOpen, undefined, undefined, knownBot);
    notices[0]!.onclick?.();

    expect(window.focus).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith({
      botId: frame.botId,
      threadId: "detached-routine-thread",
    });
  });

  it("groups under the bot, not the thread", () => {
    const { notices } = installNotification("granted");

    showNotification(frame, vi.fn(), undefined, undefined, knownBot);
    showNotification(
      { ...frame, threadId: "thread-2", body: "Second task done" },
      vi.fn(),
      undefined, undefined, knownBot,
    );

    // one bot across two threads shares a tag, so the platform replaces
    // rather than stacks; another bot gets its own key
    expect(notices[0]?.options?.tag).toBe(`openmausbot:${frame.botId}`);
    expect(notices[1]?.options?.tag).toBe(`openmausbot:${frame.botId}`);
    showNotification({ ...frame, botId: "bot-2" }, vi.fn(), undefined, undefined, knownBot);
    expect(notices[2]?.options?.tag).toBe(`openmausbot:bot-2`);
  });

  it("carries the bot's avatar when its profile has one", () => {
    const { notices } = installNotification("granted");
    const avatarUrl = "/api/attachments/123e4567-e89b-12d3-a456-426614174000.png";

    showNotification(frame, vi.fn(), avatarUrl, undefined, knownBot);
    expect(notices[0]?.options?.icon).toBe(avatarUrl);

    showNotification(frame, vi.fn(), null, undefined, knownBot);
    expect(notices[1]?.options?.icon).toBeUndefined();
  });
});

describe("buildNotificationOptions", () => {
  it("keys coalescing on botId and omits a missing avatar", () => {
    expect(buildNotificationOptions({ id: "bot-9" })).toEqual({
      tag: "openmausbot:bot-9",
      icon: undefined,
    });
  });
});
