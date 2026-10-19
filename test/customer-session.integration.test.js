const assert = require("assert/strict");
const { test } = require("node:test");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const http = require("http");
const https = require("https");
const mysql = require("mysql2/promise");
const { withDeliveryDatabase } = require("./helpers/deliveryDatabase");
const { withProviderHttp, config } = require("./customer-code-transports.test");
const { withHttp } = require("./customer-cors.test");
process.env.JWTKEY = config().jwtSecret;
const origin = "https://shop.smarteat.test";
const browserBinding = "task10-browser-binding-32-byte-fixture";
const code = "123456";

test("personal sessions, actual SQL and HTTP with provider boundary doubles", async t => {
  const { buildCustomerSession, buildSqlCustomerSessionRepository } = require("../src/helpers/customerSession");
  const { buildCustomerMiddleware } = require("../src/helpers/middleware/customerAuth");
  const { buildCustomerCors, configureCustomerTrustProxy, isCustomerCorsRequest } = require("../src/helpers/customerCors");
  await withDeliveryDatabase(async db => {
    await db.seedScenario();
    process.env.ENV_FILE = path.join(__dirname, "task10-nonexistent.env");
    process.env.JWTKEY = config().jwtSecret;
    require.cache[require.resolve("../src/config/dbPool")] = { exports: db.pool };
    require.cache[require.resolve("../src/config/db")] = { exports: db.pool.pool };
    if (Number(process.versions.node.split(".")[0]) < 22) require.cache[require.resolve("nanoid")] = { exports: await import("nanoid") };
    const { buildCustomerAuth, buildSqlCustomerAuthRepository } = require("../src/modules/m_customerAuth");
    const { buildCustomerCodeTransports } = require("../src/services/customerCodeTransports");
    const { buildCustomers, buildSqlCustomersRepository } = require("../src/modules/m_customers");
    const { createTransactionRunner } = require("../src/helpers/withTransaction");
    const { buildCustomerAuthController, buildPersonalCustomersController } = require("../src/controllers/c_customers");
    const { buildCustomersRouter } = require("../src/routers/r_customers");
    const { authentication, authenticationIfPresent } = require("../src/helpers/middleware/auth");
    const { buildDeliveryTokenCodec, signAddressResolution, validateAddressResolution } = require("../src/helpers/deliveryAddress");
    const codec = buildDeliveryTokenCodec({ secret: "task10-delivery-token-secret-32-bytes-fixture" });
    let now = new Date("2026-10-18T12:00:00Z");
    const clock = () => now;
    const advance = seconds => { now = new Date(now.getTime() + seconds * 1000); };
    const repository = buildSqlCustomerSessionRepository({ pool: db.pool });
    const sessions = buildCustomerSession({ repository, clock, secret: config().secret, allowedOrigins: [origin] });
    const middleware = buildCustomerMiddleware({ sessions });
    const customers = buildCustomers({ repository: buildSqlCustomersRepository({ pool: db.pool }), runInTransaction: createTransactionRunner(db.pool), clock, tokenCodec: codec });
    await withProviderHttp(async boundary => {
      const accepted = (_req, res) => res.end(JSON.stringify({ Messages: [{ Status: "success", To: [{ MessageUUID: "fixture-id" }] }] }));
      boundary.setResponse(accepted);
      const transports = buildCustomerCodeTransports({ getConfig: config });
      const auth = buildCustomerAuth({ repository: buildSqlCustomerAuthRepository({ pool: db.pool }), transports, clock, randomCode: () => code, secret: config().secret });
      const quotes = require("../src/modules/m_deliveryQuotes").buildDeliveryQuotes({ clock, tokenCodec: codec });
      const app = express();
      configureCustomerTrustProxy(app, ["127.0.0.1/32"]);
      app.use(buildCustomerCors({ prefix: "/api", allowedOrigins: [origin] }));
      app.use((req, res, next) => { if (!isCustomerCorsRequest(req, "/api")) res.set("Access-Control-Allow-Origin", "*"); next(); });
      app.use(express.json());
      app.use("/api", buildCustomersRouter({ customerAuthController: buildCustomerAuthController({ customerAuth: auth, transports, sessions }),
        personalController: buildPersonalCustomersController({ customers, quotes }), customerMiddleware: middleware }));
      app.use("/api", authenticationIfPresent);
      app.get("/api/staff", authentication, middleware.attachOptionalCustomerSession, (req, res) => res.json({ id: req.id, access: req.access, shopid: req.shopid, sessionSubject: req.sessionSubject, customerSession: req.customerSession }));
      app.post("/api/orders/checkout", authentication, middleware.attachOptionalCustomerSession, middleware.requireCustomerCsrfIfPresent, (req, res) => res.json({ access: req.access, customerSession: req.customerSession || null }));
      let serial = 0;
      await withHttp(app, async request => {
        const challenge = async (extra = {}) => {
          const result = await request("/api/customer-auth/challenges", { method: "POST", headers: { Origin: origin }, body: {
            shopId: 7, channel: "email", destination: `task10-${++serial}@example.test`, browserBinding, ...extra } });
          assert.equal(result.status, 200, result.raw);
          assert.deepEqual(Object.keys(result.data.data).sort(), ["challengeId", "expiresAt", "resendAfter", "status"]);
          return result.data.data;
        };
        const verify = (a, extra = {}, headers = {}) => request("/api/customer-auth/verify", { method: "POST", headers: { Origin: origin, ...headers }, body: { shopId: 7, challengeId: a.challengeId, code, browserBinding, ...extra } });
        const login = async () => {
          advance(7200);
          const result = await verify(await challenge());
          assert.equal(result.status, 200, result.raw);
          return { result, Cookie: result.headers["set-cookie"][0].split(";")[0], csrf: result.data.data.csrfToken, customerId: result.data.data.customerId };
        };
        const h = (who, extra = {}) => ({ Origin: origin, Cookie: who.Cookie, "X-CSRF-Token": who.csrf, ...extra });
        let alice;
        await t.test("login produces opaque host-only cookie, hash-only storage, safe session DTO and exact 30-day expiry", async () => {
          alice = await login();
          const set = alice.result.headers["set-cookie"][0];
          assert.match(set, /^smarteat_customer=[A-Za-z0-9_-]{43};/);
          assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Lax/); assert.match(set, /Path=\//);
          assert.match(set, /Max-Age=2592000/); assert.doesNotMatch(set, /Domain=|Secure/);
          const rawToken = alice.Cookie.split("=")[1];
          assert.equal(Buffer.from(rawToken, "base64url").length, 32);
          const [stored] = await db.readRows("SELECT *,DATE_FORMAT(expires_at,'%Y-%m-%dT%H:%i:%sZ') AS expiry FROM customer_sessions WHERE customer_id=?", [alice.customerId]);
          assert.equal(stored.token_hash, crypto.createHash("sha256").update(rawToken).digest("hex"));
          assert.match(stored.csrf_secret_hash, /^[a-f0-9]{64}$/);
          assert.doesNotMatch(JSON.stringify(stored), new RegExp(rawToken));
          assert.equal(stored.expiry, new Date(now.getTime() + 2592000000).toISOString().replace(".000", ""));
          assert.deepEqual(Object.keys(alice.result.data.data).sort(), ["csrfToken", "customerId", "expiresAt", "shopId", "subject"]);
          assert.equal(alice.result.data.data.subject, "customer");
          const read = await request("/api/customer-auth/session?shopId=7", { headers: h(alice) });
          assert.deepEqual(read.data.data, alice.result.data.data);
          assert.equal(read.headers["cache-control"], "no-store");
          assert.equal((await request("/api/customer-auth/session?shopId=8", { headers: h(alice) })).status, 401);
          assert.equal((await request("/api/customer-auth/session?shopId=7", { headers: { Cookie: "smarteat_customer=%zz" } })).status, 401);
        });
        await t.test("HTTPS cookie uses __Host prefix, secure proxy only, no insecure remote development cookie", async () => {
          advance(7200);
          const secure = await verify(await challenge(), {}, { "X-Forwarded-Proto": "https" });
          assert.equal(secure.status, 200, secure.raw);
          assert.match(secure.headers["set-cookie"][0], /^__Host-smarteat_customer=/);
          assert.match(secure.headers["set-cookie"][0], /; Secure;/);
          const Cookie = secure.headers["set-cookie"][0].split(";")[0];
          assert.equal((await request("/api/customer-auth/session?shopId=7", { headers: { Cookie, "X-Forwarded-Proto": "https" } })).status, 200);
          assert.equal((await request("/api/customer-auth/session?shopId=7", { headers: { Cookie: alice.Cookie, "X-Forwarded-Proto": "https" } })).status, 401);
          advance(7200);
          const unsafe = await verify(await challenge(), {}, { Host: "api.smarteat.test" });
          assert.equal(unsafe.status, 503);
          assert.equal(unsafe.headers["set-cookie"], undefined);
        });
        await t.test("concurrent HTTP verification creates one customer and one session, replay and other-browser are refused", async () => {
          advance(7200);
          const a = await challenge();
          assert.equal((await verify(a, { browserBinding: "another-browser-binding-fixture-32bytes" })).status, 401);
          const results = await Promise.all([verify(a), verify(a)]);
          assert.deepEqual(results.map(x => x.status).sort(), [200, 401]);
          assert.equal(Number((await db.readRows("SELECT COUNT(*) AS n FROM customer_sessions WHERE verified_challenge_id=?", [a.challengeId]))[0].n), 1);
          assert.equal(Number((await db.readRows("SELECT COUNT(*) AS n FROM customer_identities WHERE destination=?", [`task10-${serial}@example.test`]))[0].n), 1);
          const owner = await auth.verifyChallenge({ shopId: 7, challengeId: (await challenge()).challengeId, code, browserBinding });
          const races = await Promise.allSettled([sessions.create(owner), sessions.create(owner)]);
          assert.equal(races.filter(x => x.status === "fulfilled").length, 1);
          await assert.rejects(sessions.create({ ...owner, shopId: 8 }), { code: "CUSTOMER_SESSION_INVALID" });
          await assert.rejects(sessions.create({ ...owner, customerId: "51" }), { code: "CUSTOMER_SESSION_INVALID" });
        });
        await t.test("uncertain-send verified context permits session with null sent_at; failed/unverified/expired/link challenges do not", async () => {
          advance(7200);
          boundary.setResponse((_req, res) => res.destroy());
          const a = await challenge();
          assert.equal(a.status, "pending");
          const result = await verify(a);
          assert.equal(result.status, 200, result.raw);
          const [row] = await db.readRows("SELECT sent_at,verified_at,consumed_at FROM customer_otp_challenges WHERE id=?", [a.challengeId]);
          assert.equal(row.sent_at, null); assert.ok(row.verified_at); assert.ok(row.consumed_at);
          boundary.setResponse(accepted);
          const unverified = await challenge();
          await assert.rejects(sessions.create({ shopId: 7, customerId: alice.customerId, verifiedChallengeId: unverified.challengeId }), { code: "CUSTOMER_SESSION_INVALID" });
          const owner = await auth.verifyChallenge({ shopId: 7, challengeId: unverified.challengeId, code, browserBinding });
          advance(600);
          await assert.rejects(sessions.create(owner), { code: "CUSTOMER_SESSION_INVALID" });
        });
        await t.test("cookie CSRF is bound to session and exact origin, denies missing/OTP/foreign token before mutations", async () => {
          alice = await login();
          const bob = await login();
          for (const headers of [h(alice, { "X-CSRF-Token": "" }), h(alice, { "X-CSRF-Token": code }), h(alice, { "X-CSRF-Token": bob.csrf }), h(alice, { Origin: "https://evil.test" }), { Cookie: alice.Cookie, "X-CSRF-Token": alice.csrf }]) {
            const denied = await request("/api/customer/addresses?shopId=7", { method: "POST", headers, body: {} });
            assert.equal(denied.status, 403, denied.raw);
          }
          assert.equal((await request("/api/customer/addresses?shopId=7", { headers: h(alice) })).data.data.length, 0);
          assert.equal((await request("/api/customer/addresses?shopId=8", { headers: h(alice) })).status, 401);
        });
        await t.test("personal address CRUD and stored proof renewal use session owner, zero IGN while unavailable", async () => {
          const snapshot = { street: "7 rue Test", postalCode: "75001", city: "Paris", country: "FR", latitude: 48.86, longitude: 2.34,
            providerId: "fixture-address", providerLabel: "7 rue Test 75001 Paris", precision: "housenumber", complement: "Apt 2", instructions: "Private" };
          const token = signAddressResolution({ shopId: 7, addressSnapshot: snapshot, now, tokenCodec: codec });
          // Same signer secret as the default HTTP service; no geocoder is needed to store a signed snapshot.
          process.env.DELIVERY_TOKEN_SECRET = "task10-delivery-token-secret-32-bytes-fixture";
          const saved = await request("/api/customer/addresses?shopId=7", { method: "POST", headers: h(alice), body: { addressResolutionToken: token } });
          assert.equal(saved.status, 200, saved.raw);
          const id = saved.data.data.id;
          advance(901);
          const before = boundary.requests.length;
          const resolved = await request("/api/customer/address-resolutions?shopId=7", { method: "POST", headers: h(alice), body: { addressId: id } });
          assert.equal(resolved.status, 200, resolved.raw);
          assert.equal(boundary.requests.length, before);
          assert.equal(resolved.data.data.expiresAt, new Date(now.getTime() + 900000).toISOString());
          assert.equal(validateAddressResolution(resolved.data.data.addressResolutionToken, now, { tokenCodec: codec, shopId: 7 }).instructions, "Private");
          const bob = await login();
          for (const body of [{ addressId: id }, { addressId: id, customerId: alice.customerId }, { addressId: id, address: snapshot }, { address: snapshot, latitude: 48 }]) {
            const denied = await request("/api/customer/address-resolutions?shopId=7", { method: "POST", headers: h(bob), body });
            assert.ok([400, 404].includes(denied.status), denied.raw);
          }
          assert.equal((await request(`/api/customer/addresses/${id}?shopId=7`, { method: "PATCH", headers: h(bob), body: { instructions: "stolen" } })).status, 404);
          assert.equal((await request(`/api/customer/addresses/${id}?shopId=7`, { method: "PATCH", headers: h(alice), body: { instructions: "Changed" } })).status, 200);
          assert.equal((await request(`/api/customer/addresses/${id}?shopId=7`, { method: "DELETE", headers: h(alice) })).status, 200);
          assert.equal((await request("/api/customer/addresses?shopId=7", { headers: h(alice) })).data.data.length, 0);
        });
        await t.test("staff and customer coexist; stale headers never block personal API; cookie never authenticates staff", async () => {
          const bearer = jwt.sign({ id: 10, shopid: 7, access: 1 }, config().jwtSecret);
          const result = await request("/api/staff", { headers: { Cookie: alice.Cookie, Authorization: `Bearer ${bearer}` } });
          assert.equal(result.status, 200, result.raw);
          assert.deepEqual([result.data.id, result.data.access, result.data.shopid, result.data.sessionSubject], [10, 1, 7, "staff"]);
          assert.equal(result.data.customerSession.customerId, alice.customerId);
          assert.equal((await request("/api/staff", { headers: { Cookie: alice.Cookie } })).status, 401);
          for (const Authorization of ["Bearer stale", "nonsense"]) assert.equal((await request("/api/customer-auth/session?shopId=7", { headers: h(alice, { Authorization }) })).status, 200);
          assert.equal((await request("/api/orders/checkout", { method: "POST", headers: { ...h(alice), Authorization: `Bearer ${bearer}`, "X-CSRF-Token": "" } })).status, 403);
          assert.equal((await request("/api/orders/checkout", { method: "POST", headers: { ...h(alice), Authorization: `Bearer ${bearer}` } })).status, 200);
          const other = jwt.sign({ subject_type: "service_point", service_point_id: 9, shopid: 8, access: 2 }, config().jwtSecret);
          const foreign = await request("/api/orders/checkout", { method: "POST", headers: { ...h(alice), Authorization: `Bearer ${other}` } });
          assert.equal(foreign.status, 200); assert.equal(foreign.data.customerSession, null);
        });
        await t.test("verified link derives owner/purpose from session and requires explicit browser binding", async () => {
          advance(7200);
          const route = "/api/customer-auth/link/challenges?shopId=7";
          const body = { channel: "email", destination: "linked-task10@example.test", browserBinding };
          assert.equal((await request(route, { method: "POST", headers: h(alice), body: { ...body, customerId: "51" } })).status, 400);
          const a = await request(route, { method: "POST", headers: h(alice), body });
          assert.equal(a.status, 200, a.raw);
          assert.equal((await verify(a.data.data)).status, 401);
          const verified = await request("/api/customer-auth/link/verify?shopId=7", { method: "POST", headers: h(alice), body: { challengeId: a.data.data.challengeId, code, browserBinding } });
          assert.equal(verified.status, 200, verified.raw);
          assert.deepEqual(verified.data.data, { linked: true });
          assert.equal((await db.readRows("SELECT CAST(customer_id AS CHAR) AS id FROM customer_identities WHERE destination=?", [body.destination]))[0].id, alice.customerId);
          await assert.rejects(sessions.create({ shopId: 7, customerId: alice.customerId, verifiedChallengeId: a.data.data.challengeId }), { code: "CUSTOMER_SESSION_INVALID" });
        });
        await t.test("link cannot be consumed by another session or merge an existing contact; shop identities remain separate", async () => {
          const bob = await login();
          advance(7200);
          const destination = `task10-${serial}@example.test`;
          const a = await request("/api/customer-auth/link/challenges?shopId=7", { method: "POST", headers: h(alice), body: { channel: "email", destination, browserBinding } });
          assert.equal(a.status, 200, a.raw);
          const proof = { challengeId: a.data.data.challengeId, code, browserBinding };
          assert.equal((await request("/api/customer-auth/link/verify?shopId=7", { method: "POST", headers: h(bob), body: proof })).status, 401);
          assert.equal((await request("/api/customer-auth/link/verify?shopId=7", { method: "POST", headers: h(alice), body: proof })).status, 409);
          assert.equal((await db.readRows("SELECT CAST(customer_id AS CHAR) AS id FROM customer_identities WHERE shopid=7 AND destination=?", [destination]))[0].id, bob.customerId);
          advance(60);
          const other = await verify(await challenge({ destination, shopId: 8 }), { shopId: 8 });
          assert.equal(other.status, 200, other.raw);
          assert.notEqual(other.data.data.customerId, bob.customerId);
          const Cookie = other.headers["set-cookie"][0].split(";")[0];
          assert.equal((await request("/api/customer/addresses?shopId=7", { headers: { Cookie } })).status, 401);
          assert.equal((await request("/api/customer/addresses?shopId=8", { headers: { Cookie } })).status, 200);
        });
        await t.test("new postal resolution uses actual geocoder HTTP, safe candidates and private-field filtering; stored addresses survive IGN outage", async () => {
          let calls = 0;
          let status = 200;
          const seen = [];
          const feature = id => ({ type: "Feature", geometry: { type: "Point", coordinates: [2.34, 48.86] }, properties: {
            _type: "address", type: "housenumber", id, label: "7 rue Test 75001 Paris", housenumber: "7", street: "rue Test", postcode: "75001", city: "Paris", citycode: "75056", privateSupplierField: "not-for-browser" } });
          let features = [feature("candidate-1"), feature("candidate-2")];
          const provider = http.createServer((req, res) => { calls++; seen.push(req.url); res.statusCode = status;
            res.end(JSON.stringify({ type: "FeatureCollection", features, privateSupplierField: "not-for-browser" })); });
          await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
          const original = https.get;
          https.get = (options, callback) => {
            assert.equal(options.hostname, "data.geopf.fr");
            return http.get({ hostname: "127.0.0.1", port: provider.address().port, path: options.path, headers: options.headers }, callback);
          };
          try {
            // New adapter uses the existing geocoder/quota/signer. Boundary only is doubled.
            const address = { street: "7 rue Test", postalCode: "75001", city: "Paris", country: "FR", complement: "private-flat", instructions: "private-door" };
            const a = await request("/api/customer/address-resolutions?shopId=7", { method: "POST", headers: h(alice), body: { address } });
            assert.equal(a.status, 422, a.raw);
            assert.equal(a.data.data.candidates.length, 2);
            assert.doesNotMatch(a.raw, /not-for-browser|privateSupplierField/);
            assert.doesNotMatch(seen[0], /private-flat|private-door/);
            const selected = await request("/api/customer/address-resolutions?shopId=7", { method: "POST", headers: h(alice), body: { address, candidateId: "candidate-2" } });
            assert.equal(selected.status, 200, selected.raw);
            assert.equal(selected.data.data.addressSnapshot.providerId, "candidate-2");
            assert.equal(calls, 1);
            const saved = await request("/api/customer/addresses?shopId=7", { method: "POST", headers: h(alice), body: { addressResolutionToken: selected.data.data.addressResolutionToken } });
            assert.equal(saved.status, 200, saved.raw);
            status = 503; features = [];
            const unavailable = await request("/api/customer/address-resolutions?shopId=7", { method: "POST", headers: h(alice), body: { address: { ...address, street: "8 rue Test" } } });
            assert.equal(unavailable.status, 503, unavailable.raw);
            const before = calls;
            const stored = await request("/api/customer/address-resolutions?shopId=7", { method: "POST", headers: h(alice), body: { addressId: saved.data.data.id } });
            assert.equal(stored.status, 200, stored.raw); assert.equal(calls, before);
            for (const body of [{ address: { ...address, latitude: 48.86, longitude: 2.34 } }, { address, customerId: alice.customerId }, { addressId: saved.data.data.id, candidateId: "candidate-1" }]) {
              assert.equal((await request("/api/customer/address-resolutions?shopId=7", { method: "POST", headers: h(alice), body })).status, 400);
            }
          } finally { https.get = original; provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
        });
        await t.test("forged XFF from untrusted peer cannot evade the real shared SQL IP quota", async () => {
          advance(7200);
          const untrustedApp = express();
          configureCustomerTrustProxy(untrustedApp, []);
          untrustedApp.use(express.json());
          untrustedApp.use("/api", buildCustomersRouter({ customerAuthController: buildCustomerAuthController({ customerAuth: auth, transports, sessions }), customerMiddleware: middleware }));
          const before = boundary.requests.length;
          await withHttp(untrustedApp, async call => {
            for (let i = 0; i < 21; i++) {
              const result = await call("/api/customer-auth/challenges", { method: "POST", headers: { Origin: origin, "X-Forwarded-For": `192.0.2.${i + 1}` },
                body: { shopId: i % 2 ? 7 : 8, channel: "email", destination: `ip-quota-${i}@example.test`, browserBinding } });
              assert.equal(result.status, i < 20 ? 200 : 429, result.raw);
            }
          });
          assert.equal(boundary.requests.length, before + 20);
        });
        await t.test("session IDs and UTC expiry survive production numeric defaults and non-UTC driver timezone", async () => {
          advance(7200);
          await db.pool.query("ALTER TABLE customer_sessions AUTO_INCREMENT=9007199254740993");
          const owner = await auth.verifyChallenge({ shopId: 7, challengeId: (await challenge()).challengeId, code, browserBinding });
          const url = new URL(process.env.DELIVERY_TEST_DATABASE_URL);
          const otherPool = mysql.createPool({ host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: db.database, timezone: "+02:00", connectionLimit: 2 });
          try {
            const other = buildCustomerSession({ repository: buildSqlCustomerSessionRepository({ pool: otherPool }), clock, secret: config().secret, allowedOrigins: [origin] });
            const created = await other.create(owner);
            assert.equal(created.session.id, "9007199254740993");
            assert.equal(created.session.customerId, owner.customerId);
            assert.equal(created.session.expiresAt, new Date(now.getTime() + 2592000000).toISOString().replace(".000", ""));
            assert.equal((await other.read({ rawToken: created.rawToken, shopId: 7 })).id, "9007199254740993");
            const firstToken = other.csrfToken(created.session);
            assert.equal(other.verifyCsrf({ session: created.session, token: firstToken, origin }), true);
            assert.equal(other.verifyCsrf({ session: { ...created.session, customerId: "51" }, token: firstToken, origin }), false);
            assert.equal(other.verifyCsrf({ session: created.session, token: firstToken, origin: "https://evil.test" }), false);
          } finally { await otherPool.end(); }
        });
        await t.test("default personal adapter locks Shop before customer to match archive FK producers", async () => {
          const locks = [];
          const original = db.pool.getConnection;
          db.pool.getConnection = async () => {
            const connection = await original.call(db.pool);
            return new Proxy(connection, { get(target, key) {
              if (key === "query") return async (...args) => {
                const result = await target.query(...args);
                if (/FROM (shop|customers)\b/i.test(args[0]) && /FOR (SHARE|UPDATE)/i.test(args[0])) locks.push(args[0].match(/FROM (shop|customers)\b/i)[1].toLowerCase());
                return result;
              };
              const value = target[key];
              return typeof value === "function" ? value.bind(target) : value;
            } });
          };
          try {
            const ownApp = express();
            ownApp.get("/addresses", middleware.requireCustomerSession, buildPersonalCustomersController().listAddresses);
            await withHttp(ownApp, async call => {
              const result = await call("/addresses?shopId=7", { headers: h(alice) });
              assert.equal(result.status, 200, result.raw);
            });
            assert.deepEqual(locks.slice(0, 2), ["shop", "customers"]);
          } finally { db.pool.getConnection = original; }
        });
        await t.test("SQL insert failure rolls back session row; invalidated owner proof cannot be used", async () => {
          advance(7200);
          const owner = await auth.verifyChallenge({ shopId: 7, challengeId: (await challenge()).challengeId, code, browserBinding });
          await db.pool.query("CREATE TRIGGER task10_fail_session BEFORE INSERT ON customer_sessions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture insert failure'");
          try {
            await assert.rejects(sessions.create(owner), { code: "CUSTOMER_SESSION_UNAVAILABLE" });
            assert.equal(Number((await db.readRows("SELECT COUNT(*) AS n FROM customer_sessions WHERE verified_challenge_id=?", [owner.verifiedChallengeId]))[0].n), 0);
          } finally { await db.pool.query("DROP TRIGGER task10_fail_session"); }
          await db.pool.query("UPDATE customer_otp_challenges SET invalidated_at=UTC_TIMESTAMP() WHERE id=?", [owner.verifiedChallengeId]);
          await assert.rejects(sessions.create(owner), { code: "CUSTOMER_SESSION_INVALID" });
        });
        await t.test("logout is scoped and CSRF guarded, revocation and exact expiry reject without touching staff", async () => {
          const bob = await login();
          const staffToken = jwt.sign({ id: 10, shopid: 7, access: 1 }, config().jwtSecret);
          await db.pool.query("UPDATE users SET token=? WHERE id=10", [staffToken]);
          assert.equal((await request("/api/customer-auth/logout?shopId=8", { method: "POST", headers: h(alice) })).status, 401);
          assert.equal((await request("/api/customer-auth/logout?shopId=7", { method: "POST", headers: h(alice, { "X-CSRF-Token": "" }) })).status, 403);
          const out = await request("/api/customer-auth/logout?shopId=7", { method: "POST", headers: h(alice) });
          assert.equal(out.status, 200); assert.match(out.headers["set-cookie"][0], /Max-Age=0/);
          assert.equal((await request("/api/customer-auth/session?shopId=7", { headers: h(alice) })).status, 401);
          assert.equal((await request("/api/customer-auth/session?shopId=7", { headers: h(bob) })).status, 200);
          assert.equal((await db.readRows("SELECT token FROM users WHERE id=10"))[0].token, staffToken);
          assert.equal((await request("/api/staff", { headers: { Authorization: `Bearer ${staffToken}`, Cookie: alice.Cookie } })).status, 200);
          advance(2592000);
          assert.equal((await request("/api/customer-auth/session?shopId=7", { headers: h(bob) })).status, 401);
        });
      });
    });
  });
});
