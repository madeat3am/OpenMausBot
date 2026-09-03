// Saved servers ("environments") for the desktop app, pure and testable.
//
// Local is the server this app spawns; a remote environment is a server the
// user paired with. The app switches by loading that server's own UI, so an
// environment is {id, name, origin, environmentId}. The client-local `id`
// drives the menu; `environmentId` is the server's stable identity and pins a
// saved origin so DNS or proxy drift cannot silently replace it. The credential is the
// HttpOnly cookie the /pair page set for that origin, held by Chromium's
// cookie jar, never by this file.
const LOCAL_ID = "local";
const MAX_NAME = 60;
const REMOTE_RETRY_DELAYS_MS = [3_000, 4_000, 8_000, 16_000];
const REMOTE_STABLE_RESET_MS = 30_000;

function createEnvironmentSwitchEpoch() {
  let current = 0;
  return {
    begin: () => ++current,
    isCurrent: (epoch) => epoch === current,
  };
}

function normalizeEnvironmentId(input) {
  return typeof input === "string" && /^[0-9a-f-]{36}$/i.test(input.trim()) ? input.trim().toLowerCase() : null;
}

/** `https://host[:port]` — a bare origin, no path, no credentials. */
function normalizeOrigin(input) {
  if (typeof input !== "string") return null;
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  return url.origin;
}

/** Turn what the server printed — `https://host/pair#code=XXXX-XXXX-XXXX`,
 * or just an origin — into where to go. The code stays in the hash, so the
 * page consumes it and it never reaches a server log. */
function parsePairingLink(input) {
  const origin = normalizeOrigin(input);
  if (!origin) return null;
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  // A code travels in the hash only: a query string reaches server logs.
  if (url.searchParams.has("code")) return null;
  const code = /(?:^|[#&])code=([^&]+)/.exec(url.hash)?.[1] ?? null;
  const isPairPage = url.pathname === "/pair" || url.pathname === "/pair/";
  if (code && !isPairPage) return null; // a code belongs on /pair; anything else is not a pairing link
  return { origin, code: code ? decodeURIComponent(code) : null, url: code ? `${origin}/pair#code=${code}` : origin };
}

function cleanName(value, fallback) {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, MAX_NAME) : "";
  return name || fallback;
}

function nameFromOrigin(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** Parse the persisted file. Unknown or damaged content yields the empty
 * state rather than an error: losing a saved list costs a re-pair, not the app. */
function parseEnvironments(raw) {
  let value;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { environments: [], activeId: LOCAL_ID };
  }
  const list = Array.isArray(value?.environments) ? value.environments : [];
  const seen = new Set();
  const environments = [];
  for (const entry of list) {
    const origin = normalizeOrigin(entry?.origin);
    const id = typeof entry?.id === "string" && /^[\w-]{1,64}$/.test(entry.id) ? entry.id : null;
    if (!origin || !id || id === LOCAL_ID || seen.has(id) || seen.has(origin)) continue;
    seen.add(id);
    seen.add(origin);
    const environmentId = normalizeEnvironmentId(entry?.environmentId);
    environments.push({
      id,
      name: cleanName(entry?.name, nameFromOrigin(origin)),
      origin,
      ...(environmentId ? { environmentId } : {}),
    });
  }
  const activeId = typeof value?.activeId === "string" && environments.some((e) => e.id === value.activeId) ? value.activeId : LOCAL_ID;
  return { environments, activeId };
}

/** Read the on-disk profile without turning ignorance into an empty profile.
 * ENOENT is the one trustworthy first-run signal; every other read or shape
 * failure is unavailable so the desktop cannot silently open a writable Local. */
function loadEnvironmentProfile(read) {
  let raw;
  try {
    raw = read();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { status: "empty", state: { environments: [], activeId: LOCAL_ID } };
    }
    return { status: "unavailable", error: error?.message ?? String(error) };
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: "unavailable", error: "the saved server profile is not readable" };
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Array.isArray(value.environments) ||
    typeof value.activeId !== "string" ||
    (value.version !== undefined && value.version !== 1 && value.version !== 2)
  ) {
    return { status: "unavailable", error: "the saved server profile has an invalid shape" };
  }
  const state = parseEnvironments(value);
  const activeIsValid = value.activeId === LOCAL_ID || state.environments.some((entry) => entry.id === value.activeId);
  const v2IdentitiesAreValid =
    value.version !== 2 || value.environments.every((entry) => normalizeEnvironmentId(entry?.environmentId));
  if (state.environments.length !== value.environments.length || !activeIsValid || !v2IdentitiesAreValid) {
    return { status: "unavailable", error: "the saved server profile has an invalid environment" };
  }
  return { status: "ok", state };
}

function serializeEnvironments(state) {
  return JSON.stringify({ version: 2, environments: state.environments, activeId: state.activeId }, null, 2) + "\n";
}

/** Add or update by origin (re-pairing the same server keeps one entry). */
function withEnvironment(state, input, makeId) {
  const origin = normalizeOrigin(input?.origin);
  if (!origin) return state;
  const existing = state.environments.find((e) => e.origin === origin);
  if (existing) {
    const name = cleanName(input?.name, existing.name);
    const environments = state.environments.map((e) => (e === existing ? { ...e, name } : e));
    return { ...state, environments };
  }
  const id = makeId();
  const environments = [...state.environments, { id, name: cleanName(input?.name, nameFromOrigin(origin)), origin }];
  return { ...state, environments };
}

/** Bind a server-provided identity to its saved origin. Legacy profiles are
 * pinned on their first successful descriptor read; a later identity change
 * is rejected without modifying the saved profile. */
function withEnvironmentIdentity(state, input) {
  const origin = normalizeOrigin(input?.origin);
  const environmentId = normalizeEnvironmentId(input?.environmentId);
  if (!origin || !environmentId) return { ok: false, code: "invalid_identity", state };
  const existing = state.environments.find((environment) => environment.origin === origin);
  if (!existing) return { ok: false, code: "unknown_origin", state };
  if (existing.environmentId && existing.environmentId !== environmentId) {
    return {
      ok: false,
      code: "identity_changed",
      expectedEnvironmentId: existing.environmentId,
      actualEnvironmentId: environmentId,
      state,
    };
  }
  if (existing.environmentId === environmentId) return { ok: true, state };
  const environments = state.environments.map((environment) =>
    environment === existing ? { ...environment, environmentId } : environment,
  );
  return { ok: true, state: { ...state, environments } };
}

function withoutEnvironment(state, id) {
  const environments = state.environments.filter((e) => e.id !== id);
  return { environments, activeId: state.activeId === id ? LOCAL_ID : state.activeId };
}

function withActive(state, id) {
  if (id !== LOCAL_ID && !state.environments.some((e) => e.id === id)) return state;
  return { ...state, activeId: id };
}

function activeEnvironment(state) {
  return state.environments.find((e) => e.id === state.activeId) ?? null;
}

/** Decide whether a remote failure belongs to the currently selected server.
 * Failures never select Local: only an explicit `withActive(..., LOCAL_ID)`
 * transition may change that durable preference. */
function remoteFailurePolicy(state, input) {
  const remote = activeEnvironment(state);
  if (!remote) return { handled: false };
  const matches =
    input?.phase === "verification"
      ? input?.environmentId === remote.id
      : input?.phase === "load" && normalizeOrigin(input?.origin) === remote.origin;
  if (!matches) return { handled: false };
  return { handled: true, activeId: remote.id };
}

function remoteVerificationFailureCode(input = {}) {
  const status = Number(input.status);
  if (status === 401 || status === 403) return "auth";
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return "unreachable";
  if (Number.isInteger(status) && status > 0) return "blocked";
  const causeCode = String(input.causeCode ?? "").toUpperCase();
  if (causeCode.includes("CERT") || causeCode.includes("TLS") || causeCode.includes("SSL")) return "blocked";
  return "unreachable";
}

const TRANSIENT_LOAD_ERRORS = new Set([-2, -7, -21, -101, -102, -103, -104, -105, -106, -109, -118, -137, -138]);

function remoteLoadFailureIsRetryable(errorCode) {
  return TRANSIENT_LOAD_ERRORS.has(Number(errorCode));
}

/** One owner for remote reconnect timing. The attempt is consumed only when
 * the host is online and a retry is actually dispatched. */
function createRemoteReconnectSupervisor({
  retry,
  isOnline = () => true,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  delays = REMOTE_RETRY_DELAYS_MS,
  stableResetMs = REMOTE_STABLE_RESET_MS,
}) {
  let targetId = null;
  let attempt = 0;
  let generation = 0;
  let retryTimer = null;
  let stableTimer = null;

  const clearRetry = () => {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
  };
  const clearStable = () => {
    if (stableTimer !== null) clearTimer(stableTimer);
    stableTimer = null;
  };
  const arm = (callback, delay) => {
    const timer = setTimer(callback, delay);
    timer?.unref?.();
    return timer;
  };
  const schedule = (id) => {
    if (id !== targetId || retryTimer !== null) return null;
    const token = generation;
    const delay = delays[Math.min(attempt, delays.length - 1)];
    retryTimer = arm(async () => {
      retryTimer = null;
      if (token !== generation || id !== targetId) return;
      if (!isOnline()) {
        schedule(id);
        return;
      }
      attempt += 1;
      await retry(id);
    }, delay);
    return delay;
  };

  return {
    select(id) {
      generation += 1;
      clearRetry();
      clearStable();
      targetId = id;
      attempt = 0;
    },
    failed(id, { retryable }) {
      if (id !== targetId) return { scheduled: false };
      clearStable();
      if (!retryable) {
        clearRetry();
        return { scheduled: false };
      }
      const delay = schedule(id);
      return { scheduled: delay !== null, delay };
    },
    connected(id) {
      if (id !== targetId) return;
      clearRetry();
      if (stableTimer !== null) return;
      const token = generation;
      stableTimer = arm(() => {
        stableTimer = null;
        if (token === generation && id === targetId) attempt = 0;
      }, stableResetMs);
    },
    cancel() {
      generation += 1;
      clearRetry();
      clearStable();
      targetId = null;
      attempt = 0;
    },
    snapshot: () => ({ targetId, attempt, retryPending: retryTimer !== null, stablePending: stableTimer !== null }),
  };
}

/** Origins the main window may navigate to: Local plus every saved server. */
function allowedOrigins(state, localOrigin) {
  return new Set([localOrigin, ...state.environments.map((e) => e.origin)]);
}

module.exports = {
  LOCAL_ID,
  REMOTE_RETRY_DELAYS_MS,
  REMOTE_STABLE_RESET_MS,
  activeEnvironment,
  allowedOrigins,
  createRemoteReconnectSupervisor,
  createEnvironmentSwitchEpoch,
  loadEnvironmentProfile,
  normalizeOrigin,
  normalizeEnvironmentId,
  parseEnvironments,
  parsePairingLink,
  remoteFailurePolicy,
  remoteLoadFailureIsRetryable,
  remoteVerificationFailureCode,
  serializeEnvironments,
  withActive,
  withEnvironment,
  withEnvironmentIdentity,
  withoutEnvironment,
};
