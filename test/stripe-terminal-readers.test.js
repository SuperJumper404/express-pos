const assert = require("assert");
const { buildStripeTerminalReaderService } = require("../src/services/stripeTerminalReaders");
const { buildStripeTerminalController } = require("../src/controllers/c_stripeTerminal");

const tests = [];
const test = (name, run) => tests.push({ name, run });
const address = { line1: "10 rue de Paris", postalCode: "75001", city: "Paris", country: "FR" };
const context = { shopId: 7, actorUserId: 10 };
const registration = () => ({ ...context, registrationCode: "test-one-time-code", label: "Caisse 1", assignedUserId: 11, address: { ...address } });
const readerRow = (overrides = {}) => ({
  id: 21, shopid: 7, terminal_location_id: 5, stripe_reader_id: "tmr_21",
  serial_number: "S710-123", device_type: "stripe_s710", label: "Caisse 1",
  status: "online", assigned_user_id: 11, assigned_service_point_id: null, is_active: 1,
  ...overrides,
});
const locationRow = (overrides = {}) => ({
  id: 5, shopid: 7, stripe_location_id: "tml_5", display_name: "Restaurant 7",
  address_line1: address.line1, postal_code: address.postalCode, city: address.city, country: "FR",
  ...overrides,
});

// Only the external Stripe and SQL boundaries are replaced; service/controller logic is real.
const fixture = ({ readers = [], location = null, users } = {}) => {
  const state = {
    readers, location, writes: [], stripeCalls: [],
    users: users || [
      { id: 10, shopid: 7, access: 0, status: 1 },
      { id: 11, shopid: 7, access: 1, status: 1 },
      { id: 12, shopid: 7, access: 1, status: 1 },
    ],
  };
  const terminalStore = {
    findLocation: async ({ shopId }) => state.location && state.location.shopid === shopId ? state.location : null,
    createLocation: async (data) => {
      state.writes.push(data);
      state.location = locationRow({ shopid: data.shopId, stripe_location_id: data.stripeLocationId, display_name: data.displayName });
      return { insertId: 5, affectedRows: 1 };
    },
    updateLocation: async (data) => {
      state.writes.push(data);
      Object.assign(state.location, { address_line1: data.address.line1, postal_code: data.address.postalCode, city: data.address.city, country: data.address.country });
      return { affectedRows: 1 };
    },
    listReaders: async ({ shopId }) => state.readers.filter((r) => r.shopid === shopId),
    findReader: async ({ shopId, readerId }) => state.readers.find((r) => r.shopid === shopId && r.id === readerId) || null,
    findAssignedReader: async ({ shopId, userId }) => state.readers.find((r) => r.shopid === shopId && r.assigned_user_id === userId && r.is_active === 1) || null,
    createReader: async (data) => {
      state.writes.push(data);
      state.readers.push(readerRow({
        id: 21 + state.readers.length, shopid: data.shopId, terminal_location_id: data.locationId,
        stripe_reader_id: data.stripeReaderId, serial_number: data.serialNumber, device_type: data.deviceType,
        label: data.label, status: data.status, assigned_user_id: data.assignedUserId,
        assigned_service_point_id: data.assignedServicePointId == null ? null : data.assignedServicePointId,
      }));
      return { insertId: state.readers[state.readers.length - 1].id, affectedRows: 1 };
    },
    updateReader: async (data) => {
      state.writes.push(data);
      const row = await terminalStore.findReader(data);
      if (!row) return { affectedRows: 0 };
      for (const [key, column] of Object.entries({ label: "label", status: "status", assignedUserId: "assigned_user_id", assignedServicePointId: "assigned_service_point_id", isActive: "is_active" })) {
        if (data[key] !== undefined) row[column] = data[key];
      }
      return { affectedRows: 1 };
    },
  };
  const staffStore = {
    findUserByIdAndShop: async ({ id, shopId }) => state.users.find((u) => u.id === id && u.shopid === shopId) || null,
  };
  const call = (name, result) => async (...args) => {
    state.stripeCalls.push({ name, args });
    if (state.stripeError) throw state.stripeError;
    return typeof result === "function" ? result(...args) : result;
  };
  const stripe = { terminal: {
    locations: {
      create: call("locations.create", { id: "tml_5" }),
      update: call("locations.update", { id: "tml_5" }),
    },
    readers: {
      create: call("readers.create", (params) => ({
        id: "tmr_new", serial_number: "S710-123", device_type: "stripe_s710", label: params.label,
        status: "online", location: params.location, registration_code: params.registration_code,
        metadata: { secret: params.registration_code },
      })),
      retrieve: call("readers.retrieve", (id) => ({ id, status: "offline", label: "Remote label", metadata: { secret: "raw-secret" } })),
    },
  } };
  const service = buildStripeTerminalReaderService({ stripe, terminalStore, staffStore });
  return { state, terminalStore, staffStore, stripe, service, controller: buildStripeTerminalController({ readerService: service }) };
};

const rejectsWithoutStripe = async (f, work, code) => {
  await assert.rejects(work, (error) => error.code === code);
  assert.deepStrictEqual(f.state.stripeCalls, []);
  assert.deepStrictEqual(f.state.writes, []);
};
const invoke = async (controller, method, overrides = {}) => {
  const req = { shopid: 7, id: 10, access: 0, sessionSubject: "staff", params: { id: "21" }, body: {}, ...overrides };
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return body; } };
  await controller[method](req, res);
  return res;
};

test("first registration creates a France location and forwards the code once on the platform account", async () => {
  const f = fixture();
  const result = await f.service.registerReader(registration());
  assert.deepStrictEqual(f.state.stripeCalls, [
    { name: "locations.create", args: [{ display_name: "Restaurant 7", address: { line1: address.line1, postal_code: "75001", city: "Paris", country: "FR" } }] },
    { name: "readers.create", args: [{ registration_code: "test-one-time-code", label: "Caisse 1", location: "tml_5" }] },
  ]);
  assert.deepStrictEqual(result, {
    id: 21, label: "Caisse 1", serialNumber: "S710-123", deviceType: "stripe_s710", status: "online",
    assignedUserId: 11, assignedServicePointId: null, isActive: true,
  });
  assert.strictEqual(f.state.readers[0].stripe_reader_id, "tmr_new");
  assert.strictEqual(f.state.readers[0].terminal_location_id, 5);
  assert(!JSON.stringify([result, f.state.writes, f.state.readers]).includes("test-one-time-code"));
});

test("later registration reuses the location without requiring an address", async () => {
  const f = fixture({ location: locationRow() });
  const data = registration();
  delete data.address;
  await f.service.registerReader(data);
  assert.deepStrictEqual(f.state.stripeCalls.map((c) => c.name), ["readers.create"]);
});

test("changed address synchronizes the platform location before registration", async () => {
  const f = fixture({ location: locationRow() });
  await f.service.registerReader({ ...registration(), address: { ...address, line1: "20 rue de Paris" } });
  assert.deepStrictEqual(f.state.stripeCalls[0], {
    name: "locations.update", args: ["tml_5", { address: { line1: "20 rue de Paris", postal_code: "75001", city: "Paris", country: "FR" } }],
  });
  assert.strictEqual(f.state.stripeCalls[1].name, "readers.create");
  assert.strictEqual(f.state.location.address_line1, "20 rue de Paris");
});

test("unchanged address avoids a location update", async () => {
  const f = fixture({ location: locationRow() });
  await f.service.registerReader(registration());
  assert.deepStrictEqual(f.state.stripeCalls.map((c) => c.name), ["readers.create"]);
});

for (const [name, change] of [
  ["missing code", { registrationCode: undefined }], ["blank code", { registrationCode: "  " }],
  ["object code", { registrationCode: {} }], ["oversized code", { registrationCode: "x".repeat(501) }],
  ["blank label", { label: " " }], ["object label", { label: {} }], ["oversized label", { label: "x".repeat(256) }],
  ["missing assignment", { assignedUserId: undefined }], ["boolean assignment", { assignedUserId: true }],
  ["array assignment", { assignedUserId: [11] }], ["fractional assignment", { assignedUserId: 1.1 }],
  ["unsafe assignment", { assignedUserId: Number.MAX_SAFE_INTEGER + 1 }],
  ["invalid shop", { shopId: 0 }], ["missing first address", { address: undefined }],
  ["foreign country", { address: { ...address, country: "DE" } }],
  ["missing country", { address: { ...address, country: undefined } }],
  ["invalid postal code", { address: { ...address, postalCode: "Paris" } }],
  ["blank city", { address: { ...address, city: " " } }],
  ["long address", { address: { ...address, line1: "x".repeat(256) } }],
  ["future kiosk input", { assignedServicePointId: 8 }],
]) {
  test(`registration rejects ${name} before any Stripe call`, async () => {
    const f = fixture();
    await rejectsWithoutStripe(f, () => f.service.registerReader({ ...registration(), ...change }), "TERMINAL_INVALID_INPUT");
  });
}

test("duplicate active cashier assignment fails before updating location or registering", async () => {
  const f = fixture({ readers: [readerRow()], location: locationRow() });
  await rejectsWithoutStripe(f, () => f.service.registerReader({ ...registration(), address: { ...address, city: "Lyon" } }), "TERMINAL_ASSIGNMENT_CONFLICT");
});

for (const [name, user] of [
  ["cross-shop", { shopid: 8 }], ["inactive", { status: 0 }], ["customer", { access: 2 }], ["web customer", { access: 3 }],
]) {
  test(`registration rejects ${name} assignees before Stripe`, async () => {
    const f = fixture();
    Object.assign(f.state.users[1], user);
    await rejectsWithoutStripe(f, () => f.service.registerReader(registration()), "TERMINAL_INVALID_ASSIGNEE");
  });
}

test("inactive historical assignment does not reserve the cashier", async () => {
  const f = fixture({ readers: [readerRow({ is_active: 0 })], location: locationRow() });
  assert.strictEqual((await f.service.registerReader(registration())).assignedUserId, 11);
});

test("assignment changes the cashier and preserves the nullable service-point field", async () => {
  const f = fixture({ readers: [readerRow()] });
  const result = await f.service.assignReader({ ...context, readerId: "21", assignedUserId: "12" });
  assert.strictEqual(result.assignedUserId, 12);
  assert.strictEqual(result.assignedServicePointId, null);
  assert.strictEqual(f.state.writes[0].assignedServicePointId, undefined);
  assert.deepStrictEqual(f.state.stripeCalls, []);
});

test("assigning the same cashier is idempotent", async () => {
  const f = fixture({ readers: [readerRow()] });
  assert.strictEqual((await f.service.assignReader({ ...context, readerId: 21, assignedUserId: 11 })).assignedUserId, 11);
});

test("assignment rejects another active reader for the cashier", async () => {
  const f = fixture({ readers: [readerRow(), readerRow({ id: 22, assigned_user_id: 12 })] });
  await rejectsWithoutStripe(f, () => f.service.assignReader({ ...context, readerId: 21, assignedUserId: 12 }), "TERMINAL_ASSIGNMENT_CONFLICT");
});

test("assignment rejects inactive readers", async () => {
  const f = fixture({ readers: [readerRow({ is_active: 0 })] });
  await rejectsWithoutStripe(f, () => f.service.assignReader({ ...context, readerId: 21, assignedUserId: 12 }), "TERMINAL_READER_INACTIVE");
});

test("assignment never overwrites a future service-point assignment", async () => {
  const f = fixture({ readers: [readerRow({ assigned_user_id: null, assigned_service_point_id: 44 })] });
  await rejectsWithoutStripe(f, () => f.service.assignReader({ ...context, readerId: 21, assignedUserId: 12 }), "TERMINAL_ASSIGNMENT_CONFLICT");
  assert.strictEqual(f.state.readers[0].assigned_service_point_id, 44);
});

for (const method of ["assignReader", "setReaderActive"]) {
  test(`${method} rejects a cross-shop reader`, async () => {
    const f = fixture({ readers: [readerRow({ shopid: 8 })] });
    await rejectsWithoutStripe(f, () => f.service[method]({ ...context, readerId: 21, assignedUserId: 12, isActive: true }), "TERMINAL_READER_NOT_FOUND");
  });
  test(`${method} rejects malformed reader IDs`, async () => {
    const f = fixture({ readers: [readerRow()] });
    await rejectsWithoutStripe(f, () => f.service[method]({ ...context, readerId: [21], assignedUserId: 12, isActive: true }), "TERMINAL_INVALID_INPUT");
  });
}

test("deactivation is local, preserves registration and assignment, and hides current reader", async () => {
  const f = fixture({ readers: [readerRow()] });
  const result = await f.service.setReaderActive({ ...context, readerId: 21, isActive: false });
  assert.strictEqual(result.isActive, false);
  assert.strictEqual(result.assignedUserId, 11);
  assert.strictEqual(f.state.readers[0].stripe_reader_id, "tmr_21");
  assert.strictEqual(await f.service.getCurrentReader({ shopId: 7, userId: 11 }), null);
  assert.deepStrictEqual(f.state.stripeCalls, []);
});

test("reactivation restores current reader after validating the active assignee", async () => {
  const f = fixture({ readers: [readerRow({ is_active: 0 })] });
  assert.strictEqual((await f.service.setReaderActive({ ...context, readerId: 21, isActive: true })).isActive, true);
  assert.strictEqual((await f.service.getCurrentReader({ shopId: 7, userId: 11 })).id, 21);
});

test("reactivation rejects duplicate assignment", async () => {
  const f = fixture({ readers: [readerRow({ is_active: 0 }), readerRow({ id: 22 })] });
  await rejectsWithoutStripe(f, () => f.service.setReaderActive({ ...context, readerId: 21, isActive: true }), "TERMINAL_ASSIGNMENT_CONFLICT");
});

test("reactivation rejects an inactive cashier", async () => {
  const f = fixture({ readers: [readerRow({ is_active: 0 })] });
  f.state.users[1].status = 0;
  await rejectsWithoutStripe(f, () => f.service.setReaderActive({ ...context, readerId: 21, isActive: true }), "TERMINAL_INVALID_ASSIGNEE");
});

test("active flag must be a boolean", async () => {
  const f = fixture({ readers: [readerRow()] });
  await rejectsWithoutStripe(f, () => f.service.setReaderActive({ ...context, readerId: 21, isActive: "false" }), "TERMINAL_INVALID_INPUT");
});

test("list returns only sanitized readers in the authenticated shop", async () => {
  const f = fixture({ readers: [readerRow({ registration_code: "raw-secret", metadata: { secret: "raw-secret" } }), readerRow({ id: 22, shopid: 8 })] });
  const result = await f.service.listReaders(context);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, 21);
  assert(!JSON.stringify(result).includes("raw-secret"));
  assert.deepStrictEqual(f.state.stripeCalls, []);
});

test("refresh retrieves only local shop readers and preserves assignment fields", async () => {
  const f = fixture({ readers: [readerRow({ assigned_user_id: null, assigned_service_point_id: 44 }), readerRow({ id: 22, shopid: 8 })] });
  const result = await f.service.refreshReaders(context);
  assert.deepStrictEqual(f.state.stripeCalls, [{ name: "readers.retrieve", args: ["tmr_21"] }]);
  assert.strictEqual(result[0].status, "offline");
  assert.strictEqual(result[0].assignedServicePointId, 44);
  assert.strictEqual(f.state.writes[0].assignedServicePointId, undefined);
  assert(!JSON.stringify([result, f.state.writes]).includes("raw-secret"));
});

test("current reader is resolved from staff identity and returns null without assignment", async () => {
  const f = fixture({ readers: [readerRow()] });
  assert.strictEqual((await f.service.getCurrentReader({ shopId: 7, userId: 11 })).id, 21);
  assert.strictEqual(await f.service.getCurrentReader({ shopId: 7, userId: 12 }), null);
  f.state.users[1].status = 0;
  await rejectsWithoutStripe(f, () => f.service.getCurrentReader({ shopId: 7, userId: 11 }), "TERMINAL_FORBIDDEN");
});

const managementMethods = ["listReaders", "registerReader", "assignReader", "setReaderActive", "refreshReaders"];
for (const method of managementMethods) {
  test(`${method} requires an active same-shop database administrator`, async () => {
    for (const change of [{ access: 1 }, { status: 0 }, { shopid: 8 }]) {
      const f = fixture({ readers: [readerRow()] });
      Object.assign(f.state.users[0], change);
      await rejectsWithoutStripe(f, () => f.service[method]({ ...registration(), readerId: 21, isActive: false }), "TERMINAL_FORBIDDEN");
    }
  });
  test(`${method} controller rejects non-admin and service-point sessions`, async () => {
    for (const req of [{ access: 1 }, { access: undefined }, { access: null }, { sessionSubject: "service_point" }]) {
      const f = fixture();
      const response = await invoke(f.controller, method, req);
      assert.strictEqual(response.statusCode, 403);
      assert.deepStrictEqual(f.state.stripeCalls, []);
      assert.deepStrictEqual(f.state.writes, []);
    }
  });
}

test("controller uses authenticated scope and returns registration DTO", async () => {
  const f = fixture();
  const response = await invoke(f.controller, "registerReader", { body: { ...registration(), shopId: 8, actorUserId: 999 } });
  assert.strictEqual(response.statusCode, 201);
  assert.strictEqual(response.body.data.assignedUserId, 11);
  assert.strictEqual(f.state.readers[0].shopid, 7);
  assert(!JSON.stringify(response.body).includes("test-one-time-code"));
});

test("controller exposes assignment, activation, list, and refresh results", async () => {
  const f = fixture({ readers: [readerRow()] });
  const assigned = await invoke(f.controller, "assignReader", { body: { assignedUserId: 12 } });
  assert.strictEqual(assigned.body.data.assignedUserId, 12);
  const inactive = await invoke(f.controller, "setReaderActive", { body: { isActive: false } });
  assert.strictEqual(inactive.body.data.isActive, false);
  assert.strictEqual((await invoke(f.controller, "listReaders")).body.data.length, 1);
  assert.strictEqual((await invoke(f.controller, "refreshReaders")).body.data[0].status, "offline");
});

test("current-reader controller accepts staff and rejects customer or kiosk sessions", async () => {
  const f = fixture({ readers: [readerRow()] });
  const result = await invoke(f.controller, "getCurrentReader", { id: 11, access: 1, body: { userId: 12, readerId: 99 } });
  assert.strictEqual(result.statusCode, 200);
  assert.strictEqual(result.body.data.id, 21);
  assert.strictEqual((await invoke(f.controller, "getCurrentReader", { id: 12, access: 1 })).body.data, null);
  for (const req of [{ access: 2 }, { access: 3 }, { access: null }, { sessionSubject: "service_point" }]) {
    assert.strictEqual((await invoke(f.controller, "getCurrentReader", req)).statusCode, 403);
  }
  assert.deepStrictEqual(f.state.stripeCalls, []);
});

test("Stripe errors are sanitized by service and controller without logging or persisting raw details", async () => {
  const f = fixture({ location: locationRow() });
  f.state.stripeError = Object.assign(new Error("raw-secret test-one-time-code"), { raw: { registration_code: "test-one-time-code" } });
  const logged = [];
  const originals = [console.log, console.error, console.warn];
  console.log = console.error = console.warn = (...args) => logged.push(args);
  try {
    await assert.rejects(() => f.service.registerReader(registration()), (error) => {
      assert.strictEqual(error.code, "TERMINAL_STRIPE_ERROR");
      assert(!error.stack.includes("raw-secret"));
      assert.strictEqual(error.cause, undefined);
      return true;
    });
    const result = await invoke(f.controller, "registerReader", { body: registration() });
    assert.strictEqual(result.statusCode, 502);
    assert.strictEqual(result.body.error, "TERMINAL_STRIPE_ERROR");
    assert(!JSON.stringify([result.body, f.state.writes, logged]).includes("test-one-time-code"));
    assert.deepStrictEqual(logged, []);
  } finally {
    [console.log, console.error, console.warn] = originals;
  }
});

test("database uniqueness races become a stable conflict without exposing raw errors", async () => {
  const f = fixture({ readers: [readerRow()] });
  f.terminalStore.updateReader = async () => { throw Object.assign(new Error("raw-secret SQL"), { code: "ER_DUP_ENTRY" }); };
  const result = await invoke(f.controller, "assignReader", { body: { assignedUserId: 12 } });
  assert.strictEqual(result.statusCode, 409);
  assert.strictEqual(result.body.error, "TERMINAL_ASSIGNMENT_CONFLICT");
  assert(!JSON.stringify(result.body).includes("raw-secret"));
});

test("unexpected infrastructure errors never expose raw data", async () => {
  const f = fixture();
  f.terminalStore.listReaders = async () => { throw new Error("raw-secret SQL"); };
  const result = await invoke(f.controller, "listReaders");
  assert.strictEqual(result.statusCode, 500);
  assert.strictEqual(result.body.error, "TERMINAL_INTERNAL_ERROR");
  assert(!JSON.stringify(result.body).includes("raw-secret"));
});

test("router binds all six reader endpoints with auth and preserves web/connect bindings", () => {
  const stripePath = require.resolve("../src/controllers/c_stripe");
  const editingPath = require.resolve("../src/controllers/c_orderEditing");
  const routerPath = require.resolve("../src/routers/r_stripe");
  const previous = [stripePath, editingPath, routerPath].map((path) => require.cache[path]);
  const legacy = Object.fromEntries(["getConnectStatus", "createConnectOnboardingLink", "createQrTablePaymentIntent", "cancelQrTablePaymentIntent", "markQrTablePaymentAtCounter", "refundPaidOrder", "handleWebhook"].map((name) => [name, () => {}]));
  require.cache[stripePath] = { exports: legacy };
  require.cache[editingPath] = { exports: { replacementPayment: () => {} } };
  delete require.cache[routerPath];
  try {
    const { routers, webhookRouter } = require(routerPath);
    const controller = require("../src/controllers/c_stripeTerminal");
    const { authentication, authAdmin } = require("../src/helpers/middleware/auth");
    for (const [verb, path, handler, admin] of [
      ["get", "/stripe/terminal/readers", "listReaders", true],
      ["post", "/stripe/terminal/readers", "registerReader", true],
      ["patch", "/stripe/terminal/readers/:id/assignment", "assignReader", true],
      ["patch", "/stripe/terminal/readers/:id/status", "setReaderActive", true],
      ["post", "/stripe/terminal/readers/refresh", "refreshReaders", true],
      ["get", "/stripe/terminal/current-reader", "getCurrentReader", false],
    ]) {
      const route = routers.stack.find((layer) => layer.route && layer.route.path === path && layer.route.methods[verb]).route;
      assert.deepStrictEqual(route.stack.map((layer) => layer.handle), admin ? [authentication, authAdmin, controller[handler]] : [authentication, controller[handler]]);
    }
    const connect = routers.stack.find((layer) => layer.route.path === "/stripe/connect/status").route;
    assert.deepStrictEqual(connect.stack.map((layer) => layer.handle), [authentication, authAdmin, legacy.getConnectStatus]);
    const web = routers.stack.find((layer) => layer.route.path === "/stripe/payment-intents/qr-table").route;
    assert.deepStrictEqual(web.stack.map((layer) => layer.handle), [authentication, legacy.createQrTablePaymentIntent]);
    assert.strictEqual(webhookRouter.stack[0].route.stack[0].handle, legacy.handleWebhook);
  } finally {
    [stripePath, editingPath, routerPath].forEach((path, index) => {
      if (previous[index]) require.cache[path] = previous[index];
      else delete require.cache[path];
    });
  }
});

(async () => {
  for (const { name, run } of tests) {
    await run();
    console.log(`PASS ${name}`);
  }
  console.log(`stripe terminal reader tests passed (${tests.length} tests)`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
