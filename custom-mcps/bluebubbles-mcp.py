#!/usr/bin/env python3
# discovery-checked: 2026-06-16 — checked existing surfaces before writing.
#   cluster-scripts/messaging/{read,send}-imessage.{sh,py} = canonical local
#   chat.db read + safety-gated send. claude/skills/{read,send}-message wrap them
#   as HIL one-shots. Neither exposes an MCP surface, and neither supports
#   cross-chat keyword search. This MCP adds READ-ONLY cross-chat search +
#   chat-list discovery via the BlueBubbles HTTP API (orthogonal to the chat.db
#   path: works from non-mac harnesses too, given BB_URL via Tailscale). Send-side
#   intentionally OMITTED — lint-no-direct-bluebubbles-curl + safety-gate.py guard
#   the canonical send wrapper as the only outbound path.
"""bluebubbles-mcp.py — BlueBubbles iMessage/SMS read-side MCP stdio wrapper.

Federates the local BlueBubbles server (macbook-air:1234 by default) into
agentgateway Tier 2 so any harness (Claude Code, Codex, opencode, pi) can query
iMessage threads via on-demand MCP calls. READ-ONLY by design — sends route
through cluster-scripts/messaging/send-imessage.{sh,py} (the cluster-canonical
HIL+safety path).

Tools:
  - bluebubbles_recent_chats        list recent chats, newest first
  - bluebubbles_search_messages     keyword search across all messages
  - bluebubbles_get_chat_history    full message history for a chat by guid
  - bb_* aliases                    preserved for existing clients

Env (from ~/.claude/.env via wrapper):
  BB_URL               primary base URL, host-local (http://localhost:1234 on the
                       Mac; http://macbook-air:1234 via Tailscale elsewhere)
  BB_URL_FALLBACKS     optional comma-separated fallback base URLs, tried in order
  BB_URL_DEFAULT_FALLBACK  always-appended durable default (http://macbook-air:1234)
                       so the read path stays green through a single-endpoint outage
                       (stale Caddy upstream, DHCP churn). Doctrine:
                       wiki/development/bluebubbles-endpoint-fallback-doctrine.md
  BB_PASSWORD          BlueBubbles server admin password
  BB_PASS              compatibility alias
  BLUEBUBBLES_PASSWORD compatibility alias

CLI test:
  python3 bluebubbles-mcp.py --chats
  python3 bluebubbles-mcp.py --search "fries"

Stdio MCP server:
  python3 bluebubbles-mcp.py --mcp
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
import urllib.error

BB_URL = (os.environ.get("BB_URL") or os.environ.get("BLUEBUBBLES_SERVER_URL", "")).rstrip("/")
BB_PASSWORD = os.environ.get("BB_PASSWORD") or os.environ.get("BB_PASS") or os.environ.get("BLUEBUBBLES_PASSWORD", "")
TIMEOUT = float(os.environ.get("BB_MCP_TIMEOUT", "15"))

# Durable-connectivity doctrine (wiki/development/bluebubbles-endpoint-fallback-doctrine.md):
# the read path must survive a single-endpoint outage — a stale Caddy upstream
# (pi /bluebubbles pointed at a retired Mac DHCP address), Mac-asleep-on-LAN, or a
# reverse-proxy 5xx. We try BB_URL first, then BB_URL_FALLBACKS (comma-separated),
# then an always-appended default that reaches the BB server directly over Tailscale.
BB_URL_DEFAULT_FALLBACK = os.environ.get("BB_URL_DEFAULT_FALLBACK", "http://macbook-air:1234")
_RETRYABLE_HTTP = frozenset({500, 502, 503, 504})


def _endpoints() -> list:
    """Ordered, de-duplicated BlueBubbles base URLs tried in sequence with failover."""
    raw = [
        os.environ.get("BB_URL") or os.environ.get("BLUEBUBBLES_SERVER_URL", ""),
        *os.environ.get("BB_URL_FALLBACKS", "").split(","),
        BB_URL_DEFAULT_FALLBACK,
    ]
    seen, out = set(), []
    for u in raw:
        u = (u or "").strip().rstrip("/")
        if u and u not in seen:
            seen.add(u)
            out.append(u)
    return out


def _post(path: str, body: dict) -> dict:
    if not BB_PASSWORD:
        raise RuntimeError("BB_PASSWORD not set in environment")
    endpoints = _endpoints()
    if not endpoints:
        raise RuntimeError("no BlueBubbles endpoint configured (set BB_URL)")
    data = json.dumps(body).encode("utf-8")
    last_err: Exception | None = None
    for base in endpoints:
        url = f"{base}{path}?{urllib.parse.urlencode({'password': BB_PASSWORD})}"
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                if base != endpoints[0]:
                    sys.stderr.write(
                        f"bluebubbles-mcp: primary endpoint unavailable; served via fallback {base}\n")
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            # 4xx (auth/not-found) is endpoint-independent — never mask it by failing over.
            if exc.code not in _RETRYABLE_HTTP:
                raise
            last_err = exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_err = exc
    raise RuntimeError(
        f"all {len(endpoints)} BlueBubbles endpoint(s) failed; last error: {last_err}")


def recent_chats(limit: int = 25) -> dict:
    # BlueBubbles /chat/query returns chats in creation order — its "sort":"lastmessage"
    # is not honored server-side, so recently-ACTIVE chats (old chat rows with new
    # messages) never surfaced. Derive them from the newest messages instead, which
    # /message/query DOES sort ("sort":"DESC"), then dedupe by chat keeping the newest.
    msgs = _post("/api/v1/message/query", {
        "limit": max(limit * 8, 120),
        "with": ["chat", "handle"],
        "sort": "DESC",
    })
    seen: dict = {}
    for m in (msgs.get("data") or []):
        for c in (m.get("chats") or []):
            guid = c.get("guid")
            if guid and guid not in seen:
                seen[guid] = {**c, "lastMessage": m}
        if len(seen) >= limit:
            break
    ordered = list(seen.values())[:limit]
    return {
        "status": msgs.get("status", 200),
        "message": "recent chats by last activity (derived from newest messages)",
        "data": ordered,
        "metadata": {"count": len(ordered), "limit": limit},
    }


def search_messages(query: str, limit: int = 30) -> dict:
    return _post("/api/v1/message/query", {"limit": limit, "where": [{"statement": "message.text LIKE :text", "args": {"text": f"%{query}%"}}], "with": ["chat", "handle"]})


def chat_history(chat_guid: str, limit: int = 50) -> dict:
    return _post("/api/v1/message/query", {"limit": limit, "chatGuid": chat_guid, "with": ["chat", "handle", "attachment"], "sort": "DESC"})


CANONICAL_TOOLS = [
    {
        "name": "bluebubbles_recent_chats",
        "description": "List recent BlueBubbles iMessage chats (newest first). Returns chat guid, name, last message timestamp, participants.",
        "inputSchema": {
            "type": "object",
            "properties": {"limit": {"type": "integer", "description": "max chats (default 25)"}},
        },
    },
    {
        "name": "bluebubbles_search_messages",
        "description": "Keyword search across all BlueBubbles message bodies (case-insensitive LIKE). Returns matched messages with chat context. Useful for finding messages about a client/topic across all threads.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "search keyword/phrase"},
                "limit": {"type": "integer", "description": "max results (default 30)"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "bluebubbles_get_chat_history",
        "description": "Get message history for a specific chat by its guid (newest first). Use bluebubbles_recent_chats to find chat guids.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "chat_guid": {"type": "string", "description": "BlueBubbles chat guid"},
                "limit": {"type": "integer", "description": "max messages (default 50)"},
            },
            "required": ["chat_guid"],
        },
    },
]


def _legacy_alias(tool: dict) -> dict:
    alias = dict(tool)
    alias["name"] = alias["name"].replace("bluebubbles_", "bb_", 1)
    alias["description"] = f"Legacy alias for {tool['name']}. " + alias["description"]
    return alias


TOOLS = CANONICAL_TOOLS + [_legacy_alias(tool) for tool in CANONICAL_TOOLS]


def _send(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _stdin_lines_with_idle_timeout(idle_timeout: int):
    """Yield every buffered JSONL frame while preserving the idle reap guard.

    ``TextIOWrapper.readline()`` may read several frames into its user-space
    buffer at once. Selecting on the underlying descriptor again can then
    sleep even though more complete lines are already buffered. Agentgateway
    sends initialize, initialized, and tools/list back-to-back, so that race
    wedged the entire extended lane after the initialize response.
    """
    import os
    import select

    fd = sys.stdin.fileno()
    buffered = b""
    while True:
        ready, _, _ = select.select([fd], [], [], idle_timeout)
        if not ready:
            raise TimeoutError
        chunk = os.read(fd, 65536)
        if not chunk:
            if buffered:
                yield buffered.decode("utf-8", "replace")
            return
        buffered += chunk
        while b"\n" in buffered:
            raw, buffered = buffered.split(b"\n", 1)
            yield raw.decode("utf-8", "replace")


def serve_mcp() -> int:
    # Durable fix (2026-07-06) for the agentgateway stdio-child leak: when the gateway
    # abandons a client connection it keeps the child's stdin pipe open, so `for line in
    # sys.stdin` blocks forever and instances accumulate (12 leaked under gateway PID 586,
    # reaped via restart). Self-reap after an idle window; the gateway respawns on demand.
    idle_timeout = int(os.environ.get("BLUEBUBBLES_MCP_IDLE_TIMEOUT_SEC", "900"))
    lines = _stdin_lines_with_idle_timeout(idle_timeout)
    while True:
        try:
            line = next(lines)
        except StopIteration:
            return 0
        except TimeoutError:
            sys.stderr.write(
                f"bluebubbles-mcp: idle >{idle_timeout}s, self-terminating (gateway stdio-leak guard)\n")
            return 0
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        method, mid = msg.get("method"), msg.get("id")
        if method == "initialize":
            _send({"jsonrpc": "2.0", "id": mid, "result": {
                "protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                "serverInfo": {"name": "bluebubbles", "version": "0.1"}}})
        elif method == "notifications/initialized":
            continue
        elif method == "tools/list":
            _send({"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}})
        elif method == "tools/call":
            params = msg.get("params", {})
            name = params.get("name") if isinstance(params, dict) else None
            args = params.get("arguments", {}) if isinstance(params, dict) else {}
            try:
                if name in {"bluebubbles_recent_chats", "bb_recent_chats"}:
                    res = recent_chats(int(args.get("limit", 25)))
                elif name in {"bluebubbles_search_messages", "bb_search_messages"}:
                    res = search_messages(args["query"], int(args.get("limit", 30)))
                elif name in {"bluebubbles_get_chat_history", "bb_get_chat_history"}:
                    res = chat_history(args["chat_guid"], int(args.get("limit", 50)))
                else:
                    raise ValueError(f"unknown tool: {name}")
                _send({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": json.dumps(res, indent=2)}]}})
            except Exception as exc:  # noqa: BLE001
                _send({"jsonrpc": "2.0", "id": mid, "result": {
                    "content": [{"type": "text", "text": f"{name or 'bluebubbles'} error: {exc}"}], "isError": True}})
        elif mid is not None:
            _send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"method not found: {method}"}})


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--mcp", action="store_true", help="run as stdio MCP server")
    p.add_argument("--chats", action="store_true", help="CLI: list recent chats")
    p.add_argument("--search", metavar="QUERY", help="CLI: search messages")
    p.add_argument("--limit", type=int, default=25)
    args = p.parse_args()
    if args.mcp:
        return serve_mcp()
    if args.chats:
        print(json.dumps(recent_chats(args.limit), indent=2))
        return 0
    if args.search:
        print(json.dumps(search_messages(args.search, args.limit), indent=2))
        return 0
    p.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
