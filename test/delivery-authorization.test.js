const assert = require("assert");
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 22) require.cache[require.resolve("nanoid")] = { exports: await import("nanoid") };
  const users = new Map([[11, { id: 11, shopid: 7, access: 6, status: 1,
    username: "Courier", module_permissions: '["orders","stocks","delivery"]' }]]);
  const updates = [];
  require.cache[require.resolve("../src/config/dbPool")] = { loaded: true, exports: { query: async (sql, values) => [[users.get(Number(values[0]))]] } };
  require.cache[require.resolve("../src/modules/m_users")] = { loaded: true, exports: {
    mFindUserByStaffLoginId: async () => [users.get(11)],
    mSessionUser: async () => [{ ...users.get(11), password: "private", staff_pin_hash: "private", token: "session" }],
    mUpdateUser: async (data, id) => { updates.push({ data, id }); return { affectedRows: 1 }; },
    mProfileMe: async () => { throw new Error("Courier profile must use current account"); },
    mActivation: async () => { throw new Error("Unauthorized legacy activation reached account repository"); },
  } };
  require.cache[require.resolve("../src/modules/m_servicePoints")] = { loaded: true, exports: { findKioskByLoginId: async () => null } };
  const { buildAuthentication } = require("../src/helpers/middleware/auth");
  const { assertStaffSurface } = require("../src/helpers/deliveryAuthorization");
  const { ACCESS, normalizeModulePermissions } = require("../src/helpers/staffPermissions");
  const { isStaffAccess, isOrderTakerAccess } = require("../src/helpers/staffAccess");
  assert.equal(ACCESS.COURIER, 6);
  assert.equal(isStaffAccess(6), true);
  assert.equal(isOrderTakerAccess(6), false);
  assert.deepEqual(normalizeModulePermissions(["orders", "delivery"], 6), []);
  assert.doesNotThrow(() => assertStaffSurface({ access: 6, method: "GET", path: "/courier/cash-balance" }));
  const authentication = buildAuthentication({ findUserByIdAndShop: async ({ id, shopId }) => {
    const user = users.get(Number(id));
    return user && user.shopid === shopId ? user : null;
  } });
  const app = express();
  app.use(express.json());
  app.use("/baseurl/api/v1", require("../src/helpers/middleware/auth").authenticationIfPresent);
  app.post("/baseurl/api/v1/login", require("../src/controllers/c_users").loginWithStaffCredentials);
  app.post(["/baseurl/api/v1/table-access", "/baseurl/api/v1/shopInfo/click-and-collect/7/session"], (req, res) => res.json({ proofBoundary: true }));
  const operation = async ({ actor }) => { assert.equal(actor.id, 11); return { accepted: true }; };
  app.use("/baseurl/api/v1", require("../src/routers/r_courier").buildCourierRouter({ authentication,
    controller: require("../src/controllers/c_courier").buildCourierController({ cash: { balance: operation }, dispatch: {
      list: operation, get: operation, pickup: operation, deliver: operation, reportIssue: operation, availability: operation,
    } }),
  }));
  app.get("/baseurl/api/v1/legacy-public-order", (req, res) => res.json({ privateLegacy: true }));
  app.use("/baseurl/api/v1", require("../src/routers/r_users"));
  app.use("/baseurl/api/v1", authentication, (req, res) => res.json({ sentinel: true, access: req.access, subject: req.sessionSubject }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/baseurl/api/v1`;
  const token = claims => jwt.sign({ id: 11, shopid: 7, access: 6, ...claims }, process.env.JWTKEY);
  const call = async (path, method = "GET", claims = {}, body) => {
    const res = await fetch(url + path, { method, headers: { authorization: `Bearer ${token(claims)}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    for (const access of [0, 1, 6]) {
      assert.equal((await call("/legacy-public-order", "GET", { access })).status, 403);
      for (const [method, path] of [["GET", "/orders"], ["GET", "/users"], ["GET", "/metrics"], ["GET", "/detailorder/31"], ["POST", "/products"], ["PATCH", "/stock/21"], ["GET", "/courierAnything"], ["GET", "/user/me/other"], ["PATCH", "/courier/cash-balance"], ["POST", "/courier/cash-remittances"], ["GET", "/courier/deliveries/41/other"], ["POST", "/delivery/quotes"]]) {
        assert.equal((await call(path, method, { access, module_permissions: ["orders", "stocks", "delivery"] })).status, 403, `${access} ${method} ${path}`);
      }
    }
    for (const path of ["/delivery/address-suggestions", "/customer/address-suggestions"]) assert.equal((await call(path, "POST", { access: 0 }, { input: "60 rue Test", sessionToken: "fixture" })).status, 403);
    for (const [method, path] of [["GET", "/courier/deliveries"], ["GET", "/courier/deliveries/41"], ["POST", "/courier/deliveries/41/pickup"], ["GET", "/courier/cash-balance"]]) assert.equal((await call(path, method)).status, 200);
    for (const malformedAccess of [null, undefined]) {
      users.get(11).access = malformedAccess;
      for (const [method, path] of [["GET", "/reports/z/current"], ["POST", "/reports/z/close"], ["GET", "/reports/z"], ["GET", "/reports/z/1"],
        ["GET", "/courier/cash-balance"], ["GET", "/delivery/couriers/11/cash-balance"], ["POST", "/delivery/couriers/11/remittances"], ["POST", "/delivery/couriers/11/adjustments"], ["POST", "/deliveries/41/refund"]]) {
        assert.equal((await call(path, method, { access: 0 }, method === "POST" ? {} : undefined)).status, 403, `malformed DB role ${method} ${path}`);
      }
    }
    users.get(11).access = 6;
    assert.equal((await call("/courier/deliveries", "GET", { subject_type: "customer" })).status, 403);
    const profile = await call("/user/me");
    assert.equal(profile.status, 200);
    assert.deepEqual(Object.keys(profile.body.data[0]).sort(), ["access", "id", "shopid", "status", "username"]);
    assert.equal((await call("/logout", "POST", {}, { id: 10 })).status, 200);
    assert.equal(updates.at(-1).id, 11);
    users.get(11).status = 0;
    assert.equal((await call("/courier/deliveries")).status, 403);
    users.get(11).status = 1;
    users.get(11).access = 1;
    assert.equal((await call("/logout", "POST", { access: 0 }, { id: "14/extra" })).status, 200);
    assert.equal(updates.at(-1).id, 11);
    assert.equal((await call("/user/11", "PATCH", { access: 0 }, { access: 0 })).status, 403);
    assert.equal((await call("/register", "POST", { access: 0 }, { access: 6 })).status, 403);
    assert.equal((await fetch(url.replace("/baseurl/api/v1", "/BASEURL/API/V1") + "/REGISTER/", { method: "POST", headers: { authorization: `Bearer ${token({ access: 0 })}`, "content-type": "application/json" }, body: JSON.stringify({ access: 6 }) })).status, 403);
    assert.equal((await call("/activate/opaque/user@example.test/position/0")).status, 403);
    assert.equal((await fetch(url + "/activate/opaque/user@example.test/position/0")).status, 403);
    for (const path of ["/register/", "/REGISTER", "/user/%31%31", "/USER/11/STAFF-CREDENTIALS/"]) {
      const method = path.toLowerCase().startsWith("/register") ? "POST" : "PATCH";
      assert.equal((await call(path, method, { access: 0 }, { access: 0 })).status, 403, path);
    }
    assert.equal((await call("/register", "POST", { subject_type: "service_point", access: 2, service_point_id: 23 }, { access: 0 })).status, 403);
    users.get(11).access = 6;
    users.get(11).staff_pin_hash = await bcrypt.hash("123456", 4);
    const login = await fetch(url + "/login", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer expired-session-fixture" }, body: JSON.stringify({ staff_login_id: "COURIER11", pin: "123456" }) });
    const result = await login.json();
    assert.equal(login.status, 200);
    assert.equal(result.data[0].access, 6);
    assert.equal(result.data[0].password, undefined);
    assert.equal(result.data[0].staff_pin_hash, undefined);
    for (const path of ["/table-access", "/shopInfo/click-and-collect/7/session"]) {
      assert.equal((await fetch(url + path, { method: "POST", headers: { authorization: "Bearer expired-session-fixture" } })).status, 200);
    }
    const controller = require("../src/controllers/c_users");
    for (const action of ["registerWithStaffCredentials", "register", "setStaffCredentials", "updateUser", "deleteUser"]) {
      for (const context of [{}, { currentUser: { id: 11, shopid: 7, access: 1, status: 1 } },
        { sessionSubject: "service_point", currentUser: { id: 11, shopid: 7, access: 0, status: 1 } },
        { currentUser: { id: 11, shopid: 7, access: 0, status: 0 } },
        { currentUser: { id: 11, shopid: 8, access: 0, status: 1 } },
        { currentUser: { id: 11, shopid: 7, access: null, status: 1 } },
        { shopid: undefined, currentUser: { id: 11, access: 0, status: 1 } }]) {
        const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
        await controller[action]({ sessionSubject: "staff", id: 11, shopid: 7, access: 0, params: { id: "11" },
          body: { username: "Forged", access: 6, currentUser: { id: 11, shopid: 7, access: 0, status: 1 } }, ...context }, res);
        assert.equal(res.code, 403, `${action} independently requires trusted current active admin`);
      }
    }
    console.log("PASS HTTP current-role isolation, exact surfaces, customer rejection, own profile/logout and personal PIN login");
  } finally { await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
