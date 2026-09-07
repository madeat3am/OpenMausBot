const opaque = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);

export function poppyReferenceFromDeepLink(raw) {
  if (typeof raw !== "string") return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "openmausbot:" || url.hostname !== "poppy" || url.username || url.password || url.port ||
      (url.pathname !== "" && url.pathname !== "/") || url.hash || url.searchParams.size !== 2) return null;
  const itemAlias = url.searchParams.get("item");
  const rawRevision = url.searchParams.get("revision");
  const revision = Number(rawRevision);
  if (!opaque(itemAlias) || !/^[1-9][0-9]*$/.test(rawRevision ?? "") || !Number.isSafeInteger(revision)) return null;
  return { itemAlias, revision };
}

export function poppyReferenceFromCommandLine(argv) {
  return argv.map(poppyReferenceFromDeepLink).find(Boolean) ?? null;
}

/** Config is read by the native main process, never by a renderer. The
 * caller must check the destination origin again after this await. */
export async function resolvePoppyReference(reference, config, fetchImpl = fetch) {
  if (!opaque(reference.itemAlias) || !Number.isSafeInteger(reference.revision) || reference.revision < 1) {
    throw new Error("POPPY_ITEM_UNAVAILABLE");
  }
  const response = await fetchImpl(new URL(`/api/poppy/v1/items/${reference.itemAlias}`, config.endpoint), {
    headers: { authorization: `Bearer ${config.token}`, accept: "application/json" },
    redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 410) return null;
  if (!response.ok) throw new Error("POPPY_ITEM_UNAVAILABLE");
  const item = await response.json();
  if (item?.id !== reference.itemAlias || !Number.isSafeInteger(item.revision) || item.revision < reference.revision ||
      !opaque(item.botId) || !opaque(item.threadId)) throw new Error("POPPY_ITEM_UNAVAILABLE");
  return { itemAlias: reference.itemAlias, revision: item.revision, botId: item.botId, threadId: item.threadId };
}

/** Receive-only bridge to the matching server. Both sides of every await
 * retain navigation intent and origin checks; a page never supplies a token. */
export function createPoppyNavigation({ initialReference = null, loadConfig, onUnavailable, resolveReference = resolvePoppyReference }) {
  let pending = initialReference;
  let generation = 0;
  return {
    queue(rawLink) {
      const reference = poppyReferenceFromDeepLink(rawLink);
      if (!reference) return false;
      pending = reference;
      generation++;
      return true;
    },
    async deliver(win) {
      if (!pending || !win || win.isDestroyed() || win.webContents.isLoadingMainFrame()) return;
      const reference = pending;
      const attempt = ++generation;
      const current = () => attempt === generation && reference === pending && !win.isDestroyed();
      try {
        const config = await loadConfig();
        if (!current()) return;
        if (new URL(win.webContents.getURL()).origin !== config.uiOrigin) throw new Error("POPPY_SERVER_NOT_SELECTED");
        const target = await resolveReference(reference, config);
        if (!current()) return;
        if (new URL(win.webContents.getURL()).origin !== config.uiOrigin || win.webContents.isLoadingMainFrame()) return;
        pending = null;
        if (target) win.webContents.send("poppy:open", { uiOrigin: config.uiOrigin, target });
      } catch (error) {
        if (!current()) return;
        pending = null;
        onUnavailable(error?.message === "POPPY_SERVER_NOT_SELECTED" ? "POPPY_SERVER_NOT_SELECTED" : "POPPY_ITEM_UNAVAILABLE");
      }
    },
  };
}
