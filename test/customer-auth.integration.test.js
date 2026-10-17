const assert = require("assert/strict");
const { test } = require("node:test");
const path = require("path");
const express = require("express");
const mysql = require("mysql2/promise");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { withDeliveryDatabase } = require("./helpers/deliveryDatabase");
const { withProviderHttp, config } = require("./customer-code-transports.test");
const CODE = "123456";
const binding = "browser-fixture-32-bytes-of-entropy-test";

test("customer auth with actual SQL and crypto, only provider HTTP doubled", async t => {
  const { buildCustomerAuth, buildSqlCustomerAuthRepository } = require("../src/modules/m_customerAuth");
  const { buildCustomerCodeTransports } = require("../src/services/customerCodeTransports");
  await withDeliveryDatabase(async db => {
    await db.seedScenario();
    process.env.ENV_FILE = path.join(__dirname, "task9-nonexistent.env");
    process.env.JWTKEY = config().jwtSecret;
    process.env.EMAIL = config().email;
    process.env.MAILAPIKEY = config().mailApiKey;
    process.env.MAILSECRETKEY = config().mailSecretKey;
    require.cache[require.resolve("../src/config/dbPool")] = { exports: db.pool };
    require.cache[require.resolve("../src/config/db")] = { exports: db.pool.pool };
    await withProviderHttp(async boundary => {
      const accepted = (_req, res) => res.end(JSON.stringify({ Messages: [{ Status: "success", To: [{ MessageUUID: "mail-fixture-id" }] }], messages: [{ id: "meta-fixture-id" }] }));
      boundary.setResponse(accepted);
      let now = new Date("2026-10-18T12:00:00Z");
      const clock = () => now;
      const transports = buildCustomerCodeTransports({ getConfig: config });
      const repository = buildSqlCustomerAuthRepository({ pool: db.pool });
      const service = buildCustomerAuth({ repository, transports, clock, randomCode: () => CODE, secret: config().secret });
      const second = buildCustomerAuth({ repository: buildSqlCustomerAuthRepository({ pool: db.pool }), transports, clock, randomCode: () => CODE, secret: config().secret });
      let n = 0;
      const input = extra => ({ shopId: 7, channel: "email", destination: `fixture${++n}@example.test`, ip: "192.0.2.1", browserBinding: binding, purpose: "login", ...extra });
      const verify = (challenge, extra) => service.verifyChallenge({ shopId: 7, challengeId: challenge.challengeId, code: CODE, browserBinding: binding, ...extra });
      const advance = seconds => { now = new Date(now.getTime() + seconds * 1000); };
      const reset = async () => { advance(7200); boundary.setResponse(accepted); };
      await t.test("public result omits OTP, HMAC binds challenge and context; 599 valid, 600 expired", async () => {
        const a = await service.requestChallenge(input());
        assert.deepEqual(Object.keys(a).sort(), ["challengeId", "expiresAt", "resendAfter", "status"]);
        assert.equal(a.code, undefined);
        assert.equal(a.status, "sent");
        assert.equal(a.expiresAt, "2026-10-18T12:10:00.000Z");
        const [stored] = await db.readRows("SELECT * FROM customer_otp_challenges WHERE id=?", [a.challengeId]);
        assert.notEqual(stored.code_hash, CODE);
        assert.match(stored.code_hash, /^[a-f0-9]{64}$/);
        advance(599);
        const identity = await verify(a);
        assert.equal(typeof identity.customerId, "string");
        assert.deepEqual(identity, { shopId: 7, customerId: identity.customerId, verifiedChallengeId: a.challengeId });
        const b = await service.requestChallenge(input());
        advance(600);
        await assert.rejects(verify(b), { code: "CUSTOMER_CODE_INVALID" });
        await assert.rejects(verify(a), { code: "CUSTOMER_CODE_INVALID" });
      });
      await t.test("five wrong codes persist and close; wrong browser/shop/purpose cannot verify", async () => {
        await reset();
        const a = await service.requestChallenge(input());
        await assert.rejects(verify(a, { shopId: 8 }), { code: "CUSTOMER_CODE_INVALID" });
        await assert.rejects(verify(a, { browserBinding: "other-browser-binding-fixture-32bytes" }), { code: "CUSTOMER_CODE_INVALID" });
        for (let i = 0; i < 4; i++) await assert.rejects(verify(a, { code: "000000" }), { code: "CUSTOMER_CODE_INVALID" });
        const [open] = await db.readRows("SELECT attempts,invalidated_at FROM customer_otp_challenges WHERE id=?", [a.challengeId]);
        assert.equal(open.attempts, 4);
        assert.equal(open.invalidated_at, null);
        await assert.rejects(verify(a, { code: "000000" }), { code: "CUSTOMER_CODE_INVALID" });
        const [stored] = await db.readRows("SELECT attempts,invalidated_at FROM customer_otp_challenges WHERE id=?", [a.challengeId]);
        assert.equal(stored.attempts, 5);
        assert.ok(stored.invalidated_at);
        await assert.rejects(verify(a), { code: "CUSTOMER_CODE_INVALID" });
      });
      await t.test("HMAC rejects transplanted hashes and changed challenge purpose/destination", async () => {
        await reset();
        const first = await service.requestChallenge(input());
        const other = await service.requestChallenge(input());
        const [stored] = await db.readRows("SELECT code_hash FROM customer_otp_challenges WHERE id=?", [first.challengeId]);
        await db.pool.query("UPDATE customer_otp_challenges SET code_hash=? WHERE id=?", [stored.code_hash, other.challengeId]);
        await assert.rejects(verify(other), { code: "CUSTOMER_CODE_INVALID" });
        await db.pool.query("UPDATE customer_otp_challenges SET destination='changed@example.test' WHERE id=?", [first.challengeId]);
        await assert.rejects(verify(first), { code: "CUSTOMER_CODE_INVALID" });
        const link = await service.requestChallenge(input({ purpose: "link", customerId: "51" }));
        await db.pool.query("UPDATE customer_otp_challenges SET purpose='login',customer_id=NULL WHERE id=?", [link.challengeId]);
        await assert.rejects(verify(link), { code: "CUSTOMER_CODE_INVALID" });
      });
      await t.test("59s resend denied, 60s replaces old code atomically including concurrent instances", async () => {
        await reset();
        const request = input();
        const first = await service.requestChallenge(request);
        advance(59);
        const count = boundary.requests.length;
        await assert.rejects(service.requestChallenge(request), { code: "CUSTOMER_RATE_LIMITED" });
        assert.equal(boundary.requests.length, count);
        advance(1);
        const outcomes = await Promise.allSettled([service.requestChallenge(request), second.requestChallenge(request)]);
        assert.equal(outcomes.filter(x => x.status === "fulfilled").length, 1);
        await assert.rejects(verify(first), { code: "CUSTOMER_CODE_INVALID" });
        await verify(outcomes.find(x => x.status === "fulfilled").value);
      });
      await t.test("concurrent verification consumes once, separate contacts do not inherit staff profile/history", async () => {
        await reset();
        const first = await service.requestChallenge(input({ destination: "cashier@example.test" }));
        const results = await Promise.allSettled([verify(first), second.verifyChallenge({ shopId: 7, challengeId: first.challengeId, code: CODE, browserBinding: binding })]);
        assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
        const context = results.find(x => x.status === "fulfilled").value;
        assert.notEqual(context.customerId, "51");
        assert.equal((await db.readRows("SELECT id FROM customer_identities WHERE shopid=7 AND destination='cashier@example.test'")).length, 1);
        assert.equal(Number((await db.readRows("SELECT COUNT(*) AS n FROM customer_sessions"))[0].n), 0);
        assert.equal((await db.readRows("SELECT customer_account_id FROM orders WHERE id=31"))[0].customer_account_id, null);
      });
      await t.test("contact five/hour ceiling spans shops and two independent SQL pools; rolling hour boundary", async () => {
        await reset();
        const url = new URL(process.env.DELIVERY_TEST_DATABASE_URL);
        const otherPool = mysql.createPool({ host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: db.database, timezone: "Z", connectionLimit: 2 });
        try {
          const other = buildCustomerAuth({ repository: buildSqlCustomerAuthRepository({ pool: otherPool }), transports, clock, randomCode: () => CODE, secret: config().secret });
          const request = input({ destination: "shared-contact@example.test" });
          for (let i = 0; i < 4; i++) { await service.requestChallenge({ ...request, shopId: i % 2 ? 8 : 7 }); advance(60); }
          const results = await Promise.allSettled([service.requestChallenge(request), other.requestChallenge({ ...request, shopId: 8 })]);
          assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
          advance(60);
          const count = boundary.requests.length;
          await assert.rejects(other.requestChallenge({ ...request, shopId: 8 }), { code: "CUSTOMER_RATE_LIMITED" });
          assert.equal(boundary.requests.length, count);
          advance(3299);
          await assert.rejects(service.requestChallenge(request), { code: "CUSTOMER_RATE_LIMITED" });
          advance(1);
          await service.requestChallenge(request);
        } finally { await otherPool.end(); }
      });
      await t.test("IP twenty/hour ceiling spans shops and concurrent instances; failed reservations consume neither budget", async () => {
        await reset();
        for (let i = 0; i < 19; i++) await service.requestChallenge(input({ shopId: i % 2 ? 8 : 7, ip: "192.0.2.20" }));
        const requests = [input({ ip: "192.0.2.20" }), input({ shopId: 8, ip: "192.0.2.20" })];
        const before = boundary.requests.length;
        const results = await Promise.allSettled([service.requestChallenge(requests[0]), second.requestChallenge(requests[1])]);
        assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
        assert.equal(boundary.requests.length, before + 1);
        const losing = requests[results.findIndex(x => x.status === "rejected")];
        await service.requestChallenge({ ...losing, ip: "192.0.2.21" });
      });
      await t.test("equivalent IPv6 and IPv4-mapped addresses share the same quota", async () => {
        await reset();
        for (let i = 0; i < 20; i++) await service.requestChallenge(input({ shopId: i % 2 ? 7 : 8, ip: "192.0.2.25" }));
        const count = boundary.requests.length;
        await assert.rejects(second.requestChallenge(input({ ip: "::ffff:192.0.2.25" })), { code: "CUSTOMER_RATE_LIMITED" });
        assert.equal(boundary.requests.length, count);
      });
      await t.test("same verified contact remains two isolated customer accounts across shops", async () => {
        await reset();
        const request = input({ destination: "tenant-isolation@example.test" });
        const first = await service.requestChallenge(request);
        const a = await verify(first);
        advance(60);
        const other = await second.requestChallenge({ ...request, shopId: 8 });
        const b = await verify(other, { shopId: 8 });
        assert.notEqual(a.customerId, b.customerId);
        assert.deepEqual(Object.keys(first), Object.keys(other));
        assert.equal(first.status, other.status);
        assert.equal((await db.readRows("SELECT id FROM customer_identities WHERE destination=?", [request.destination])).length, 2);
      });
      await t.test("Shop-first archive and customer link reservation serialize without an FK lock cycle", async () => {
        await reset();
        if (Number(process.versions.node.split(".")[0]) < 22) require.cache[require.resolve("nanoid")] = { exports: await import("nanoid") };
        const { buildOrderArchiveModule } = require("../src/modules/m_orders");
        const { createTransactionRunner } = require("../src/helpers/withTransaction");
        await db.pool.query("UPDATE orders SET customer_account_id='51',status=3 WHERE id=33");
        const archiveConnection = await db.pool.getConnection();
        await archiveConnection.query("SET SESSION innodb_lock_wait_timeout=5");
        let releaseArchive, releaseLink, announceArchive;
        const archiveGate = new Promise(resolve => { releaseArchive = resolve; });
        const linkGate = new Promise(resolve => { releaseLink = resolve; });
        const archiveLocked = new Promise(resolve => { announceArchive = resolve; });
        const sqlFailures = [];
        const gated = (connection, afterQuery) => new Proxy(connection, { get(target, key) {
          if (key === "query") return async (...args) => {
            let result;
            try { result = await target.query(...args); }
            catch (error) { sqlFailures.push(error.code); throw error; }
            await afterQuery(args[0]);
            return result;
          };
          const value = target[key];
          return typeof value === "function" ? value.bind(target) : value;
        } });
        const archive = buildOrderArchiveModule({ withTransaction: createTransactionRunner({
          getConnection: async () => gated(archiveConnection, async sql => {
            if (/FROM shop\b/.test(sql) && /FOR UPDATE/.test(sql)) { announceArchive(); await archiveGate; }
          }),
        }) });
        let linkConnection;
        const linkRepository = buildSqlCustomerAuthRepository({ pool: { getConnection: async () => {
          const connection = await db.pool.getConnection();
          if (linkConnection) return connection;
          linkConnection = connection;
          await connection.query("SET SESSION innodb_lock_wait_timeout=5");
          return gated(connection, async sql => {
            if (/FROM customers\b/.test(sql) && /FOR UPDATE/.test(sql)) await linkGate;
          });
        } } });
        const linking = buildCustomerAuth({ repository: linkRepository, transports, clock, randomCode: () => CODE, secret: config().secret });
        const settle = promise => promise.then(result => ({ result }), error => ({ error }));
        // Poll lock metadata only; each real producer executes once, on two connections.
        const observe = async (connection, sql, params, description) => {
          const deadline = Date.now() + 3000;
          while (Date.now() < deadline) {
            const [rows] = await connection.query(sql, params());
            if (rows.length) return rows[0];
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          assert.fail(description);
        };
        const count = boundary.requests.length;
        const archiving = settle(archive.mArchiveOrder(33, "Especes", 7));
        let requesting;
        try {
          await Promise.race([archiveLocked, archiving.then(() => assert.fail("Archive must hold its actual Shop X lock"))]);
          requesting = settle(linking.requestChallenge(input({ purpose: "link", customerId: "51" })));
          const observed = await observe(archiveConnection, `SELECT l.OBJECT_NAME AS name FROM performance_schema.data_locks l
            JOIN performance_schema.threads t ON t.THREAD_ID=l.THREAD_ID
            WHERE l.OBJECT_SCHEMA=DATABASE() AND t.PROCESSLIST_ID=? AND l.LOCK_TYPE='RECORD'
              AND ((l.OBJECT_NAME='shop' AND l.LOCK_STATUS='WAITING')
                OR (l.OBJECT_NAME='customers' AND l.LOCK_STATUS='GRANTED' AND l.LOCK_MODE LIKE 'X%'))`,
          () => [linkConnection ? linkConnection.threadId : 0], "Link must either wait for Shop or hold customer X");
          assert.equal(boundary.requests.length, count);
          releaseLink();
          releaseArchive();
          const completed = await Promise.all([archiving, requesting]);
          t.diagnostic(`archive/link schedule: link ${observed.name === "shop" ? "waited for Shop" : "held customer first"}; SQL failures: ${sqlFailures.join(",") || "none"}`);
          assert.equal(observed.name, "shop", "Link must wait for the archive's Shop X before locking its customer FK parent");
          assert.deepEqual(sqlFailures, [], "Archive and link must commit without a deadlock/retry");
          for (const outcome of completed) assert.equal(outcome.error, undefined);
          assert.equal(completed[1].result.status, "sent");
          assert.equal(boundary.requests.length, count + 1);
          assert.equal((await db.readRows("SELECT CAST(customer_account_id AS CHAR) AS owner FROM archives WHERE shopid=7 AND ordernumber='FIXTURE-33'"))[0].owner, "51");
          assert.equal((await db.readRows("SELECT id FROM orders WHERE id=33")).length, 0);
          assert.equal((await service.linkIdentity({ customerSession: { shopId: 7, customerId: "51" },
            challengeId: completed[1].result.challengeId, code: CODE, browserBinding: binding })).customerId, "51");
        } finally {
          releaseLink(); releaseArchive();
          const settled = await Promise.all([archiving, requesting]);
          for (const [index, outcome] of settled.entries()) if (outcome && outcome.error) {
            t.diagnostic(`${index === 0 ? "archive" : "link"} failed: ${outcome.error.code || "Error"}: ${outcome.error.message}`);
          }
        }
      });
      await t.test("SQL rollback leaves no partial challenge/counters and no send", async () => {
        await reset();
        const request = input();
        const count = boundary.requests.length;
        // Actual server-side fault after challenge insertion and before its transaction commits.
        await db.pool.query("CREATE TRIGGER task9_reservation_fault BEFORE INSERT ON service_rate_limits FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='task9 fixture fault'");
        try { await assert.rejects(service.requestChallenge(request), { code: "CUSTOMER_AUTH_UNAVAILABLE" }); }
        finally { await db.pool.query("DROP TRIGGER task9_reservation_fault"); }
        assert.equal((await db.readRows("SELECT id FROM customer_otp_challenges WHERE destination=?", [request.destination])).length, 0);
        assert.equal(boundary.requests.length, count);
        await service.requestChallenge(request);
      });
      await t.test("uncertain advisory release destroys the acquired connection before it can return to the pool", async () => {
        let acquired;
        await assert.rejects(repository.transaction(async connection => {
          acquired = connection;
          await connection.query("SELECT RELEASE_ALL_LOCKS()");
        }), { code: "CUSTOMER_AUTH_UNAVAILABLE" });
        await assert.rejects(acquired.query("SELECT 1"), /closed state/);
        assert.equal(Number((await db.readRows("SELECT 1 AS healthy"))[0].healthy), 1);
      });
      await t.test("link requires verified session owner and code, login/link isolated, conflict never merges", async () => {
        await reset();
        const session = { shopId: 7, customerId: "51", browserBinding: binding };
        const link = await service.requestChallenge(input({ purpose: "link", customerId: "51", destination: "+33612345678", channel: "whatsapp" }));
        await assert.rejects(verify(link), { code: "CUSTOMER_CODE_INVALID" });
        await assert.rejects(service.linkIdentity({ customerSession: { ...session, customerId: "52" }, challengeId: link.challengeId, code: CODE }), { code: "CUSTOMER_CODE_INVALID" });
        assert.equal((await service.linkIdentity({ customerSession: session, challengeId: link.challengeId, code: CODE })).customerId, "51");
        advance(60);
        const login = await service.requestChallenge(input({ destination: "+33612345678", channel: "whatsapp", ip: "192.0.2.2" }));
        await assert.rejects(service.linkIdentity({ customerSession: session, challengeId: login.challengeId, code: CODE }), { code: "CUSTOMER_CODE_INVALID" });
        assert.equal((await verify(login)).customerId, "51");
        advance(60);
        const profile = await db.pool.query("INSERT INTO customers (shopid,name) VALUES (7,'Other verified owner')");
        const otherId = String(profile[0].insertId);
        const conflict = await service.requestChallenge(input({ purpose: "link", customerId: otherId, destination: "+33612345678", channel: "whatsapp" }));
        await assert.rejects(service.linkIdentity({ customerSession: { ...session, customerId: otherId }, challengeId: conflict.challengeId, code: CODE }), { code: "CUSTOMER_IDENTITY_CONFLICT" });
        assert.equal((await db.readRows("SELECT CAST(customer_id AS CHAR) AS id FROM customer_identities WHERE channel='whatsapp' AND shopid=7"))[0].id, "51");
        await assert.rejects(service.requestChallenge(input({ purpose: "link", customerId: "52" })), { code: "CUSTOMER_REQUEST_INVALID" });
      });
      await t.test("timeout stays pending; received code verifies without invented provider ack or timestamp", async () => {
        await reset();
        boundary.setResponse(() => {});
        const challenge = await service.requestChallenge(input());
        assert.equal(challenge.status, "pending");
        const context = await verify(challenge);
        const [row] = await db.readRows("SELECT send_status,sent_at,consumed_at,CAST(verified_customer_id AS CHAR) AS owner FROM customer_otp_challenges WHERE id=?", [challenge.challengeId]);
        assert.equal(row.send_status, "sent");
        assert.equal(row.sent_at, null);
        assert.ok(row.consumed_at);
        assert.equal(row.owner, context.customerId);
        await assert.rejects(verify(challenge), { code: "CUSTOMER_CODE_INVALID" });
      });
      await t.test("explicit supplier rejection closes verification but keeps reserved quotas; never auto-fallback", async () => {
        await reset();
        boundary.setResponse((_req, res) => { res.statusCode = 400; res.end("{}"); });
        const request = input();
        const count = boundary.requests.length;
        const challenge = await service.requestChallenge(request);
        assert.equal(challenge.status, "failed");
        assert.equal(boundary.requests.length, count + 1);
        await assert.rejects(verify(challenge), { code: "CUSTOMER_CODE_INVALID" });
        await assert.rejects(service.requestChallenge(request), { code: "CUSTOMER_RATE_LIMITED" });
        assert.equal(boundary.requests.length, count + 1);
      });
      await t.test("HTTP begins after commit and advisory release; late failure cannot downgrade verified challenge", async () => {
        await reset();
        let release;
        const reached = new Promise(resolve => boundary.setResponse(async (_req, res) => {
          release = () => { res.statusCode = 400; res.end("{}"); };
          resolve();
        }));
        const request = input();
        const pending = service.requestChallenge(request);
        await reached;
        const [row] = await db.readRows("SELECT CAST(id AS CHAR) AS challengeId FROM customer_otp_challenges WHERE destination=?", [request.destination]);
        assert.ok(row);
        // Another instance can reserve and verify while the first provider call is in flight.
        boundary.setResponse(accepted);
        await second.requestChallenge(input({ ip: "192.0.2.9" }));
        await verify(row);
        release();
        const response = await pending;
        assert.equal(response.status, "sent");
        const [stored] = await db.readRows("SELECT send_status,sent_at FROM customer_otp_challenges WHERE id=?", [row.challengeId]);
        assert.equal(stored.send_status, "sent");
        assert.equal(stored.sent_at, null);
      });
      await t.test("late success never resurrects an invalidated predecessor", async () => {
        await reset();
        let release;
        const reached = new Promise(resolve => boundary.setResponse((_req, res) => { release = () => accepted(_req, res); resolve(); }));
        const request = input();
        const pending = service.requestChallenge(request);
        await reached;
        const [old] = await db.readRows("SELECT CAST(id AS CHAR) AS challengeId FROM customer_otp_challenges WHERE destination=?", [request.destination]);
        advance(60);
        boundary.setResponse(accepted);
        const replacement = await second.requestChallenge(request);
        release();
        await pending;
        const [row] = await db.readRows("SELECT send_status,invalidated_at,sent_at FROM customer_otp_challenges WHERE id=?", [old.challengeId]);
        assert.ok(row.invalidated_at);
        assert.equal(row.send_status, "pending");
        assert.equal(row.sent_at, null);
        await assert.rejects(verify(old), { code: "CUSTOMER_CODE_INVALID" });
        await verify(replacement);
      });
      await t.test("default crypto code generation sends six digits without plaintext persistence", async () => {
        await reset();
        const generated = buildCustomerAuth({ repository, transports, clock, secret: config().secret });
        const request = input();
        const challenge = await generated.requestChallenge(request);
        const sentCode = boundary.requests.at(-1).body.Messages[0].TextPart.match(/\b\d{6}\b/)[0];
        const [stored] = await db.readRows("SELECT code_hash FROM customer_otp_challenges WHERE id=?", [challenge.challengeId]);
        assert.equal(stored.code_hash.includes(sentCode), false);
        await generated.verifyChallenge({ shopId: 7, challengeId: challenge.challengeId, browserBinding: binding, code: sentCode });
      });
      await t.test("exact BIGINT challenge and owner IDs with production mysql2 defaults; identity case remains distinct", async () => {
        await reset();
        const url = new URL(process.env.DELIVERY_TEST_DATABASE_URL);
        const driver = mysql.createPool({ host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: db.database, timezone: "Z", connectionLimit: 2 });
        try {
          const precise = buildCustomerAuth({ repository: buildSqlCustomerAuthRepository({ pool: driver }), transports, clock, randomCode: () => CODE, secret: config().secret });
          await db.pool.query("ALTER TABLE customers AUTO_INCREMENT=9007199254740993");
          await db.pool.query("ALTER TABLE customer_otp_challenges AUTO_INCREMENT=9007199254740993");
          const a = await precise.requestChallenge(input({ destination: "Exact@b\u00fccher.DE" }));
          assert.equal(a.challengeId, "9007199254740993");
          const owner = await precise.verifyChallenge({ shopId: 7, challengeId: a.challengeId, code: CODE, browserBinding: binding });
          assert.equal(owner.customerId, "9007199254740993");
          const b = await precise.requestChallenge(input({ destination: "exact@xn--bcher-kva.de" }));
          assert.equal(b.challengeId, "9007199254740994");
          assert.equal((await precise.verifyChallenge({ shopId: 7, challengeId: b.challengeId, code: CODE, browserBinding: binding })).customerId, "9007199254740994");
        } finally { await driver.end(); }
      });
      await t.test("different driver timezones cannot extend code expiry or multiply cross-shop quotas", async () => {
        await reset();
        const url = new URL(process.env.DELIVERY_TEST_DATABASE_URL);
        const driver = mysql.createPool({ host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: db.database, timezone: "+02:00", connectionLimit: 2 });
        try {
          const offset = buildCustomerAuth({ repository: buildSqlCustomerAuthRepository({ pool: driver }), transports, clock, randomCode: () => CODE, secret: config().secret });
          const request = input({ destination: "timezone@example.test" });
          const challenge = await offset.requestChallenge(request);
          const [stored] = await db.readRows("SELECT DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%sZ') AS created,DATE_FORMAT(expires_at,'%Y-%m-%dT%H:%i:%s.000Z') AS expires FROM customer_otp_challenges WHERE id=?", [challenge.challengeId]);
          assert.equal(stored.created, now.toISOString().replace(".000Z", "Z"));
          assert.equal(stored.expires, challenge.expiresAt);
          advance(59);
          await assert.rejects(second.requestChallenge({ ...request, shopId: 8 }), { code: "CUSTOMER_RATE_LIMITED" });
          advance(1);
          await second.requestChallenge({ ...request, shopId: 8 });
          advance(540);
          await assert.rejects(verify(challenge), { code: "CUSTOMER_CODE_INVALID" });
          await assert.rejects(offset.verifyChallenge({ shopId: 7, challengeId: challenge.challengeId, code: CODE, browserBinding: binding }), { code: "CUSTOMER_CODE_INVALID" });
        } finally { await driver.end(); }
      });
      await t.test("real staff PIN login and stored JWT remain independent from customer OTP", async () => {
        await reset();
        if (Number(process.versions.node.split(".")[0]) < 22) require.cache[require.resolve("nanoid")] = { exports: await import("nanoid") };
        const { hashStaffPin } = require("../src/helpers/staffCredentials");
        await db.pool.query("UPDATE users SET staff_login_id='ABCD23',staff_pin_hash=? WHERE id=10", [await hashStaffPin("7410")]);
        const { loginWithStaffCredentials } = require("../src/controllers/c_users");
        const app = express();
        app.use(express.json());
        app.post("/login", loginWithStaffCredentials);
        const server = app.listen(0, "127.0.0.1");
        await new Promise(resolve => server.once("listening", resolve));
        const login = async pin => {
          const result = await fetch(`http://127.0.0.1:${server.address().port}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ staff_login_id: "ABCD23", pin }) });
          return { status: result.status, body: await result.json() };
        };
        try {
          const count = boundary.requests.length;
          assert.equal((await login("0000")).status, 422);
          const staff = await login("7410");
          assert.equal(staff.status, 200);
          const token = staff.body.data[0].token;
          assert.equal(jwt.verify(token, config().jwtSecret).id, 10);
          const customer = await service.requestChallenge(input());
          await verify(customer);
          assert.equal((await db.readRows("SELECT token FROM users WHERE id=10"))[0].token, token);
          assert.equal(jwt.verify(token, config().jwtSecret).access, 1);
          assert.equal(boundary.requests.length, count + 1);
          assert.equal((await login("7410")).status, 200);
        } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      });
      await t.test("HTTP routes omit secrets/session, use server IP and never trust public link/customer fields", async () => {
        await reset();
        const { buildCustomerAuthController } = require("../src/controllers/c_customers");
        const { buildCustomersRouter } = require("../src/routers/r_customers");
        const controller = buildCustomerAuthController({ customerAuth: service, transports });
        const app = express();
        app.use(express.json());
        app.use(buildCustomersRouter({ customerAuthController: controller }));
        const server = app.listen(0, "127.0.0.1");
        await new Promise(resolve => server.once("listening", resolve));
        const call = async (route, body) => {
          const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, body ? { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.10" }, body: JSON.stringify(body) } : {});
          return { response, body: await response.json() };
        };
        try {
          const count = boundary.requests.length;
          const discovery = await call("/customer-auth/channels");
          assert.equal(discovery.response.status, 200);
          assert.deepEqual(discovery.body.data, { email: true, whatsapp: true });
          assert.equal(boundary.requests.length, count);
          const fields = { shopId: 7, channel: "email", destination: "http@example.test", browserBinding: binding };
          for (const extra of [{ purpose: "link" }, { customerId: "51" }, { ip: "198.51.100.10" }, { providerUrl: "https://example.test" }]) {
            assert.equal((await call("/customer-auth/challenges", { ...fields, ...extra })).response.status, 400);
          }
          const challenge = await call("/customer-auth/challenges", fields);
          assert.equal(challenge.response.status, 200);
          assert.equal(challenge.response.headers.get("set-cookie"), null);
          assert.equal(challenge.response.headers.get("cache-control"), "no-store");
          assert.equal(challenge.body.data.code, undefined);
          const subject = crypto.createHmac("sha256", config().secret).update(JSON.stringify(["ip", "127.0.0.1"])).digest("hex");
          assert.equal(Number((await db.readRows("SELECT SUM(attempts) AS n FROM service_rate_limits WHERE scope='customer_otp_ip' AND subject_hash=?", [subject]))[0].n), 1);
          // HTTP verify/session/cookie wiring belongs to Task10.
          assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/customer-auth/verify`, { method: "POST" })).status, 404);
        } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      });
    });
  });
});
