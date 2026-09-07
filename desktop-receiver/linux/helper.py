#!/usr/bin/python3
"""Submit generic Poppy notifications through Gio with crash-stable actions."""

from __future__ import annotations

import json
import re
import sys
from urllib.parse import parse_qs, urlencode, urlparse

APPLICATION_ID = "com.openmausbot.PoppyReceiver"
GENERIC_TEXT = "Poppy needs your review."
ID_RE = re.compile(r"^poppy-[a-f0-9]{32}$")
ALIAS_RE = re.compile(r"^[A-Za-z0-9_-]{1,256}$")


def parse_request(raw: bytes) -> dict[str, object]:
    if not raw or len(raw) > 2048 or b"\n" in raw.rstrip(b"\n"):
        raise ValueError("INVALID_REQUEST")
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("INVALID_REQUEST") from error
    if not isinstance(value, dict) or set(value) != {"identifier", "itemAlias", "revision", "title", "body"}:
        raise ValueError("INVALID_REQUEST")
    if not isinstance(value["identifier"], str) or not ID_RE.fullmatch(value["identifier"]):
        raise ValueError("INVALID_REQUEST")
    if not isinstance(value["itemAlias"], str) or not ALIAS_RE.fullmatch(value["itemAlias"]):
        raise ValueError("INVALID_REQUEST")
    if type(value["revision"]) is not int or value["revision"] < 1 or value["revision"] > 9_007_199_254_740_991:
        raise ValueError("INVALID_REQUEST")
    if value["title"] != GENERIC_TEXT or value["body"] != GENERIC_TEXT:
        raise ValueError("INVALID_REQUEST")
    return value


def poppy_uri(item_alias: str, revision: int) -> str:
    if not ALIAS_RE.fullmatch(item_alias) or type(revision) is not int or revision < 1:
        raise ValueError("INVALID_TARGET")
    return "openmausbot://poppy?" + urlencode({"item": item_alias, "revision": str(revision)})


def validate_poppy_uri(uri: str) -> str:
    parsed = urlparse(uri)
    query = parse_qs(parsed.query, strict_parsing=True)
    if parsed.scheme != "openmausbot" or parsed.netloc != "poppy" or parsed.path or parsed.params or parsed.fragment:
        raise ValueError("INVALID_TARGET")
    if set(query) != {"item", "revision"} or len(query["item"]) != 1 or len(query["revision"]) != 1:
        raise ValueError("INVALID_TARGET")
    try:
        revision = int(query["revision"][0])
    except ValueError as error:
        raise ValueError("INVALID_TARGET") from error
    return poppy_uri(query["item"][0], revision)


def build_application(Gio, GLib):
    application = Gio.Application(application_id=APPLICATION_ID)
    action = Gio.SimpleAction.new("open", GLib.VariantType.new("s"))

    def open_target(_action, parameter):
        try:
            uri = validate_poppy_uri(parameter.get_string())
            Gio.AppInfo.launch_default_for_uri(uri, None)
        except Exception:
            return

    action.connect("activate", open_target)
    application.add_action(action)
    return application


def submit(request: dict[str, object], Gio, GLib) -> None:
    application = build_application(Gio, GLib)
    if not application.register(None):
        raise RuntimeError("APPLICATION_REGISTRATION_FAILED")
    notification = Gio.Notification.new(GENERIC_TEXT)
    notification.set_body(GENERIC_TEXT)
    notification.set_default_action_and_target_value(
        "app.open",
        GLib.Variant("s", poppy_uri(request["itemAlias"], request["revision"])),
    )
    application.send_notification(request["identifier"], notification)
    # This short-lived sender must flush the queued D-Bus call before exit.
    # Failure leaves the receiver's delivery key uncommitted and retryable.
    connection = application.get_dbus_connection()
    if connection is None or not connection.flush_sync(None):
        raise RuntimeError("NOTIFICATION_FLUSH_FAILED")


def gio_modules():
    import gi

    gi.require_version("Gio", "2.0")
    from gi.repository import Gio, GLib

    return Gio, GLib


def main(argv: list[str]) -> int:
    try:
        Gio, GLib = gio_modules()
        if argv[1:] == ["--gapplication-service"]:
            return build_application(Gio, GLib).run(argv)
        if argv[1:]:
            raise ValueError("INVALID_ARGUMENTS")
        raw = sys.stdin.buffer.readline(2049)
        request = parse_request(raw)
        submit(request, Gio, GLib)
        sys.stdout.write(json.dumps({"kind": "submitted", "identifier": request["identifier"]}) + "\n")
        sys.stdout.flush()
        return 0
    except Exception:
        sys.stdout.write('{"kind":"failed"}\n')
        sys.stdout.flush()
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
