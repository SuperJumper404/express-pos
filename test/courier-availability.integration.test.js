const assert = require("assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const { withDeliveryDatabase } = require("./helpers/deliveryDatabase");

async function main() {
  await withDeliveryDatabase(async db => {
    await db.seedScenario();
    require.cache[require.resolve("../src/config/dbPool")] = { exports: db.pool };
    require.cache[require.resolve("../src/config/db")] = { exports: db.pool.pool };
    if (Number(process.versions.node.split(".")[0]) === 18) require.cache[require.resolve("nanoid")] = { exports: await import("nanoid") };
    const { buildDeliveryDispatch } = require("../src/modules/m_deliveryDispatch");
    const dispatch = buildDeliveryDispatch();
    const actor = { subject: "staff", id: 11, shopId: 7, access: 6 };
    const app = express();
    app.use(express.json());
    app.use("/baseurl/api/v1", require("../src/helpers/middleware/auth").authenticationIfPresent);
    app.use("/baseurl/api/v1", require("../src/routers/r_courier"));
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    const request = async ({ id = 11, claims = {}, suffix = "", method = "GET", body } = {}) => {
      const token = jwt.sign({ id, shopid: 7, access: 0, ...claims }, process.env.JWTKEY);
      const response = await fetch(`http://127.0.0.1:${server.address().port}/baseurl/api/v1/courier/availability${suffix}`, {
        method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() };
    };
    try {
      // A trigger proves even same-value writes on GET would fail, beyond comparing snapshots.
      await db.pool.query("UPDATE users SET courier_available=0 WHERE id=11");
      await db.pool.query("CREATE TRIGGER task14_no_user_writes BEFORE UPDATE ON users FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='GET attempted a write'");
      const before = await db.readRows("SELECT * FROM users ORDER BY id");
      const read = await request({ suffix: "?courierId=12&id=12&shopId=8&available=true" });
      assert.equal(read.status, 200);
      assert.equal(read.cache, "no-store");
      assert.deepEqual(read.body.data, { courierId: 11, available: false });
      assert.deepEqual(await db.readRows("SELECT * FROM users ORDER BY id"), before);
      await db.pool.query("DROP TRIGGER task14_no_user_writes");
      console.log("PASS own GET false/current identity/strict DTO/no-store/no SQL writes/caller IDs ignored");

      await db.pool.query("UPDATE users SET courier_available=1 WHERE id=11");
      assert.deepEqual((await request()).body.data, { courierId: 11, available: true });
      assert.deepEqual(await dispatch.readAvailability({ actor }), { courierId: 11, available: true });
      await db.pool.query("UPDATE users SET status=0 WHERE id=11");
      assert.equal((await request()).status, 403);
      await assert.rejects(dispatch.readAvailability({ actor }), { status: 403 });
      await db.pool.query("UPDATE users SET status=1,access=1,module_permissions='[\"delivery\"]' WHERE id=11");
      assert.equal((await request({ claims: { access: 6 } })).status, 403);
      await assert.rejects(dispatch.readAvailability({ actor }), { status: 403 });
      await db.pool.query("UPDATE users SET access=6 WHERE id=11");
      await db.pool.query("UPDATE users SET shopid=8 WHERE id=11");
      assert.equal((await request()).status, 403);
      await assert.rejects(dispatch.readAvailability({ actor }), { status: 403 });
      await db.pool.query("UPDATE users SET shopid=7 WHERE id=11");
      console.log("PASS current SQL active role/tenant changes override stale JWT and service claims");

      for (const input of [{ id: 10 }, { id: 12 }, { claims: { subject: "customer" } },
        { claims: { subject_type: "customer" } }, { claims: { subject_type: "service_point", service_point_id: 701, access: 6 } }]) {
        assert.equal((await request(input)).status, 403);
      }
      for (const subject of ["customer", "service_point"]) await assert.rejects(dispatch.readAvailability({ actor: { ...actor, subject } }), { status: 403 });
      // Existing PATCH is exercised unchanged, followed by the new authoritative read.
      assert.equal((await request({ method: "PATCH", body: { available: false } })).status, 200);
      assert.deepEqual((await request()).body.data, { courierId: 11, available: false });
      assert.equal((await request({ method: "PATCH", body: { available: "true" } })).status, 400);
      assert.deepEqual((await request()).body.data, { courierId: 11, available: false });
      console.log("PASS noncourier/foreign/nonstaff denied and existing PATCH unchanged");
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
