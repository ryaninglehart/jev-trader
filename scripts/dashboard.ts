import { resolve } from "node:path";
import { args } from "./research-args";

const a = args(["report", "port"]);
const port = Number(a.port ?? "4317");
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("port must be 1024..65535");
const root = resolve(import.meta.dir, "../dashboard");
const allowed = new Map([["/", ["index.html", "text/html"]], ["/app.js", ["app.js", "text/javascript"]], ["/styles.css", ["styles.css", "text/css"]]]);
const server = Bun.serve({ hostname: "127.0.0.1", port,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method !== "GET") return new Response("Read-only dashboard", { status: 405 });
    const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" };
    if (url.pathname === "/report.json") {
      if (!a.report) return Response.json({ error: "Choose a comparison report with Import report." }, { status: 404, headers });
      const file = Bun.file(resolve(a.report));
      return await file.exists() ? new Response(file, { headers: { ...headers, "Content-Type": "application/json" } }) : new Response("Report unavailable", { status: 404, headers });
    }
    const asset = allowed.get(url.pathname);
    return asset ? new Response(Bun.file(resolve(root, asset[0]!)), { headers: { ...headers, "Content-Type": asset[1]! } }) : new Response("Not found", { status: 404 });
  },
});
console.log(`EdgeFoundry paper dashboard: ${server.url}`);
