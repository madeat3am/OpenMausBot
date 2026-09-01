import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { QueuedComposerMessages } from "./ComposerQueuedMessages";

describe("QueuedComposerMessages", () => {
  it("keeps pending sends visibly attached to the composer", () => {
    const html = renderToStaticMarkup(createElement(QueuedComposerMessages, {
      items: [{ queueId: "q1", text: "follow up after this" }],
      onCancel: vi.fn(),
    }));

    expect(html).toContain('aria-label="Queued messages"');
    expect(html).toContain("follow up after this");
    expect(html).toContain("Queued for the next turn");
    expect(html).toContain('aria-label="Cancel queued message"');
  });
});
