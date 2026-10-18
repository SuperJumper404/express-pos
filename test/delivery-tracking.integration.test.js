const assert = require("assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const { withDeliveryDatabase } = require("./helpers/deliveryDatabase");

async function main() {
  const { isCustomerCorsRequest } = require("../src/helpers/customerCors");
  assert.equal(isCustomerCorsRequest({ path: "/baseurl/api/v1/deliveries/41/tracking-token", headers: { cookie: "smarteat_customer=fixture" } }), true, "Owner tracking rotation must use personal CORS");
  await withDeliveryDatabase(async db => {
    await db.seedScenario();
    require.cache[require.resolve("../src/config/dbPool")] = { exports: db.pool };
    require.cache[require.resolve("../src/config/db")] = { exports: db.pool.pool };
    if (Number(process.versions.node.split(".")[0]) < 22) require.cache[require.resolve("nanoid")] = { exports: await import("nanoid") };
    const { buildDeliveryTracking } = require("../src/modules/m_deliveryTracking");
    const { hashTrackingToken } = require("../src/helpers/deliveryTrackingToken");
    let now = new Date("2026-10-18T12:00:00Z");
    const token = "a".repeat(43);
    const confirmationSecret = "b".repeat(64);
    await db.pool.query(`UPDATE deliveries SET tracking_token_hash=?,confirmation_secret_hash=?,
      created_at='2026-10-17 12:00:00', tracking_expires_at='2026-11-16 12:00:00',address_snapshot=? WHERE id=41`,
    [hashTrackingToken(token), hashTrackingToken(confirmationSecret), JSON.stringify({ street: "7 rue Test", postalCode: "75001", city: "Paris", country: "FR", instructions: "NEVER PUBLIC", intercom: "secret", complement: "private" })]);
    await db.pool.query("UPDATE orders SET subtotal_before_discount=12.50,discount_amount=0,status=1,payment_status='unpaid' WHERE id=31");
    await db.pool.query(`INSERT INTO delivery_charge_snapshots
      (shopid,delivery_id,revision,band_fee_cents,free_delivery_applied,fee_cents,total_excl_tax_cents,tax_cents,vat_rate,fiscal_policy)
      VALUES (7,41,1,0,0,0,0,0,10,'{"mode":"configured_rate","vatRate":10}')`);
    await db.pool.query("UPDATE users SET module_permissions='[\"delivery\"]' WHERE id=10");
    await db.pool.query("INSERT INTO orderdetail (orderid,productid,qty,price,total) VALUES (31,21,1,12.50,12.50)");
    await db.pool.query("UPDATE orders SET status=1 WHERE id=33");
    const tracking = buildDeliveryTracking({ clock: () => now });
    const { buildDeliveryController } = require("../src/controllers/c_delivery");
    const { buildDeliveryRouter } = require("../src/routers/r_delivery");
    const origin = "https://tracking.example.test";
    const app = express();
    app.use(require("../src/helpers/customerCors").buildCustomerCors({ allowedOrigins: [origin] }));
    app.use(express.json());
    // Actual global auth boundary and actual routers, as mounted by index.js.
    app.use(require("../src/helpers/middleware/auth").authenticationIfPresent);
    app.use(require("../src/routers/r_orders"));
    const { buildCustomerSession } = require("../src/helpers/customerSession");
    const sessions = buildCustomerSession({ clock: () => now, secret: "task16-independent-customer-secret-fixture-only", allowedOrigins: [origin] });
    const customerMiddleware = require("../src/helpers/middleware/customerAuth").buildCustomerMiddleware({ sessions });
    app.use(buildDeliveryRouter({ controller: buildDeliveryController({ tracking }), customerMiddleware }));
    const server = await new Promise(resolve => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (path, { body, bearer, method = body ? "POST" : "GET", headers = {} } = {}) => {
      const response = await fetch(base + path, { method, headers: { ...headers, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, headers: response.headers, body: response.headers.get("content-type").includes("application/json") ? await response.json() : null };
    };
    const sign = claims => jwt.sign(claims, require("../src/helpers/env").envJWTKEY);
    const staff = sign({ id: 10, shopid: 7, access: 0, subject_type: "staff" });
    const publicShop = sign({ subject_type: "service_point", shopid: 7, access: 0, service_point_id: 71, source: "click_collect" });
    const otherShop = sign({ subject_type: "service_point", shopid: 8, service_point_id: 81 });
    const read = value => request("/delivery/tracking/read", { body: { token: value } });
    const rotate = (key, options = {}) => request("/deliveries/41/tracking-token", { body: { idempotencyKey: key, ...options.body }, bearer: options.bearer });
    try {
      const missing = await read("z".repeat(43));
      assert.equal(missing.status, 404);
      assert.deepEqual((await read("FIXTURE-31")).body, missing.body);
      assert.equal(missing.headers.get("cache-control"), "no-store");
      assert.equal(missing.headers.get("referrer-policy"), "no-referrer");
      assert.equal((await request("/delivery/tracking/read?token=guessed")).status, 404);
      let view = (await read(token)).body.data;
      assert.equal(view.reference, "FIXTURE-31");
      assert.equal(view.stage, "received");
      assert.deepEqual(Object.keys(view).sort(), ["addressSnapshot", "payment", "reference", "restaurant", "stage"]);
      assert.deepEqual(Object.keys(view.addressSnapshot).sort(), ["city", "country", "postalCode", "street"]);
      assert.deepEqual(Object.keys(view.restaurant).sort(), ["address", "name", "phone"]);
      assert.deepEqual(view.payment, { status: "unpaid", totalCents: 1250, remainingDueCents: 1250 });
      assert.equal(JSON.stringify(view).includes("NEVER PUBLIC"), false);
      await db.pool.query("UPDATE orders SET status=3,payment_status='paid' WHERE id=31");
      assert.equal((await read(token)).body.data.stage, "ready");
      await db.pool.query("UPDATE deliveries SET courier_id=11,delivery_status='in_transit' WHERE id=41");
      assert.equal((await read(token)).body.data.stage, "in_delivery");
      assert.equal((await read(token)).body.data.courierId, undefined);
      const beforeReassign = (await read(token)).body.data;
      await db.pool.query(`INSERT INTO users (id,shopid,username,email,password,phone,access,status,created,clearpass)
        VALUES (13,7,'Other courier','13@example.test','not-a-login','',6,1,NOW(),'')`);
      await db.pool.query("UPDATE deliveries SET courier_id=13 WHERE id=41");
      assert.deepEqual((await read(token)).body.data, beforeReassign);
      await db.pool.query("UPDATE deliveries SET courier_id=11 WHERE id=41");
      console.log("PASS HTTP anonymous body-only tracking, explicit DTO, current payment/preparation");

      for (const path of ["/orders", "/ordersbyUserId?userId=10", "/orders/archives"]) {
        const result = await request(path, { bearer: publicShop });
        assert.equal(result.status, 200);
        assert.equal(result.body.data.some(row => row.delivery_id != null || row.fulfillment_type === "delivery"), false);
      }
      for (const path of ["/detailorder/31", "/orders/31/edit"]) assert.equal((await request(path, { bearer: publicShop })).status, 404);
      assert.equal((await request("/detailorder/33", { bearer: publicShop })).status, 200);
      assert.equal((await request("/detailorder/31", { bearer: staff })).status, 200);
      assert.equal((await request("/detailorder/31", { bearer: otherShop })).status, 404);
      assert.equal((await request("/orders/33/edit", { bearer: publicShop })).status, 200);
      await db.pool.query("UPDATE orders SET fulfillment_type='delivery' WHERE id=33");
      assert.equal((await request("/detailorder/33", { bearer: publicShop })).status, 404);
      assert.equal((await request("/orders/33/edit", { bearer: publicShop })).status, 404);
      assert.equal((await request("/orders", { bearer: publicShop })).body.data.length, 0);
      await db.pool.query("UPDATE orders SET fulfillment_type='takeaway' WHERE id=33");
      for (const role of [0, 1, 4, 5]) {
        await db.pool.query("UPDATE users SET access=? WHERE id=10", [role]);
        assert.equal((await request("/detailorder/31", { bearer: staff })).status, 200);
      }
      await db.pool.query("UPDATE users SET access=3 WHERE id=10");
      assert.equal((await request("/detailorder/31", { bearer: staff })).status, 404);
      await db.pool.query("UPDATE users SET access=6 WHERE id=10");
      assert.equal((await request("/detailorder/31", { bearer: staff })).status, 403);
      await db.pool.query("UPDATE users SET access=1 WHERE id=10");
      console.log("PASS HTTP+SQL bounded NEW-delivery legacy lists/details and current DB roles");

      const courier = { subject: "staff", id: 11, shopId: 7, access: 6 };
      await db.pool.query("UPDATE orders SET payment_status='unpaid' WHERE id=31");
      await require("../src/modules/m_deliveryCollections").buildDeliveryCollections({ clock: () => now }).collect({
        actor: courier, deliveryId: "41", method: "cash", expectedVersion: 1, idempotencyKey: "tracking-fixture-collection" });
      const payments = await db.readRows("SELECT * FROM payments");
      assert.equal(payments[0].amount_cents, 1250);
      assert.equal(payments[0].status, "succeeded");
      const collections = await db.readRows("SELECT * FROM delivery_payment_collections");
      const privateCheckoutContext = { clientOrderToken: "fixture-checkout", confirmationSecret };
      assert.equal((await rotate("public-rotate", { bearer: publicShop })).status, 404);
      assert.equal((await rotate("guessed", { body: { orderNumber: "FIXTURE-31", phone: "0700000000" } })).status, 404);
      assert.equal((await rotate("bad-secret", { body: { privateCheckoutContext: { ...privateCheckoutContext, confirmationSecret: "x".repeat(64) } } })).status, 404);
      const rotated = await rotate("private-rotate", { body: { privateCheckoutContext } });
      assert.equal(rotated.status, 200);
      assert.equal(/^\/livraison\/suivi#[A-Za-z0-9_-]{43}$/.test(rotated.body.data.trackingUrl), true);
      const newToken = new URL(rotated.body.data.trackingUrl, base).hash.slice(1);
      assert.equal((await read(token)).status, 404);
      assert.equal((await read(newToken)).status, 200);
      const hashes = await db.readRows("SELECT tracking_token_hash,tracking_expires_at FROM deliveries WHERE id=41");
      const replay = await rotate("private-rotate", { body: { privateCheckoutContext } });
      assert.equal(replay.status, 200);
      assert.deepEqual(await db.readRows("SELECT tracking_token_hash,tracking_expires_at FROM deliveries WHERE id=41"), hashes);
      assert.equal((await read(newToken)).status, 200);
      assert.deepEqual(await db.readRows("SELECT * FROM payments"), payments);
      assert.deepEqual(await db.readRows("SELECT * FROM delivery_payment_collections"), collections);
      const events = await db.readRows("SELECT * FROM delivery_events WHERE event_type='tracking_rotated'");
      assert.equal(events.length, 1);
      assert.equal(JSON.stringify(events).includes(newToken), false);
      assert.equal(JSON.stringify(events).includes(confirmationSecret), false);
      assert.equal((await rotate("operator-rotate", { bearer: staff })).status, 200);
      await db.pool.query(`INSERT INTO customer_otp_challenges (id,shopid,purpose,channel,destination,code_hash,browser_binding_hash,
        send_status,expires_at,verified_at,consumed_at,verified_customer_id)
        VALUES (901,7,'login','email','fixture@example.test',REPEAT('a',64),REPEAT('b',64),'sent','2026-10-19 12:00:00','2026-10-18 12:00:00','2026-10-18 12:00:00',51)`);
      const session = await sessions.create({ shopId: 7, customerId: "51", verifiedChallengeId: "901" });
      const ownerHeaders = { Cookie: `smarteat_customer=${session.rawToken}`, Origin: origin, "X-CSRF-Token": session.csrfToken };
      const ownerRotate = (key, headers = ownerHeaders) => request("/deliveries/41/tracking-token?shopId=7", { body: { idempotencyKey: key }, headers });
      const preflight = await fetch(base + "/deliveries/41/tracking-token?shopId=7", { method: "OPTIONS", headers: { Origin: origin,
        "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Content-Type, X-CSRF-Token" } });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
      assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
      for (const badOrigin of ["https://untrusted.example.test", "null"]) {
        const denied = await ownerRotate("bad-origin", { ...ownerHeaders, Origin: badOrigin });
        assert.equal(denied.status, 403);
        assert.equal(denied.headers.get("access-control-allow-origin"), null);
      }
      // Match the real application's prefix mount and parsed-path CORS behavior.
      const prefixed = express();
      prefixed.use(require("../src/helpers/customerCors").buildCustomerCors({ allowedOrigins: [origin] }));
      prefixed.use("/baseurl/api/v1", (req, res) => res.status(204).end());
      const prefixServer = await new Promise(resolve => { const value = prefixed.listen(0, "127.0.0.1", () => resolve(value)); });
      try {
        const prefixUrl = `http://127.0.0.1:${prefixServer.address().port}/baseurl/api/v1`;
        const headers = { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Content-Type, X-CSRF-Token" };
        const allowed = await fetch(prefixUrl + "/deliveries/41/tracking-token?shopId=7", { method: "OPTIONS", headers });
        assert.equal(allowed.status, 204);
        assert.equal(allowed.headers.get("access-control-allow-origin"), origin);
        assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");
        const refused = await fetch(prefixUrl + "/deliveries/41/tracking-token", { method: "OPTIONS", headers: { ...headers, Origin: "https://untrusted.example.test" } });
        assert.equal(refused.status, 403);
        for (const path of ["/delivery/tracking/read", "/deliveries/41/tracking-token/extra", "/deliveries/not-decimal/tracking-token"]) {
          const unrelated = await fetch(prefixUrl + path, { method: "OPTIONS", headers });
          assert.equal(unrelated.headers.get("access-control-allow-credentials"), null);
          assert.equal(unrelated.headers.get("access-control-allow-origin"), null);
        }
      } finally { await new Promise(resolve => prefixServer.close(resolve)); }
      assert.equal((await ownerRotate("unlinked-customer")).status, 404);
      await db.pool.query("UPDATE deliveries SET customer_account_id=51 WHERE id=41");
      assert.equal((await ownerRotate("owner-rotate", { ...ownerHeaders, "X-CSRF-Token": "a".repeat(64) })).status, 403);
      const ownedRotation = await ownerRotate("owner-rotate");
      assert.equal(ownedRotation.status, 200);
      assert.equal(ownedRotation.headers.get("access-control-allow-credentials"), "true");
      await sessions.revoke({ rawToken: session.rawToken, shopId: 7 });
      assert.equal((await ownerRotate("revoked-owner")).status, 401);
      assert.deepEqual(await db.readRows("SELECT * FROM payments"), payments);
      console.log("PASS SQL authorized explicit rotation, hash-only journal and nonrotating idempotent replay");

      // Archived ID and product shop deliberately differ: joins cannot override tenant identity.
      const dispatch = require("../src/modules/m_deliveryDispatch").buildDeliveryDispatch({ clock: () => now });
      const actor = { subject: "staff", id: 10, shopId: 7, access: 0 };
      const beforeTerminal = (await db.readRows("SELECT version FROM deliveries WHERE id=41"))[0];
      const delivered = await dispatch.deliver({ actor: courier, deliveryId: "41", expectedVersion: beforeTerminal.version, idempotencyKey: "tracking-fixture-deliver" });
      const terminalVersion = delivered.version;
      await db.pool.query("UPDATE deliveries SET tracking_token_hash=? WHERE id=41", [hashTrackingToken(token)]);
      view = (await read(token)).body.data;
      await require("../src/modules/m_orders").mArchiveOrder(31, undefined, 7);
      const [archive] = await db.readRows("SELECT id FROM archives WHERE delivery_id=41");
      assert.deepEqual((await read(token)).body.data, view);
      assert.equal((await request(`/detailorder/archive/${archive.id}`, { bearer: publicShop })).status, 404);
      assert.equal((await request(`/detailorder/archive/${archive.id}`, { bearer: otherShop })).status, 404);
      await db.pool.query("UPDATE users SET access=0 WHERE id=12");
      const foreignStaff = sign({ id: 12, shopid: 8, access: 0, subject_type: "staff" });
      const refusedForeign = await request(`/detailorder/archive/${archive.id}`, { bearer: foreignStaff });
      assert.equal(refusedForeign.status, 404);
      assert.deepEqual(refusedForeign.body, (await request("/detailorder/archive/999999999", { bearer: foreignStaff })).body);
      await db.pool.query("UPDATE users SET access=6 WHERE id=12");
      assert.equal((await request(`/detailorder/archive/${archive.id}`, { bearer: staff })).status, 200);
      assert.equal((await request("/orders/archives", { bearer: publicShop })).body.data.some(row => row.delivery_id != null), false);
      assert.equal((await request("/orders/archives", { bearer: staff })).body.data.some(row => row.delivery_id != null), true);
      const [receipt] = await db.readRows("SELECT token FROM archives WHERE delivery_id=41");
      assert.equal((await request(`/orderbytoken/${receipt.token}`)).status, 200);
      await db.pool.query(`INSERT INTO products (id,shopid,name,categoryid,price,stock,image,created)
        VALUES (22,8,'FOREIGN PRIVATE PRODUCT',20,12.50,20,'',NOW())`);
      await db.pool.query("UPDATE archivesdetail SET productid=22 WHERE orderid=?", [archive.id]);
      const safeArchive = await request(`/detailorder/archive/${archive.id}`, { bearer: staff });
      assert.equal(safeArchive.status, 200);
      assert.equal(safeArchive.body.data[0].shopid, 7);
      assert.equal(JSON.stringify(safeArchive.body).includes("FOREIGN PRIVATE PRODUCT"), false);
      assert.equal((await request("/detailorder/archive/32", { bearer: publicShop })).status, 200);
      await db.pool.query("UPDATE archives SET payment_status='refunded' WHERE delivery_id=41");
      assert.equal((await read(token)).body.data.payment.status, "refunded");
      // Consume the approved correction producer, including repeated archived correction/reclose.
      await assert.rejects(dispatch.correctTerminal({ actor, deliveryId: "41", expectedVersion: terminalVersion, idempotencyKey: "forged-admin-after-terminal", reason: "Current DB role still cashier" }), { status: 403 });
      await db.pool.query("UPDATE users SET access=0 WHERE id=10");
      now = new Date("2026-10-25T12:00:00Z");
      assert.equal((await read(token)).status, 404);
      now = new Date("2026-10-18T12:00:00Z");
      await tracking.rotate({ actor, deliveryId: "41", idempotencyKey: "terminal-rotation" });
      await dispatch.correctTerminal({ actor, deliveryId: "41", expectedVersion: terminalVersion + 1, idempotencyKey: "tracking-correct", reason: "Fixture correction" });
      now = new Date("2026-10-19T12:00:00Z");
      await dispatch.resolveIssue({ actor, deliveryId: "41", expectedVersion: terminalVersion + 2, idempotencyKey: "tracking-reclose", action: "fail", reason: "Fixture fail" });
      await dispatch.correctTerminal({ actor, deliveryId: "41", expectedVersion: terminalVersion + 3, idempotencyKey: "tracking-correct-again", reason: "Fixture correction again" });
      await db.pool.query("UPDATE deliveries SET tracking_token_hash=?,tracking_expires_at='2026-11-16 12:00:00' WHERE id=41", [hashTrackingToken(token)]);
      now = new Date("2026-10-25T11:59:59Z");
      assert.equal((await read(token)).status, 200);
      const last = await tracking.rotate({ actor, deliveryId: "41", idempotencyKey: "last-second" });
      now = new Date("2026-10-25T12:00:00Z");
      assert.equal((await read(token)).status, 404);
      await assert.rejects(tracking.read({ token: new URL(last.trackingUrl, base).hash.slice(1) }), { status: 404 });
      await assert.rejects(tracking.rotate({ actor, deliveryId: "41", idempotencyKey: "too-late" }), { status: 404 });
      assert.equal((await db.readRows("SELECT tracking_expires_at FROM deliveries WHERE id=41"))[0].tracking_expires_at.getTime(), new Date("2026-10-25T12:00:00Z").getTime());
      await db.pool.query(`INSERT INTO deliveries (id,shopid,origin_order_id,order_reference,address_snapshot,contact_snapshot,latitude,longitude,distance_meters,
        settings_revision,client_order_token,confirmation_secret_hash,tracking_token_hash,tracking_expires_at,created_at)
        SELECT 42,7,33,'FIXTURE-33',address_snapshot,contact_snapshot,latitude,longitude,distance_meters,1,'tracking-open-fixture',
        confirmation_secret_hash,?,'2026-11-17 12:00:00','2026-10-17 12:00:00' FROM deliveries WHERE id=41`, [hashTrackingToken(token)]);
      await db.pool.query("UPDATE orders SET delivery_id=42,fulfillment_type='delivery',subtotal_before_discount=12.50,discount_amount=0 WHERE id=33");
      await db.pool.query(`INSERT INTO delivery_charge_snapshots (shopid,delivery_id,revision,band_fee_cents,free_delivery_applied,fee_cents,total_excl_tax_cents,tax_cents,vat_rate,fiscal_policy)
        SELECT shopid,42,revision,band_fee_cents,free_delivery_applied,fee_cents,total_excl_tax_cents,tax_cents,vat_rate,fiscal_policy FROM delivery_charge_snapshots WHERE delivery_id=41`);
      now = new Date("2026-11-16T11:59:59Z");
      assert.equal((await read(token)).status, 200);
      now = new Date("2026-11-16T12:00:00Z");
      assert.equal((await read(token)).status, 404);
      await db.pool.query("UPDATE deliveries SET tracking_expires_at='2026-10-20 12:00:00' WHERE id=42");
      now = new Date("2026-10-20T12:00:00Z");
      assert.equal((await read(token)).status, 404);
      const fixtureUrl = new URL(process.env.DELIVERY_TEST_DATABASE_URL);
      const skewPool = require("mysql2/promise").createPool({ host: fixtureUrl.hostname, port: Number(fixtureUrl.port), user: decodeURIComponent(fixtureUrl.username),
        password: decodeURIComponent(fixtureUrl.password), database: db.database, timezone: "-07:00", supportBigNumbers: true, bigNumberStrings: true });
      const poolPath = require.resolve("../src/config/dbPool");
      const ordersPath = require.resolve("../src/modules/m_deliveryOrders");
      const trackingPath = require.resolve("../src/modules/m_deliveryTracking");
      const transactionPath = require.resolve("../src/helpers/withTransaction");
      const saved = [poolPath, ordersPath, trackingPath, transactionPath].map(key => require.cache[key]);
      try {
        require.cache[poolPath] = { exports: skewPool }; delete require.cache[ordersPath]; delete require.cache[trackingPath]; delete require.cache[transactionPath];
        const skewTracking = require(trackingPath).buildDeliveryTracking({ clock: () => new Date("2026-10-20T12:00:00Z") });
        await assert.rejects(skewTracking.read({ token }), { status: 404 }, "SQL UTC expiry must not be extended by the production driver's local timezone");
      } finally {
        [poolPath, ordersPath, trackingPath, transactionPath].forEach((key, index) => { require.cache[key] = saved[index]; });
        await skewPool.end();
      }
      const blocker = await db.pool.getConnection();
      const originalGetConnection = db.pool.getConnection.bind(db.pool);
      let atShopLock;
      const reachedShopLock = new Promise(resolve => { atShopLock = resolve; });
      try {
        await blocker.beginTransaction();
        await blocker.query("SELECT id FROM shop WHERE id=7 FOR UPDATE");
        db.pool.getConnection = async () => {
          const connection = await originalGetConnection();
          const originalQuery = connection.query.bind(connection);
          connection.query = (sql, values) => {
            if (sql === "SELECT id FROM shop WHERE id=? FOR UPDATE") atShopLock();
            return originalQuery(sql, values);
          };
          return connection;
        };
        const waiting = tracking.rotate({ actor, deliveryId: "41", idempotencyKey: "shortened-while-waiting" });
        const outcome = waiting.then(value => ({ value }), error => ({ error }));
        await reachedShopLock;
        await blocker.query("UPDATE deliveries SET tracking_expires_at='2026-10-20 12:00:00' WHERE id=41");
        await blocker.commit();
        const result = await outcome;
        assert.equal(result.error && result.error.status, 404, "A waiting rotation must use the current shortened stored expiry");
      } finally { db.pool.getConnection = originalGetConnection; await blocker.rollback(); blocker.release(); }
      await db.pool.query("UPDATE deliveries SET version=3,courier_id=11,delivery_status='delivered',closed_at='2026-10-18 12:00:00' WHERE id=42");
      const terminal = { deliveryStatus: "delivered", courierId: 11, closedAt: "2026-10-18T12:00:00.000Z" };
      await db.pool.query(`INSERT INTO delivery_events (shopid,delivery_id,version,event_type,actor_subject,actor_id,
        previous_state,next_state,idempotency_key,request_hash,result) VALUES
        (7,42,1,'deliver','staff','11',?,?,'gap-terminal-fixture',REPEAT('a',64),'{}'),
        (7,42,3,'tracking_rotated','staff','10',?,?,'gap-rotation-fixture',REPEAT('a',64),'{}')`,
      [JSON.stringify({ deliveryStatus: "in_transit", courierId: 11, closedAt: null }), JSON.stringify(terminal), JSON.stringify(terminal), JSON.stringify(terminal)]);
      await assert.rejects(dispatch.correctTerminal({ actor, deliveryId: "42", expectedVersion: 3, idempotencyKey: "gap-correction", reason: "No invented history" }), { code: "DELIVERY_TERMINAL_HISTORY_REQUIRED" });
      console.log("PASS SQL archive continuity/current refund and immutable earliest correction/30d expiry");
      // Fresh router with tiny injected read quota, actual HTTP: XFF cannot evade req.ip.
      const limited = express(); limited.use(express.json());
      limited.use(buildDeliveryRouter({ controller: buildDeliveryController({ tracking }), readLimit: 1 }));
      const quotaServer = await new Promise(resolve => { const value = limited.listen(0, "127.0.0.1", () => resolve(value)); });
      try {
        const endpoint = `http://127.0.0.1:${quotaServer.address().port}/delivery/tracking/read`;
        await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        const blocked = await fetch(endpoint, { method: "POST", headers: { "X-Forwarded-For": "192.0.2.9", "Content-Type": "application/json" }, body: "{}" });
        assert.equal(blocked.status, 429);
        assert.equal(blocked.headers.get("cache-control"), "no-store");
      } finally { await new Promise(resolve => quotaServer.close(resolve)); }
      console.log("PASS HTTP bounded IP quota including invalid tokens and untrusted forwarded IP");
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
