const assert = require("assert/strict");
const { test } = require("node:test");
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const express = require("express");
const jwt = require("jsonwebtoken");
const { withDeliveryDatabase } = require("./helpers/deliveryDatabase");
const { buildDeliveryTokenCodec, signAddressResolution, validateAddressResolution } = require("../src/helpers/deliveryAddress");
const codec = buildDeliveryTokenCodec({ secret: "task8-disposable-signing-fixture-only" });
const postal = { street: "7 rue de l'\u00c9cole", postalCode: "75001", city: "Paris", country: "FR",
  complement: "B", building: "A", floor: "2", intercom: "Test", instructions: "Ancien interphone",
  latitude: 48.8566, longitude: 2.3522, provider: "IGN", providerId: "fixture-7", precision: "housenumber" };

test("customer SQL services, staff HTTP and legacy isolation", async t => {
  await withDeliveryDatabase(async db => {
    await db.seedScenario();
    // Never load a real environment file or connect a handler to the application database.
    process.env.ENV_FILE = path.join(__dirname, "task8-nonexistent.env");
    process.env.JWTKEY = "task8-local-jwt-fixture-only";
    require.cache[require.resolve("../src/config/dbPool")] = { exports: db.pool };
    const { createTransactionRunner } = require("../src/helpers/withTransaction");
    const { buildCustomers, buildSqlCustomersRepository } = require("../src/modules/m_customers");
    let now = new Date("2026-10-17T12:00:00Z");
    const service = buildCustomers({ repository: buildSqlCustomersRepository({ pool: db.pool }),
      runInTransaction: createTransactionRunner(db.pool), clock: () => now, tokenCodec: codec });
    const input = (extra = {}) => ({ shopId: 7, customerId: "51", addressResolutionToken: signAddressResolution({ shopId: 7, addressSnapshot: postal, now, tokenCodec: codec }), ...extra });
    let first;
    await t.test("monotone labels, one default pointer, concurrent changes and oldest fallback", async () => {
      first = await service.saveAddress(input({ makeDefault: true }));
      const second = await service.saveAddress(input());
      const third = await service.saveAddress(input());
      assert.deepEqual([first.label, second.label, third.label], ["Adresse 1", "Adresse 2", "Adresse 3"]);
      await service.deleteAddress({ shopId: 7, customerId: "51", addressId: second.id });
      const fourth = await service.saveAddress(input());
      assert.equal(fourth.label, "Adresse 4");
      await Promise.all([third, fourth].map(address => service.saveAddress(input({ addressId: address.id, makeDefault: true }))));
      let addresses = await service.listAddresses({ shopId: 7, customerId: "51" });
      assert.equal(addresses.filter(address => address.isDefault).length, 1);
      assert.deepEqual(addresses.map(address => address.label), ["Adresse 1", "Adresse 3", "Adresse 4"]);
      await service.deleteAddress({ shopId: 7, customerId: "51", addressId: addresses.find(address => address.isDefault).id });
      addresses = await service.listAddresses({ shopId: 7, customerId: "51" });
      assert.equal(addresses.find(address => address.isDefault).id, first.id);
      const parallel = await Promise.all([service.saveAddress(input()), service.saveAddress(input())]);
      assert.deepEqual(parallel.map(address => address.label).sort(), ["Adresse 5", "Adresse 6"]);
    });
    await t.test("ownership checks and SQL composite relations reject cross-shop/customer access", async () => {
      for (const scope of [{ shopId: 8, customerId: "51" }, { shopId: 7, customerId: "52" }]) {
        await assert.rejects(service.listAddresses(scope), { code: "CUSTOMER_NOT_FOUND" });
        for (const method of ["saveAddress", "deleteAddress", "resolveStoredAddress"]) {
          await assert.rejects(service[method]({ ...input(), ...scope, addressId: first.id }), { code: "CUSTOMER_NOT_FOUND" });
        }
      }
      const other = await service.createProfile({ shopId: 7, name: "Other" });
      for (const method of ["saveAddress", "deleteAddress", "resolveStoredAddress"]) {
        await assert.rejects(service[method]({ ...input(), customerId: other.id, addressId: first.id }), { code: "CUSTOMER_ADDRESS_NOT_FOUND" });
      }
      await assert.rejects(db.pool.query("UPDATE customers SET default_address_id = ? WHERE id = ?", [first.id, other.id]), { code: "ER_NO_REFERENCED_ROW_2" });
      for (const table of ["orders", "archives", "deliveries"]) {
        await assert.rejects(db.pool.query(`UPDATE ${table} SET customer_account_id = '52' WHERE shopid = 7`), { code: "ER_NO_REFERENCED_ROW_2" });
      }
      await db.pool.query("UPDATE deliveries SET customer_account_id = '51', address_snapshot = ? WHERE id = '41'", [JSON.stringify(postal)]);
      await db.pool.query("UPDATE orders SET customer_account_id = '51' WHERE id = 31");
      await db.pool.query("UPDATE archives SET customer_account_id = '51' WHERE id = 32");
    });
    await t.test("expired stored proof renews during provider outage without IGN or client coordinates; snapshots stay immutable", async () => {
      const expired = input().addressResolutionToken;
      now = new Date("2026-10-17T12:16:00Z");
      await assert.rejects(service.saveAddress(input({ addressResolutionToken: expired })), { code: "DELIVERY_ADDRESS_INVALID" });
      const transports = [require("http"), require("https")];
      const originals = transports.map(transport => ({ get: transport.get, request: transport.request }));
      let calls = 0;
      for (const transport of transports) for (const method of ["get", "request"]) transport[method] = () => { calls++; throw new Error("provider offline"); };
      try {
        let resolved = await service.resolveStoredAddress({ shopId: 7, customerId: "51", addressId: first.id });
        assert.equal(resolved.expiresAt, "2026-10-17T12:31:00.000Z");
        assert.deepEqual(validateAddressResolution(resolved.addressResolutionToken, now, { tokenCodec: codec, shopId: 7 }), postal);
        assert.throws(() => validateAddressResolution(resolved.addressResolutionToken, new Date("2026-10-17T12:31:00Z"), { tokenCodec: codec, shopId: 7 }), { code: "DELIVERY_ADDRESS_INVALID" });
        await service.saveAddress({ shopId: 7, customerId: "51", addressId: first.id, complement: "Appartement C", instructions: "Nouveau interphone" });
        resolved = await service.resolveStoredAddress({ shopId: 7, customerId: "51", addressId: first.id });
        assert.equal(resolved.addressSnapshot.instructions, "Nouveau interphone");
        assert.equal(resolved.addressSnapshot.complement, "Appartement C");
        assert.equal(resolved.addressSnapshot.providerId, "fixture-7");
        assert.equal(resolved.addressSnapshot.latitude, 48.8566);
        const stored = (await db.readRows("SELECT address_snapshot FROM deliveries WHERE id = '41'"))[0].address_snapshot;
        assert.deepEqual(typeof stored === "string" ? JSON.parse(stored) : stored, postal);
        assert.equal(calls, 0);
      } finally { transports.forEach((transport, index) => Object.assign(transport, originals[index])); }
      await assert.rejects(service.saveAddress({ shopId: 7, customerId: "51", complement: "Unresolved new address" }), { code: "DELIVERY_ADDRESS_INVALID" });
      for (const method of ["resolveStoredAddress", "deleteAddress"]) await assert.rejects(service[method]({ shopId: 7, customerId: "51", addressId: "999999" }), { code: "CUSTOMER_ADDRESS_NOT_FOUND" });
      const changed = await service.saveAddress(input({ addressId: first.id, addressResolutionToken: signAddressResolution({ shopId: 7, addressSnapshot: { ...postal, street: "9 rue Test", providerId: "fixture-9" }, now, tokenCodec: codec }) }));
      assert.equal(changed.addressSnapshot.street, "9 rue Test");
      await assert.rejects(service.saveAddress(input({ addressResolutionToken: signAddressResolution({ shopId: 8, addressSnapshot: postal, now, tokenCodec: codec }) })), { code: "DELIVERY_ADDRESS_INVALID" });
    });
    await t.test("profile contacts never claim identity or historical phone groups and search is tenant bounded", async () => {
      const profile = await service.createProfile({ shopId: 7, name: "\u00c9lodie", contactPhone: "06 12 34 56 78", contactEmail: "Contact@example.test" });
      assert.equal(typeof profile.id, "string");
      assert.equal((await db.readRows("SELECT id FROM customer_identities")).length, 0);
      const matches = await service.searchProfiles({ shopId: 7, query: "06 12 34" });
      assert.deepEqual(matches.map(row => row.id), [profile.id]);
      assert.deepEqual(await service.searchProfiles({ shopId: 8, query: "06 12 34" }), []);
      assert.equal((await db.readRows("SELECT customer_account_id FROM archives WHERE id = 32"))[0].customer_account_id, "51");
      const { buildArchivedClientRows } = require("../../pos-app/helpers/clients");
      const rows = buildArchivedClientRows([{ phone: "06 12 34 56 78", customer: "Historical", subtotal: "12.50", created: "2026-10-16T12:00:00Z" },
        { phone: "0612345678", customer: "Historical", subtotal: "2.50", created: "2026-10-16T13:00:00Z" }]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].totalSpent, 15);
      assert.equal(rows[0].orderCount, 2);
    });
    await t.test("BIGINT round trips are exact with production mysql2 numeric defaults", async () => {
      const url = new URL(process.env.DELIVERY_TEST_DATABASE_URL);
      const driver = mysql.createPool({ host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: db.database, charset: "utf8mb4", timezone: "Z", connectionLimit: 2 });
      try {
        const precise = buildCustomers({ repository: buildSqlCustomersRepository({ pool: driver }), runInTransaction: createTransactionRunner(driver), clock: () => now, tokenCodec: codec });
        await db.pool.query("ALTER TABLE customers AUTO_INCREMENT = 9007199254740993");
        const profile = await precise.createProfile({ shopId: 7, name: "Large ID" });
        assert.equal(profile.id, "9007199254740993");
        await db.pool.query("ALTER TABLE customer_addresses AUTO_INCREMENT = 9007199254740993");
        const address = await precise.saveAddress(input({ customerId: profile.id }));
        assert.equal(address.id, "9007199254740993");
        assert.equal(address.customerId, "9007199254740993");
        assert.equal((await precise.listAddresses({ shopId: 7, customerId: profile.id }))[0].id, address.id);
      } finally { await driver.end(); }
    });
    await t.test("SQL identity uniqueness preserves local case, dots and aliases while normalized domains collide", async () => {
      const { normalizeCustomerDestination } = require("../src/helpers/customerIdentity");
      const identity = (shopId, customerId, value) => db.pool.query(`INSERT INTO customer_identities (shopid,customer_id,channel,destination,verified_at) VALUES (?,?,'email',?,UTC_TIMESTAMP())`, [shopId, customerId, normalizeCustomerDestination({ channel: "email", value })]);
      for (const value of ["Alice.Name+shop@EXAMPLE.COM", "alice.Name+shop@example.com", "AliceName+shop@example.com", "Alice.Name@example.com", "Alice@b\u00fccher.de"]) await identity(7, "51", value);
      await assert.rejects(identity(7, "51", "Alice.Name+shop@example.COM"), { code: "ER_DUP_ENTRY" });
      await assert.rejects(identity(7, "51", "Alice@xn--bcher-kva.DE"), { code: "ER_DUP_ENTRY" });
      await identity(8, "52", "Alice.Name+shop@example.com");
      const found = await db.readRows("SELECT destination FROM customer_identities WHERE shopid = 7 AND channel = 'email' AND destination = ?", ["alice.Name+shop@example.com"]);
      assert.deepEqual(found.map(row => row.destination), ["alice.Name+shop@example.com"]);
      await assert.rejects(identity(8, "51", "wrong@example.test"), { code: "ER_NO_REFERENCED_ROW_2" });
    });
    await t.test("future OTP/session contracts persist purpose, browser binding, send lifecycle and one challenge per session", async () => {
      const insert = (id, extra = {}) => db.pool.query(`INSERT INTO customer_otp_challenges
        (id,shopid,customer_id,purpose,channel,destination,code_hash,browser_binding_hash,send_status,expires_at,verified_customer_id,verified_at,consumed_at)
        VALUES (?,7,? ,?,'email','fixture@example.test',REPEAT('a',64),REPEAT('b',64),?, '2026-10-17 12:10:00',?,?,?)`,
      [id, extra.customerId || null, extra.purpose || "login", extra.sendStatus || "pending", extra.verifiedCustomerId || null, extra.verifiedAt || null, extra.consumedAt || null]);
      await insert("61");
      await insert("62", { customerId: "51", purpose: "link", sendStatus: "failed" });
      await assert.rejects(insert("63", { purpose: "link" }), { errno: 3819 });
      await db.pool.query("UPDATE customer_otp_challenges SET send_status='sent', sent_at=UTC_TIMESTAMP(), verified_customer_id='51', verified_at=UTC_TIMESTAMP(), consumed_at=UTC_TIMESTAMP() WHERE id='61'");
      await db.pool.query(`INSERT INTO customer_sessions (shopid,customer_id,verified_challenge_id,token_hash,csrf_secret_hash,expires_at) VALUES (7,'51','61',REPEAT('c',64),REPEAT('d',64),'2026-11-16 12:00:00')`);
      await assert.rejects(db.pool.query(`INSERT INTO customer_sessions (shopid,customer_id,verified_challenge_id,token_hash,csrf_secret_hash,expires_at) VALUES (7,'51','61',REPEAT('e',64),REPEAT('f',64),'2026-11-16 12:00:00')`), { code: "ER_DUP_ENTRY" });
      await assert.rejects(db.pool.query("UPDATE customer_sessions SET customer_id='52'"), { code: "ER_NO_REFERENCED_ROW_2" });
      await assert.rejects(db.pool.query("UPDATE customer_otp_challenges SET attempts=6 WHERE id='62'"), { errno: 3819 });
      for (const scope of ["customer_otp_contact", "customer_otp_ip", "customer_otp_verify", "customer_otp_resend"]) {
        for (let i = 0; i < 2; i++) await db.pool.query(`INSERT INTO service_rate_limits (shopid,scope,subject_hash,window_start,expires_at,attempts) VALUES (7,?,REPEAT('a',64),'2026-10-17 12:00:00','2026-10-17 13:00:00',1) ON DUPLICATE KEY UPDATE attempts=attempts+1`, [scope]);
      }
      assert.deepEqual((await db.readRows("SELECT attempts FROM service_rate_limits WHERE scope LIKE 'customer_%'")).map(row => row.attempts), [2, 2, 2, 2]);
    });
    await t.test("actual staff HTTP reloads active 0/1 delivery permission, refuses forged scopes and mounts no personal APIs", async () => {
      const { buildCustomersController } = require("../src/controllers/c_customers");
      const { buildCustomersRouter } = require("../src/routers/r_customers");
      const app = express();
      app.use(express.json());
      app.use("/baseurl/api/v1", buildCustomersRouter({ controller: buildCustomersController({ customers: service }) }));
      const server = app.listen(0, "127.0.0.1");
      await new Promise(resolve => server.once("listening", resolve));
      const http = async (route, { id = 10, shopid = 7, method = "GET", body, anonymous = false, claims = {} } = {}) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/baseurl/api/v1${route}`, { method,
          headers: { "content-type": "application/json", ...(anonymous ? {} : { authorization: `Bearer ${jwt.sign({ id, shopid, access: 0, ...claims }, process.env.JWTKEY)}` }) },
          body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await response.text();
        return { status: response.status, body: text.startsWith("{") ? JSON.parse(text) : null, cache: response.headers.get("cache-control"), cookie: response.headers.get("set-cookie") };
      };
      try {
        const base = "/delivery/customers";
        assert.equal((await http(base, { anonymous: true })).status, 401);
        await db.pool.query("UPDATE users SET module_permissions='[\"delivery\"]' WHERE id=10");
        assert.equal((await http(base + "?q=Other")).status, 200);
        const created = await http(base, { method: "POST", body: { name: "Staff contact", contactPhone: "unverified" } });
        assert.equal(created.status, 200);
        const ownId = created.body.data.id;
        assert.equal(created.cookie, null);
        assert.equal(created.cache, "no-store");
        assert.equal((await http(`${base}/${ownId}/addresses`)).status, 200);
        let result = await http(`${base}/${ownId}/addresses`, { method: "POST", body: { addressResolutionToken: input().addressResolutionToken, makeDefault: true } });
        assert.equal(result.status, 200);
        const addressId = result.body.data.id;
        result = await http(`${base}/${ownId}/addresses/${addressId}/resolve`, { method: "POST", body: {} });
        assert.equal(result.status, 200);
        assert.equal(validateAddressResolution(result.body.data.addressResolutionToken, now, { shopId: 7, tokenCodec: codec }).latitude, 48.8566);
        assert.equal((await http(`${base}/${ownId}/addresses/${addressId}`, { method: "PATCH", body: { instructions: "Updated" } })).status, 200);
        assert.equal((await http(`${base}/${ownId}/addresses/${addressId}/resolve`, { method: "POST", body: { latitude: 0 } })).status, 400);
        assert.equal((await http(`${base}/${ownId}/addresses/${addressId}`, { method: "PATCH", body: { shopId: 8, customerId: "52", latitude: 0 } })).status, 400);
        assert.equal((await http(`${base}/52/addresses`)).status, 404);
        assert.equal((await http(`${base}/${ownId}/addresses/${addressId}`, { method: "DELETE" })).status, 200);
        assert.equal((await http(`${base}/${ownId}/addresses`)).body.data.length, 0);
        for (const state of [{ access: 1, status: 1, permissions: "[]" }, { access: 0, status: 0, permissions: "[]" }, { access: null, status: 1, permissions: '["delivery"]' },
          ...[2, 4, 5, 6].map(access => ({ access, status: 1, permissions: '["delivery"]' }))]) {
          await db.pool.query("UPDATE users SET access=?,status=?,module_permissions=? WHERE id=10", [state.access, state.status, state.permissions]);
          assert.equal((await http(base)).status, 403);
        }
        await db.pool.query("UPDATE users SET access=0,status=1,module_permissions=NULL WHERE id=10");
        assert.equal((await http(base)).status, 200);
        assert.equal((await http(base, { claims: { subject_type: "service_point", service_point_id: 701 } })).status, 403);
        assert.equal((await http(base, { claims: { subject_type: "customer" } })).status, 403);
        for (const route of ["/customer/addresses", "/customer-auth/session"]) assert.equal((await http(route, { anonymous: true })).status, 401);
        assert.equal((await http("/customers?phone=0612345678", { anonymous: true })).status, 404);
      } finally { await new Promise(resolve => server.close(resolve)); }
    });
    await t.test("deleting the last address clears the pointer and never resets numbering", async () => {
      for (const address of await service.listAddresses({ shopId: 7, customerId: "51" })) await service.deleteAddress({ shopId: 7, customerId: "51", addressId: address.id });
      assert.deepEqual(await service.listAddresses({ shopId: 7, customerId: "51" }), []);
      assert.equal((await db.readRows("SELECT default_address_id FROM customers WHERE id='51'"))[0].default_address_id, null);
      assert.equal((await service.saveAddress(input())).label, "Adresse 7");
    });
  });
});

test("customer migration alone up/down/up preserves legacy rows and Task7 schema", async () => {
  await withDeliveryDatabase(async db => {
    const source = fs.readFileSync(path.join(__dirname, "../db/migrations/20261016130000_delivery_customers.sql"), "utf8").split(/^-- migrate:(?:up|down)\s*$/m);
    const before = await db.readRows("SELECT id,customer,customerID,subtotal FROM archives WHERE id=32");
    assert.deepEqual(await db.readRows("SELECT id FROM customers"), []);
    await db.pool.query("INSERT INTO customers (id,shopid,name) VALUES ('51',7,'Rollback fixture')");
    await db.pool.query("INSERT INTO customer_addresses (id,shopid,customer_id,label_number,address_snapshot) VALUES ('71',7,'51',1,?)", [JSON.stringify(postal)]);
    await db.pool.query("UPDATE customers SET default_address_id='71' WHERE id='51'");
    await db.pool.query("UPDATE orders SET customer_account_id='51' WHERE id=31");
    await db.pool.query("UPDATE archives SET customer_account_id='51' WHERE id=32");
    await db.pool.query(source[2]);
    assert.equal((await db.readRows("SHOW TABLES LIKE 'delivery_manual_refunds'")).length, 1);
    await db.pool.query(source[1]);
    assert.deepEqual(await db.readRows("SELECT id,customer,customerID,subtotal FROM archives WHERE id=32"), before);
    assert.equal((await db.readRows("SELECT customer_account_id FROM archives WHERE id=32"))[0].customer_account_id, null);
    assert.deepEqual(await db.readRows("SELECT id FROM customers"), []);
  }, { beforeDeliveryMigrations: db => db.seedScenario({ legacy: true }) });
});
