/**
 * The login lockout must key on an address the client cannot choose.
 *
 * Behind a loopback reverse proxy, custom-server.js adopts the forwarded client
 * address as x-9r-real-ip, and loginLimiter buckets failed logins by it. It took
 * X-Real-IP, else the LEFTMOST X-Forwarded-For entry. Both are client-supplied
 * whenever the proxy appends rather than overwrites, which is what Cloudflare
 * (this app's own `cloudflared` tunnel), Caddy, Traefik and the documented nginx
 * `$proxy_add_x_forwarded_for` all do; X-Real-IP is passed through untouched by
 * Cloudflare and Caddy. So a remote client that sent a fresh X-Forwarded-For (or
 * X-Real-IP) on every attempt got a fresh lockout bucket every time: unlimited
 * password guesses against the dashboard.
 *
 * The one entry a single trusted proxy vouches for is the one it appended: the
 * RIGHTMOST. That is what these tests pin, through the real wrapper.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";

import { checkLock, getClientIp, recordFail, recordSuccess } from "../../src/lib/auth/loginLimiter.js";

const require = createRequire(import.meta.url);

let server;
let baseUrl;
let seen;

beforeAll(async () => {
  require("../../custom-server.js"); // wraps http.createServer, stamps the peer token
  server = http.createServer((req, res) => {
    seen = req.headers;
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** What the route sees: send through the wrapper, return the limiter's bucket key. */
async function bucketFor(headers) {
  await fetch(baseUrl, { headers });
  return getClientIp({ headers: new Headers(seen) });
}

const VICTIM_IP = "198.51.100.7"; // what the proxy itself appended: the real peer

describe("a client behind a loopback proxy cannot pick its lockout bucket", () => {
  it("keys on the entry the proxy appended, not the one the client sent", async () => {
    expect(await bucketFor({ "x-forwarded-for": `203.0.113.1, ${VICTIM_IP}` })).toBe(VICTIM_IP);
  });

  it("ignores a client-supplied X-Real-IP when the proxy supplied X-Forwarded-For", async () => {
    expect(await bucketFor({ "x-real-ip": "203.0.113.2", "x-forwarded-for": VICTIM_IP })).toBe(VICTIM_IP);
  });

  it("rotating spoofed entries still hits the lock after five failures", async () => {
    let key;
    for (let i = 0; i < 5; i++) {
      key = await bucketFor({ "x-forwarded-for": `203.0.113.${10 + i}, ${VICTIM_IP}`, "x-real-ip": `192.0.2.${i}` });
      recordFail(key);
    }
    expect(checkLock(key).locked).toBe(true);
    recordSuccess(key); // leave the in-memory limiter clean for other tests
  });

  it("still uses X-Real-IP when the proxy sends only that", async () => {
    expect(await bucketFor({ "x-real-ip": VICTIM_IP })).toBe(VICTIM_IP);
  });

  it("still marks the hop as proxied, so it is never treated as local", async () => {
    await fetch(baseUrl, { headers: { "x-forwarded-for": `127.0.0.1, ${VICTIM_IP}` } });
    expect(seen["x-9r-via-proxy"]).toBe("1");
    expect(seen["x-9r-real-ip"]).toBe(VICTIM_IP);
  });
});
