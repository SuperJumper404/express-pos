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
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw,
        data: raw && (res.headers["content-type"] || "").startsWith("application/json") ? JSON.parse(raw) : null }));
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
      for (const [route, method] of [["deliveries", "GET"], ["availability", "GET"], ["cash-balance", "GET"],
        ["availability", "PATCH"], ["deliveries/41/pickup", "POST"]]) {
        const target = `${prefix}/courier/${route}`;
        const preflight = await request(target, { method: "OPTIONS", headers: {
          Origin: "https://staging.smarteat.fr", "Access-Control-Request-Method": method,
          "Access-Control-Request-Headers": "authorization,content-type",
        } });
        assert.equal(preflight.status, 204, `${method} ${target}: ${preflight.raw}`);
        assert.equal(preflight.raw, "");
        assert.equal(preflight.headers["access-control-allow-origin"], "*");
        assert.equal(preflight.headers["access-control-allow-credentials"], undefined);
        assert.ok(preflight.headers["access-control-allow-methods"].split(/,\s*/).includes(method));
        assert.match(preflight.headers["access-control-allow-headers"], /authorization/i);
        assert.match(preflight.headers["access-control-allow-headers"], /content-type/i);
        const unauthorized = await request(target, { method, headers: { Origin: "https://staging.smarteat.fr" } });
        assert.equal(unauthorized.status, 401, 'Preflight must not bypass actual courier authentication');
        assert.equal(unauthorized.headers["access-control-allow-origin"], "*");
        const stale = await request(target, { method, headers: { Origin: "https://staging.smarteat.fr", Authorization: "Bearer stale" } });
        assert.equal(stale.status, 401);
      }
      const foreign = await request(`${prefix}/customer-auth/challenges`, { method: "POST", headers: { Origin: "https://evil.test" }, body: {} });
      assert.equal(foreign.status, 403); assert.equal(foreign.headers["access-control-allow-origin"], undefined);
      const raw = { fixture: "raw Stripe body" };
      const stripe = await request(`${prefix}/stripe/webhook`, { method: "POST", body: raw });
      assert.equal(stripe.status, 200, stripe.raw);
      assert.equal(stripe.data.raw, true);
      assert.equal(stripe.data.hash, crypto.createHash("sha256").update(JSON.stringify(raw)).digest("hex"));
    });
  });

  async function routingWitness(work, { cors = true } = {}) {
    process.env.JWTKEY = "task10-index-jwt-fixture";
    process.env.PUBLICIMAGEPATH = "http://127.0.0.1/task10-fixture/";
    process.env.CUSTOMER_ALLOWED_ORIGINS = "https://shop.smarteat.test";
    const noDatabase = { query: async () => { throw new Error("Routing witnesses must not access SQL"); } };
    require.cache[require.resolve("../src/config/dbPool")] = { exports: noDatabase };
    require.cache[require.resolve("../src/config/db")] = { exports: noDatabase };
    if (Number(process.versions.node.split(".")[0]) < 22) require.cache[require.resolve("nanoid")] = { exports: await import("nanoid") };
    const { buildAuthentication } = require("../src/helpers/middleware/auth");
    const { buildCustomerSession } = require("../src/helpers/customerSession");
    const { buildCustomerMiddleware } = require("../src/helpers/middleware/customerAuth");
    const origin = "https://shop.smarteat.test";
    const rawToken = "A".repeat(43);
    const session = { id: "81", shopId: 7, customerId: "51", tokenHash: crypto.createHash("sha256").update(rawToken).digest("hex"),
      csrfSecretHash: "b".repeat(64), expiresAt: "2026-11-17T12:00:00Z", subject: "customer" };
    const sessions = buildCustomerSession({ secret: "task10-routing-session-secret-fixture", allowedOrigins: [origin],
      clock: () => new Date("2026-10-18T12:00:00Z"), repository: {
        read: async ({ tokenHash, shopId }) => tokenHash === session.tokenHash && shopId === 7 ? session : null,
      } });
    const guards = [];
    const mutations = [];
    const actualAuth = buildAuthentication({ findUserByIdAndShop: async ({ id, shopId }) =>
      id === 10 && shopId === 7 ? { id: 10, shopid: 7, access: 1, status: 1, module_permissions: '[]' } : null });
    const authentication = (req, res, next) => { guards.push("authentication"); return actualAuth(req, res, next); };
    const actualMiddleware = buildCustomerMiddleware({ sessions });
    const middleware = { ...actualMiddleware,
      attachOptionalCustomerSession: (req, res, next) => { guards.push("attach"); return actualMiddleware.attachOptionalCustomerSession(req, res, next); },
      requireCustomerCsrfIfPresent: (req, res, next) => { guards.push("csrf"); return actualMiddleware.requireCustomerCsrfIfPresent(req, res, next); },
    };
    const witness = name => (req, res) => {
      mutations.push(name);
      res.json({ name, target: req.originalUrl, subject: req.sessionSubject, access: req.access, servicePointId: req.servicePointId,
        customerId: req.customerSession && req.customerSession.customerId, guards: [...guards] });
    };
    const controllers = new Proxy({}, { get: (_target, name) => witness(name) });
    const ordersFile = path.resolve(__dirname, "../src/routers/r_orders.js");
    const orderRequire = createRequire(ordersFile);
    const orderModule = { exports: {} };
    vm.runInNewContext(fs.readFileSync(ordersFile, "utf8"), { module: orderModule, require: name => {
      if (["../controllers/c_orders", "../controllers/c_orderEditing", "../controllers/c_cashClosures"].includes(name)) return controllers;
      if (name === "../helpers/middleware/auth") return { authentication, authorizeCashRegister: (_req, _res, next) => next() };
      if (name === "../helpers/middleware/customerAuth") return middleware;
      return orderRequire(name);
    } }, { filename: ordersFile });
    const { buildCustomersRouter } = require("../src/routers/r_customers");
    const customerRouter = buildCustomersRouter({ controller: controllers, customerAuthController: controllers,
      personalController: controllers, customerMiddleware: middleware, authentication });
    const prefix = require("../src/config/prefix");
    const app = express();
    if (cors) {
      const filename = path.resolve(__dirname, "../index.js");
      const realRequire = createRequire(filename);
      const controlledRequire = name => {
        if (name === "express") return Object.assign(() => app, express);
        if (name === "fs") return { existsSync: () => true };
        if (name === "./src/helpers/waitForDatabase") return { waitForDatabase: () => new Promise(() => {}) };
        if (name === "./src/routers/r_orders") return orderModule.exports;
        if (name === "./src/routers/r_customers") return customerRouter;
        if (name === "./src/helpers/middleware/customerAuth") return middleware;
        if (name === "./src/helpers/middleware/auth") return { authenticationIfPresent: (req, res, next) => req.headers.authorization ? actualAuth(req, res, next) : next() };
        return realRequire(name);
      };
      vm.runInNewContext(fs.readFileSync(filename, "utf8"), { require: controlledRequire, console: { log() {}, error() {} }, process, setInterval }, { filename });
    } else {
      // Isolate the route guard from CORS so I1 cannot mask an I2 regression.
      app.use(prefix, orderModule.exports);
    }
    const jwt = require("jsonwebtoken");
    const bearer = jwt.sign({ id: 10, shopid: 7, access: 1 }, process.env.JWTKEY);
    const servicePointBearer = jwt.sign({ subject_type: "service_point", service_point_id: 9, shopid: 7, access: 2 }, process.env.JWTKEY);
    await withHttp(app, request => work({ request, prefix, origin, mutations, guards,
      headers: { Origin: origin, Cookie: `smarteat_customer=${rawToken}`, Authorization: `Bearer ${bearer}` },
      servicePointBearer, csrfToken: sessions.csrfToken(session) }));
  }

  const spellings = (prefix, route) => [
    `${prefix}/${route}`, `${prefix}//${route}`, `http://api.example.test${prefix}/${route}`,
    `http://api.example.test${prefix}//${route}`, `${prefix.toUpperCase()}//${route.toUpperCase()}/?routing=1`,
  ];

  test("I1 actual index enforces public customer origin policy for every accepted request target", async t => {
    await routingWitness(async ({ request, prefix, origin, mutations }) => {
      for (const route of ["customer-auth/challenges", "customer-auth/verify"]) {
        for (const target of spellings(prefix, route)) {
          await t.test(`forbidden POST ${target}`, async () => {
            const before = mutations.length;
            const result = await request(target, { method: "POST", headers: { Origin: "https://evil.test" } });
            assert.equal(result.status, 403, result.raw);
            assert.equal(result.headers["access-control-allow-origin"], undefined);
            assert.equal(result.headers["access-control-allow-credentials"], undefined);
            assert.equal(mutations.length, before);
          });
          await t.test(`allowed POST ${target}`, async () => {
            const result = await request(target, { method: "POST", headers: { Origin: origin } });
            assert.equal(result.status, 200, result.raw);
            assert.equal(result.data.target, target);
            assert.equal(result.headers["access-control-allow-origin"], origin);
            assert.equal(result.headers["access-control-allow-credentials"], "true");
          });
          await t.test(`preflight ${target}`, async () => {
            const before = mutations.length;
            for (const Origin of [origin, "https://evil.test"]) {
              const result = await request(target, { method: "OPTIONS", headers: { Origin,
                "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
              assert.equal(result.status, Origin === origin ? 204 : 403, result.raw);
            }
            assert.equal(mutations.length, before);
          });
        }
      }
    });
  });

  test("I2 actual checkout route authenticates then attaches customer and checks CSRF independently of index", async t => {
    await routingWitness(async ({ request, prefix, headers, csrfToken, mutations, guards, servicePointBearer }) => {
      for (const target of spellings(prefix, "orders/checkout")) {
        for (const Authorization of [headers.Authorization, `Bearer ${servicePointBearer}`]) {
          await t.test(`missing CSRF ${target} ${Authorization === headers.Authorization ? "staff" : "service-point"}`, async () => {
            guards.length = 0;
            const before = mutations.length;
            const result = await request(target, { method: "POST", headers: { ...headers, Authorization } });
            assert.equal(result.status, 403, result.raw);
            assert.deepEqual(guards, ["authentication", "attach", "csrf"]);
            assert.equal(mutations.length, before);
          });
          await t.test(`valid CSRF ${target} ${Authorization === headers.Authorization ? "staff" : "service-point"}`, async () => {
            guards.length = 0;
            const result = await request(target, { method: "POST", headers: { ...headers, Authorization, "X-CSRF-Token": csrfToken } });
            assert.equal(result.status, 200, result.raw);
            assert.equal(result.data.customerId, "51");
            assert.equal(result.data.target, target);
            assert.equal(result.data.subject, Authorization === headers.Authorization ? "staff" : "service_point");
            assert.deepEqual(result.data.guards, ["authentication", "attach", "csrf"]);
          });
          await t.test(`bearer without customer cookie ${target} ${Authorization === headers.Authorization ? "staff" : "service-point"}`, async () => {
            const result = await request(target, { method: "POST", headers: { Authorization } });
            assert.equal(result.status, 200, result.raw);
            assert.equal(result.data.customerId, null);
          });
        }
        await t.test(`cookie without existing bearer ${target}`, async () => {
          const before = mutations.length;
          const result = await request(target, { method: "POST", headers: { Cookie: headers.Cookie, "X-CSRF-Token": csrfToken } });
          assert.equal(result.status, 401, result.raw);
          assert.equal(mutations.length, before);
        });
      }
    }, { cors: false });
  });

  test("I1/I2 actual index scopes checkout CORS and preflight without letting accepted spellings skip CSRF", async t => {
    await routingWitness(async ({ request, prefix, headers, csrfToken, mutations, guards, origin }) => {
      for (const target of spellings(prefix, "orders/checkout")) {
        await t.test(target, async () => {
          let before = mutations.length;
          const forbidden = await request(target, { method: "POST", headers: { ...headers, Origin: "https://evil.test", "X-CSRF-Token": csrfToken } });
          assert.equal(forbidden.status, 403, forbidden.raw);
          assert.equal(forbidden.headers["access-control-allow-origin"], undefined);
          assert.equal(forbidden.headers["access-control-allow-credentials"], undefined);
          assert.equal(mutations.length, before);
          const missing = await request(target, { method: "POST", headers });
          assert.equal(missing.status, 403, missing.raw);
          assert.equal(mutations.length, before);
          assert.equal(missing.headers["access-control-allow-origin"], origin);
          guards.length = 0;
          for (const Origin of [origin, "https://evil.test"]) {
            const preflight = await request(target, { method: "OPTIONS", headers: { Origin,
              "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,authorization,x-csrf-token" } });
            assert.equal(preflight.status, Origin === origin ? 204 : 403, preflight.raw);
          }
          assert.equal(guards.length, 0);
          assert.equal(mutations.length, before);
          const accepted = await request(target, { method: "POST", headers: { ...headers, "X-CSRF-Token": csrfToken } });
          assert.equal(accepted.status, 200, accepted.raw);
          assert.equal(accepted.data.customerId, "51");
          assert.equal(accepted.data.access, 1);
          assert.equal(accepted.headers["access-control-allow-origin"], origin);
          const legacy = await request(target, { method: "POST", headers: { Authorization: headers.Authorization, Origin: "https://legacy.test" } });
          assert.equal(legacy.status, 200, legacy.raw);
          assert.equal(legacy.data.customerId, null);
          assert.equal(legacy.headers["access-control-allow-origin"], "*");
          assert.equal(legacy.headers["access-control-allow-credentials"], undefined);
        });
      }
      for (const target of [`${prefix}///orders/checkout`, `${prefix}/orders//checkout`, `${prefix}/orders/checkout//`, `${prefix}/%6frders/checkout`]) {
        const before = mutations.length;
        const rejected = await request(target, { method: "POST", headers });
        assert.equal(rejected.status, 404, rejected.raw);
        assert.equal(mutations.length, before);
      }
      guards.length = 0;
      const legacyRead = await request(`${prefix}/orders`, { headers });
      assert.equal(legacyRead.status, 200, legacyRead.raw);
      assert.deepEqual(guards, ["authentication"]);
    });
  });
}

module.exports = { withHttp };
