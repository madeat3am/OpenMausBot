# Poppy desktop receiver core

The reviewed native-capability decision and deployment prerequisites are in
[`docs/verification/poppy-devices.md`](../docs/verification/poppy-devices.md#native-capability-decision).
The host owner must resolve all template placeholders, including the absolute
Node executable; launchd must not depend on an interactive shell's PATH.

This directory contains the bounded, standard-library receiver for the Mac and
Framework clients. It polls the authenticated Poppy snapshot endpoint from an
explicit loopback or tailnet endpoint and completes every page before emitting
an alert. Every polling cycle starts with a new first-page snapshot; continuation
pages carry the returned snapshot cursor. Ordinary LAN, link-local, `.local`,
public, and caller-allowlisted hosts are refused.

The state file stores a one-way binding to the paired device and endpoint, the
snapshot cursor, and hashed `(alias, revision)` delivery keys. It is atomically
replaced with mode `0600`; bearer tokens, raw aliases, canonical bot/topic/task
IDs, report contents, client names, and notification bodies never enter it.

The implementation is bound to the frozen interface contract
`2f8c8a728cc063cd61387f1243245264e7b5ae9fb6bbba3349fad845cd72cad1`.

`core.mjs` requires an injected native adapter. Its `notify` method receives a
stable identifier, opaque alias/revision for an in-process activation callback,
and only the generic text `Poppy needs your review.`. The
activation callback performs a fresh authenticated request for the opaque item
alias, then calls `openTopic` with the current server item. Missing, purged,
stale, malformed, or unavailable targets never fall back to another task. A
purged `410` target is dropped silently; an unknown `404` target produces only
the generic unavailable signal. The receiver does not send replies, mark items
resolved, or execute proposals.

`linux-adapter.mjs` invokes the narrow `linux/helper.py` Gio helper with native
argv and no shell. The helper uses a stable application-owned notification ID;
the current [Gio documentation](https://docs.gtk.org/gio/method.Application.send_notification.html)
states that this replaces notifications across application executions and that
notification activation can restart the application through D-Bus. This keeps
retained alerts clickable across receiver restarts, which `notify-send --wait`
cannot guarantee because its action result belongs to the waiting process. The
helper uses only generic visible text and a per-pairing opaque alias/revision as
the first-party `openmausbot://poppy` action target. Electron fetches current
state before opening the exact topic.

`run.mjs` loads a separate JSON config and bearer-token file. Both must be
regular, owner-held `0600` files and symlinks are refused. With no `--config`
argument the defaults are:

- macOS: `~/Library/Application Support/OpenMausBot/poppy-receiver.json`
- Linux: `~/.config/openmausbot/poppy-receiver.json`

The config contains paths and non-secret routing data only:

```json
{
  "deviceId": "paired-device-id",
  "endpoint": "https://mau.example.ts.net",
  "uiOrigin": "https://mau.example.ts.net:5173",
  "statePath": "/ABSOLUTE/PRIVATE/PATH/poppy-receiver-state.json",
  "tokenFile": "/ABSOLUTE/PRIVATE/PATH/poppy-receiver.token",
  "helperPath": "/ABSOLUTE/PATH/TO/poppy-notification-helper",
  "linuxHelperPath": "/ABSOLUTE/PATH/TO/OpenMausBot/desktop-receiver/linux/helper.py",
  "pollIntervalMs": 30000,
  "requestTimeoutMs": 15000
}
```

`endpoint` and `uiOrigin` must use the same loopback, Tailscale address, or
MagicDNS hostname; their ports may differ. `helperPath` is required only on
macOS, and `linuxHelperPath` is optional when the helper remains beside the
runner. The bearer appears only in
the referenced token file and authenticated request header.

The templates include a macOS login agent, a Framework user service, and the
Linux desktop/D-Bus registration Gio requires for activation after the helper
has exited. The service templates invoke this directory's `run.mjs`; none are
installed or activated by this source change.

Run the synthetic acceptance tests with:

```sh
node --test desktop-receiver/core.test.mjs desktop-receiver/linux-adapter.test.mjs desktop-receiver/macos/adapter.test.mjs
python3 -m unittest desktop-receiver/linux/helper_test.py
```

The tests cover private-route checks, complete pagination before alerts,
generic privacy, `0600`/no-follow config reads, endpoint/device binding, restart
deduplication, revision delivery, bounded network requests, current-item
activation, Mac helper behavior, and fake Gio/child Linux helper journeys.

Verification blocked: this macOS host has no Linux notification daemon, so the
Framework Gio/PyGObject, D-Bus activation, user-service restart, sleep/wake, and
exact-topic GUI journeys require governed deployment and readback on Framework. No service was
installed and no real notification was emitted by these tests.
