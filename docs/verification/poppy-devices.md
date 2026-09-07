# Poppy device delivery

This component implements device-side transport and navigation against the
frozen Poppy interface v1. It does not create a second outcome, approval, or
pairing authority. The MAU companion owner must supply the authenticated
`/api/poppy/v1/*` and `/api/companion/v1/push` routes and durable outbox before
these clients can be deployed.

## Native capability decision

`vendor-native-checked: 2026-09-07`

Reviewed [Electron notifications](https://www.electronjs.org/docs/latest/tutorial/notifications),
[Apple notification actions](https://developer.apple.com/documentation/usernotifications/handling-notifications-and-notification-related-actions),
and [Gio.Notification](https://docs.gtk.org/gio/class.Notification.html).
Electron's existing `src/lib/notify.ts` and `src/App.tsx` consume live harness
frames inside the running app. They cannot fetch new outcomes after that app
has fully quit. A narrow receiver therefore owns authenticated snapshot
fetching under the host's existing login-service owner. It uses native
UserNotifications on Mac and Gio.Application/GNotification on Framework;
retained notification activation launches the existing desktop protocol.
Gio requires the matching desktop entry and D-Bus activation service, which
must be verified on Framework before rollout. No new pairing, outcome,
approval, or action authority is introduced.

The capability search also covered Electron's notification API source,
including its current `getHistory()` lifecycle, and the retained-notification
failure discussed in [electron/electron#6475](https://github.com/electron/electron/issues/6475).
The [API source](https://github.com/electron/electron/blob/main/docs/api/notification.md)
supports restoring delivered alerts after restart; it does not fetch future
Poppy outcomes while the desktop process is absent. The separate receiver is
an explicit requirement of the approved plan. Its snapshot transport is the
owner-reviewed Poppy interface v1; the optional durable events endpoint is
not a deployed prerequisite. Existing `/api/events` and `ios/README.md`
describe a live stream, which cannot replace fresh current-item reconciliation
after a replay gap. This is a bounded client of the owning snapshot API.

Web searches on 2026-09-07 covered the official Electron repository's quit and
notification issues, GLib notification flushing, and OpenMausBot background
delivery. [Gio's flush contract](https://docs.gtk.org/gio/method.DBusConnection.flush_sync.html)
requires flushing before immediate process exit; the helper follows it.
Context7 resolution was attempted and returned HTTP 400 `invalid session ID
header`; the direct official pages and source supplied the fallback evidence.
The local cluster-scripts/manifests Poppy search found autonomy and connector
owners, but no existing independent desktop receiver to extend. This records
the specific capability search, not an assertion that every vendor page or
issue was exhaustively reviewed.

## Source checks

```sh
pnpm exec vitest run companion/src/apns.test.ts
pnpm exec tsc -p tsconfig.companion.build.json --noEmit
node --test desktop-receiver/*.test.mjs desktop-receiver/macos/*.test.mjs electron/poppy-link.node-test.mjs
node scripts/check-electron.mjs
swift test --package-path ios
```

Full Xcode with its license accepted is required for the iOS application
build. Generate the existing project with `xcodegen generate` in `ios/`.
Build an unsigned simulator target before signing or installing on a phone.
Syntax parsing and CompanionCore compilation do not establish an iOS build.

The APNs tests use generated fixture keys and an injected HTTP/2 connector.
They send no push. One provider instance owns one team/key/topic/environment,
retains its JWT for 40 minutes, reuses its HTTP/2 session, and exposes `close()`
for shutdown. The MAU outbox must retain the captured registration version
and compare it plus Apple's invalidation timestamp before removing a token.
An accepted push never changes item state.

## Native desktop boundary

See `desktop-receiver/README.md` for configuration and service templates.
Service installation belongs to the existing host bootstrap owner. Templates
are not evidence of an installed or enabled receiver.

The receiver polls a complete current snapshot before interrupting, persists
only opaque aliases/cursor/delivery keys, and keeps its identity bound to the
paired device and endpoint. It does not implement approvals or message sends.
Canonical item bodies remain in memory. Pairing credentials stay in an
owner-only local file shared with the native desktop main process.

An OS activation uses only
`openmausbot://poppy?item=<opaque-alias>&revision=<positive-integer>`.
The desktop main process reads the paired credential itself, fetches current
state without redirects, rejects an older revision, and passes the canonical
destination only to the configured MAU UI origin. Remote pages gain no
pairing control or credential-reading IPC. A different selected server,
missing pairing, or unknown item produces a generic unavailable result.
A purged item is silent. The renderer must finish the exact task switch
before selecting that topic and must never fall back to the active task.

The desktop must be packaged with the existing `openmausbot` protocol
registration for native activation tests. Unit tests of the parser and fake
OS adapter do not prove Launch Services or a Linux desktop entry works.

## iPhone boundary

Native APNs lifecycle callbacks register a variable-length token using the
paired bearer. PUT, DELETE, and replacement are serialized. The build's
bundle identifier and development/production setting must match its signed
`aps-environment` entitlement and MAU provider configuration. Verify the
actual signed entitlement before USB installation or TestFlight upload.

Poppy stream frames update app state without a second local alert. Poppy
Live Activities are suppressed. The APNs payload contains generic text and
an opaque item reference; a tap fetches current state before navigating.
Competing taps serialize task switches and discard superseded navigation.

Offline replies remain unsent drafts. They are scoped to pairing and topic,
written atomically with iOS complete file protection, excluded from backup,
and retain their retry identity. Reconnection never sends them. Explicit
online Send is required; approvals use the existing online executor.

## Required deployed acceptance

Run only controlled internal tasks under `docs/verification/README.md`.
Never recover history by sending client communications or replaying approvals.

- Both desktop apps fully quit: one generic alert per actionable revision,
  retained-alert activation after receiver restart, sleep/wake, offline
  catch-up, exact-topic opening, synchronized read/resolution, mute behavior,
  and app/receiver duplicate suppression.
- Paired iPhone: USB then internal TestFlight, locked/background and
  foreground alerts, cellular/Tailscale access, fresh taps and downloads,
  explicit offline-draft send, denied permission, revoked pairing, token
  replacement, provider failure, and upgrade survival.
- Verify current MAU routes, approved paired-device registry, outbox,
  loopback-only companion, private Serve ownership, and deployed revisions.
- Verify Poppy read/dismiss/snooze/resolution propagation through its owning
  hub state implementation. Delivery acknowledgements never stand in for it.
- The server owner must emit all Poppy alerts with the versioned Poppy kind
  and opaque reference, including migrated direct-result paths. Existing
  legacy hub detection uses a mutable display name; it cannot establish
  rename-safe alert privacy or deduplication. Verify renamed-hub delivery
  before rollout; unrelated section chiefs must retain ordinary alerts.
- Record Apple build metadata and establish the day-60 maintenance warning
  through Poppy's durable item owner. No inferred build expiry or local-only
  reminder establishes this requirement.

Until these journeys and the independent exact-source review pass, report
`Verification blocked:` with the owner and missing proof. No source check in
this document establishes deployment, USB installation, TestFlight delivery,
or the completion of the broader cluster plan.

## Review recovery checks (September 7, 2026)

Revision-3 review identified additional source defects. Focused regressions now
cover receiver re-pair/restart with fresh identity-bound state; APNs expired-JWT
invalidation without evicting a concurrent replacement; iOS missing-profile and
unknown-interface notification suppression; and a real local draft-store write
failure with explicit persistence outcomes. A failed save preserves composer
content; sending still checks the exact loaded draft location. An unavailable
draft with newly typed content cannot be replaced by switching topics.

These checks are source evidence only. The native UI journey after a storage
failure, application destruction, signed installation, and real push delivery
remain required acceptance work. The project's reusable operational findings
are recorded in the cluster wiki's `wiki/development/mobile-app-development-and-operations.md`
under obsidian PR182; that reference is not deployment authority.
