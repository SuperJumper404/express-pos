const assert = require("assert/strict");
const { test } = require("node:test");
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const crypto = require("crypto");
const { createRequire } = require("module");
process.env.ENV_FILE = path.join(__dirname, "task10-nonexistent.env");

async function withHttp(app, work) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const request = (route, { method = "GET", headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: server.address().port, path: route, method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers } }, res => {
      let raw = "";
      res.on("data", chunk => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw, data: raw ? JSON.parse(raw) : null }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try { return await work(request); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

if (require.main === module) {
  test("scoped CORS precedes legacy wildcard and preflight never mutates", async () => {
    const { buildCustomerCors, isCustomerCorsRequest } = require("../src/helpers/customerCors");
    const app = express();
    let mutations = 0;
    app.use(buildCustomerCors({ prefix: "/api", allowedOrigins: ["https://shop.smarteat.test", "http://localhost:3000"] }));
    app.use((req, res, next) => { if (!isCustomerCorsRequest(req, "/api")) res.set("Access-Control-Allow-Origin", "*"); next(); });
    app.all("*", (req, res) => { if (req.method === "POST") mutations++; res.json({ ip: req.ip, secure: req.secure }); });
    await withHttp(app, async request => {
      const allowed = await request("/api/customer/addresses", { headers: { Origin: "https://shop.smarteat.test" } });
      assert.equal(allowed.headers["access-control-allow-origin"], "https://shop.smarteat.test");
      assert.equal(allowed.headers["access-control-allow-credentials"], "true");
      assert.match(allowed.headers.vary, /Origin/);
      for (const origin of ["https://evil.test", "null", "https://shop.smarteat.test.evil.test"]) {
        const denied = await request("/api/customer/addresses", { method: "POST", headers: { Origin: origin } });
        assert.equal(denied.status, 403);
        assert.equal(denied.headers["access-control-allow-credentials"], undefined);
        assert.equal(denied.headers["access-control-allow-origin"], undefined);
      }
      assert.equal((await request("/api/customer-auth/verify", { method: "POST" })).status, 403);
      const preflight = await request("/api/customer/addresses", { method: "OPTIONS", headers: {
        Origin: "https://shop.smarteat.test", "Access-Control-Request-Method": "PATCH", "Access-Control-Request-Headers": "content-type,x-csrf-token" } });
      assert.equal(preflight.status, 204);
      assert.match(preflight.headers["access-control-allow-headers"], /X-CSRF-Token/i);
      assert.equal(mutations, 0);
      assert.equal((await request("/api/customer/addresses", { method: "OPTIONS", headers: { Origin: "https://shop.smarteat.test", "Access-Control-Request-Method": "TRACE" } })).status, 403);
      const checkout = await request("/api/orders/checkout", { method: "POST", headers: { Cookie: "smarteat_customer=opaque", Origin: "https://evil.test" } });
      assert.equal(checkout.status, 403);
      const legacy = await request("/api/orders/checkout", { method: "POST", headers: { Origin: "https://legacy.test", Authorization: "Bearer legacy" } });
      assert.equal(legacy.status, 200);
      assert.equal(legacy.headers["access-control-allow-origin"], "*");
      assert.equal(legacy.headers["access-control-allow-credentials"], undefined);
      assert.equal((await request("/api/customer-auth/channels")).status, 200);
    });
  });

  test("proxy allowlist alone determines actual Express IP and HTTPS", async () => {
    const { configureCustomerTrustProxy } = require("../src/helpers/customerCors");
    for (const trustedProxies of [[], ["192.0.2.0/24"], ["127.0.0.1/32"]]) {
      const app = express();
      configureCustomerTrustProxy(app, trustedProxies);
      app.get("/", (req, res) => res.json({ ip: req.ip, secure: req.secure }));
      await withHttp(app, async request => {
        const result = await request("/", { headers: { "X-Forwarded-For": "198.51.100.42", "X-Forwarded-Proto": "https" } });
        assert.equal(result.data.ip, trustedProxies[0] === "127.0.0.1/32" ? "198.51.100.42" : "127.0.0.1");
        assert.equal(result.data.secure, trustedProxies[0] === "127.0.0.1/32");
      });
    }
    const app = express();
    configureCustomerTrustProxy(app, ["*", "true"]);
    await withHttp(app.get("/", (req, res) => res.json({ ip: req.ip })), async request => {
      assert.equal((await request("/", { headers: { "X-Forwarded-For": "198.51.100.42" } })).data.ip, "127.0.0.1");
    });
  });

  test("actual index mounts personal API before stale staff guard, keeps exact CORS and raw Stripe bytes", async () => {
    process.env.JWTKEY = "task10-index-jwt-fixture";
    process.env.PUBLICIMAGEPATH = "http://127.0.0.1/task10-fixture/";
    process.env.CUSTOMER_ALLOWED_ORIGINS = "https://shop.smarteat.test";
    delete process.env.CUSTOMER_AUTH_SECRET;
    delete process.env.CUSTOMER_TRUSTED_PROXIES;
    const noDatabase = { query: async () => { throw new Error("Index test must not access SQL"); } };
    require.cache[require.resolve("../src/config/dbPool")] = { exports: noDatabase };
    require.cache[require.resolve("../src/config/db")] = { exports: noDatabase };
    if (Number(process.versions.node.split(".")[0]) < 22) require.cache[require.resolve("nanoid")] = { exports: await import("nanoid") };
    const filename = path.resolve(__dirname, "../index.js");
    const realRequire = createRequire(filename);
    const app = express();
    const expressFactory = Object.assign(() => app, express);
    const rawBoundary = express.Router().post("/", (req, res) => res.json({ raw: Buffer.isBuffer(req.body), hash: crypto.createHash("sha256").update(req.body).digest("hex") }));
    const controlledRequire = name => {
      if (name === "express") return expressFactory;
      if (name === "fs") return { existsSync: () => true, mkdirSync: () => { throw new Error("No image filesystem mutation"); } };
      // Leave startup pending without a timer/socket; only the actual middleware stack is exercised.
      if (name === "./src/helpers/waitForDatabase") return { waitForDatabase: () => new Promise(() => {}) };
      if (name === "./src/routers/r_stripe") return { ...realRequire(name), webhookRouter: rawBoundary };
      return realRequire(name);
    };
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), { require: controlledRequire, console: { log() {}, error() {} }, process, setInterval }, { filename });
    const prefix = require("../src/config/prefix");
    await withHttp(app, async request => {
      const channels = await request(`${prefix}/customer-auth/channels`, { headers: { Origin: "https://shop.smarteat.test", Authorization: "Bearer stale" } });
      assert.equal(channels.status, 200, channels.raw);
      assert.deepEqual(channels.data.data, { email: false, whatsapp: false });
      assert.equal(channels.headers["access-control-allow-origin"], "https://shop.smarteat.test");
      assert.equal(channels.headers["access-control-allow-credentials"], "true");
      const own = await request(`${prefix}/customer-auth/session?shopId=7`, { headers: { Authorization: "Bearer stale" } });
      assert.equal(own.status, 401);
      assert.equal(own.data.error, "CUSTOMER_SESSION_INVALID");
      const legacy = await request(`${prefix}/orders`, { headers: { Cookie: "smarteat_customer=opaque" } });
      assert.equal(legacy.status, 401); assert.equal(legacy.headers["access-control-allow-origin"], "*");
      assert.equal(legacy.headers["access-control-allow-credentials"], undefined);
      const foreign = await request(`${prefix}/customer-auth/challenges`, { method: "POST", headers: { Origin: "https://evil.test" }, body: {} });
      assert.equal(foreign.status, 403); assert.equal(foreign.headers["access-control-allow-origin"], undefined);
      const raw = { fixture: "raw Stripe body" };
      const stripe = await request(`${prefix}/stripe/webhook`, { method: "POST", body: raw });
      assert.equal(stripe.status, 200, stripe.raw);
      assert.equal(stripe.data.raw, true);
      assert.equal(stripe.data.hash, crypto.createHash("sha256").update(JSON.stringify(raw)).digest("hex"));
    });
  });
}

module.exports = { withHttp };
