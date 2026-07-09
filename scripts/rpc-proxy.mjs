// Minimal local RPC proxy that injects an Authorization header for tools that can't send one themselves
// (forge/anvil; cast honors ETH_RPC_HEADERS natively, ethers could but this keeps all tools uniform).
//
//   UPSTREAM_RPC_URL=http://<host>/ UPSTREAM_RPC_AUTH="Bearer <token>" node scripts/rpc-proxy.mjs
//   # then point forge/anvil/bot at http://127.0.0.1:8552
//
// Zero dependencies; binds to localhost only so the token never rides an unauthenticated local port
// reachable from outside.
import http from "node:http";
import https from "node:https";

const upstream = new URL(process.env.UPSTREAM_RPC_URL ?? "");
if (!upstream.hostname) {
  console.error("set UPSTREAM_RPC_URL (and usually UPSTREAM_RPC_AUTH)");
  process.exit(1);
}
const auth = process.env.UPSTREAM_RPC_AUTH;
const port = Number(process.env.PORT ?? 8552);
const client = upstream.protocol === "https:" ? https : http;

http
  .createServer((req, res) => {
    const headers = { "content-type": req.headers["content-type"] ?? "application/json" };
    if (auth) headers.authorization = auth;
    const preq = client.request(
      {
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
        path: upstream.pathname + (upstream.search ?? ""),
        method: req.method,
        headers,
      },
      (pres) => {
        res.writeHead(pres.statusCode ?? 502, pres.headers);
        pres.pipe(res);
      },
    );
    preq.on("error", (e) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`upstream error: ${e.message}`);
    });
    req.pipe(preq);
  })
  .listen(port, "127.0.0.1", () => console.log(`rpc-proxy: http://127.0.0.1:${port} -> ${upstream.href}`));
