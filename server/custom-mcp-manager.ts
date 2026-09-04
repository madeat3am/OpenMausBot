import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import { augmentedPath } from "./env-path.ts";
import { createLineSplitter } from "./mcp-bridge.ts";
import { killCliTree, spawnCli } from "./procs.ts";
import type { CustomMcpServer } from "./config.ts";

type JsonRpc = Record<string, unknown>;

const MAX_STDOUT_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

type Pending = {
  resolve: (frame: JsonRpc) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Session = {
  id: string;
  serverName: string;
  child: ReturnType<typeof spawnCli>;
  pending: Map<string, Pending>;
  stdoutBytes: number;
  closed: boolean;
};

function publicError(message: string): Error {
  return new Error(`custom MCP unavailable: ${message}`);
}

export function customMcpChildCommand(server: CustomMcpServer): { command: string; args: string[] } {
  if (process.env.OMB_MCP_CHILD_BWRAP !== "1") return { command: server.command, args: server.args };
  const hidden = new Set<string>();
  for (const name of ["OMB_MCP_SECRETS_FILE", "OMB_AUTONOMY_POLICY_PATH", "OMB_AUTONOMY_SIGNING_KEY_FILE", "OMB_CONNECTOR_CONFIG_FILE", "OMB_EXACT_NONCE_FILE"]) {
    const value = process.env[name]?.trim();
    if (value?.startsWith("/")) hidden.add(dirname(value));
  }
  return {
    command: "/usr/bin/bwrap",
    args: [
      "--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-uts", "--unshare-ipc",
      "--uid", "0", "--gid", "0", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      ...[...hidden].sort().flatMap((path) => ["--tmpfs", path]),
      "--", server.command, ...server.args,
    ],
  };
}

/** The MCP child gets a deliberately small ambient environment plus only its
 * own secret subtree. In particular it never inherits OpenMausBot provider,
 * policy, connector, or sibling-MCP credentials from the server process. */
export function customMcpChildEnvironment(secretEnv: Record<string, string>): NodeJS.ProcessEnv {
  const inherited = ["HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SHELL"] as const;
  const env: NodeJS.ProcessEnv = { PATH: augmentedPath() };
  for (const key of inherited) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  Object.assign(env, secretEnv);
  return env;
}

function requestKey(id: unknown): string | null {
  return typeof id === "string" || typeof id === "number" ? `${typeof id}:${String(id)}` : null;
}

export class CustomMcpManager {
  private readonly sessions = new Map<string, Session>();

  private open(serverName: string, server: CustomMcpServer, requestedId?: string): Session {
    const id = requestedId?.trim() || randomUUID();
    const existing = this.sessions.get(id);
    if (existing) {
      if (existing.serverName !== serverName) throw publicError("session belongs to another server");
      return existing;
    }
    const childCommand = customMcpChildCommand(server);
    const child = spawnCli(childCommand.command, childCommand.args, {
      cwd: process.cwd(),
      env: customMcpChildEnvironment(server.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const session: Session = { id, serverName, child, pending: new Map(), stdoutBytes: 0, closed: false };
    this.sessions.set(id, session);
    const fail = (reason: string) => this.close(id, publicError(reason));
    const splitter = createLineSplitter((line) => {
      session.stdoutBytes += Buffer.byteLength(line);
      if (session.stdoutBytes > MAX_STDOUT_BYTES) {
        fail("response exceeded 20 MB");
        return;
      }
      let frame: JsonRpc;
      try {
        frame = JSON.parse(line) as JsonRpc;
      } catch {
        return;
      }
      const key = requestKey(frame.id);
      if (!key) return;
      const pending = session.pending.get(key);
      if (!pending) return;
      session.pending.delete(key);
      clearTimeout(pending.timer);
      session.stdoutBytes = 0;
      pending.resolve(frame);
    });
    child.stdout.on("data", (chunk: Buffer) => splitter.push(chunk));
    child.stderr.resume();
    child.once("error", () => fail("could not start configured command"));
    child.once("close", () => fail("configured command stopped"));
    return session;
  }

  async relay(
    serverName: string,
    server: CustomMcpServer,
    message: JsonRpc,
    requestedId?: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<{ sessionId: string; response: JsonRpc | null }> {
    const session = this.open(serverName, server, requestedId);
    if (session.closed) throw publicError("session is closed");
    const key = requestKey(message.id);
    if (!key) {
      session.child.stdin.write(`${JSON.stringify(message)}\n`);
      return { sessionId: session.id, response: null };
    }
    if (session.pending.has(key)) throw publicError("duplicate request id");
    const response = new Promise<JsonRpc>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(key);
        reject(publicError("request timed out"));
      }, timeoutMs);
      timer.unref?.();
      session.pending.set(key, { resolve, reject, timer });
    });
    try {
      session.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      this.close(session.id, publicError("configured command stopped"));
    }
    return { sessionId: session.id, response: await response };
  }

  close(id: string, error = publicError("session closed")): boolean {
    const session = this.sessions.get(id);
    if (!session || session.closed) return false;
    session.closed = true;
    this.sessions.delete(id);
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    session.pending.clear();
    killCliTree(session.child);
    return true;
  }

  closeServer(serverName: string): void {
    for (const [id, session] of this.sessions) {
      if (session.serverName === serverName) this.close(id);
    }
  }

  dispose(): void {
    for (const id of this.sessions.keys()) this.close(id);
  }
}
