// Mint a pairing code for a remote client, from the machine the server runs on.
//
//   pnpm pair [--label "Milind's MacBook"] [--client] [--public-url https://mini.example]
//   docker compose exec omb node dist-server/pair-cli.js
//
// Talks to the server over loopback (which is trusted as the owner) and prints
// the code, when it expires, and the link to open. Bundled as its own entry so
// the container image, which ships no source, has it too.
const port = Number(process.env.OMB_PORT || 8799);
const args = process.argv.slice(2);
let label: string | undefined;
let publicUrl: string | undefined;
let clientOnly = false;
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--label") label = args[++i];
  else if (arg === "--public-url") publicUrl = args[++i];
  else if (arg === "--client") clientOnly = true;
  else {
    console.error(`unknown argument ${arg}\nusage: pair [--label <name>] [--client] [--public-url <https://host>]`);
    process.exit(2);
  }
}

const base = `http://127.0.0.1:${port}`;
let res: Response;
try {
  res = await fetch(`${base}/api/auth/pairing`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...(label ? { label } : {}), ...(clientOnly ? { scopes: ["client"] } : {}) }),
  });
} catch (error) {
  console.error(`no OpenMausBot server on ${base} (${error instanceof Error ? error.message : String(error)}); is it running, or is OMB_PORT different?`);
  process.exit(1);
}
const body: unknown = await res.json().catch(() => ({}));
const record = Object(body) as Record<string, unknown>; // SAFETY: fields are read with typeof checks below
if (!res.ok) {
  console.error(`server refused: ${typeof record.error === "string" ? record.error : res.status}`);
  process.exit(1);
}
const code = typeof record.code === "string" ? record.code : "";
const expiresAt = typeof record.expiresAt === "number" ? new Date(record.expiresAt) : null;
const url = publicUrl ? `${publicUrl.replace(/\/+$/, "")}/pair#code=${code}` : typeof record.url === "string" ? record.url : null;
console.log(`pairing code:  ${code}${clientOnly ? "   (client scope: cannot change settings or pair others)" : ""}`);
if (expiresAt) console.log(`expires:       ${expiresAt.toLocaleTimeString()} (single use)`);
if (url) console.log(`open:          ${url}`);
else console.log(`open:          /pair on the address you use for this server, and type the code\n               (${typeof record.hint === "string" ? record.hint : "set OMB_PUBLIC_URL for a full link"})`);
