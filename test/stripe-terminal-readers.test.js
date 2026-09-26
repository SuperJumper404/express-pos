const assert = require("assert");
const { buildStripeTerminalReaderService } = require("../src/services/stripeTerminalReaders");
const { buildStripeTerminalController } = require("../src/controllers/c_stripeTerminal");
const { buildStripeTerminalModule } = require("../src/modules/m_stripeTerminal");

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
    readers, location, writes: [], stripeCalls: [], remoteReaders: new Set(), remoteLocations: new Set(),
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
  terminalStore.withRegistrationLock = async ({ shopId }, work) => work({ terminalStore, staffStore });
  const call = (name, result) => async (...args) => {
    state.stripeCalls.push({ name, args });
    if (state.stripeError) throw state.stripeError;
    return typeof result === "function" ? result(...args) : result;
  };
  const stripe = { terminal: {
    locations: {
      create: call("locations.create", () => {
        state.remoteLocations.add("tml_5");
        return { id: "tml_5" };
      }),
      update: call("locations.update", { id: "tml_5" }),
      del: call("locations.del", (id) => { state.remoteLocations.delete(id); return { id, deleted: true }; }),
    },
    readers: {
      create: call("readers.create", (params) => {
        const id = state.remoteReaders.size ? `tmr_new_${state.remoteReaders.size + 1}` : "tmr_new";
        state.remoteReaders.add(id);
        return {
          id, serial_number: "S710-123", device_type: "stripe_s710", label: params.label,
          status: "online", location: params.location, registration_code: params.registration_code,
          metadata: { secret: params.registration_code },
        };
      }),
      del: call("readers.del", (id) => { state.remoteReaders.delete(id); return { id, deleted: true }; }),
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

for (const resource of ["Reader", "Location"]) {
  for (const failure of ["throw", "empty insert"]) {
    test(`compensation deletes the returned Stripe ${resource} after ${failure}`, async () => {
      const f = fixture({ location: resource === "Reader" ? locationRow() : null });
      f.terminalStore[`create${resource}`] = async () => {
        if (failure === "throw") throw new Error("test-one-time-code raw DB failure");
        return { affectedRows: 0, insertId: 0 };
      };
      await assert.rejects(() => f.service.registerReader(registration()), (error) => error.code === "TERMINAL_INTERNAL_ERROR");
      const plural = resource === "Reader" ? "readers" : "locations";
      const id = resource === "Reader" ? "tmr_new" : "tml_5";
      assert.deepStrictEqual(f.state.stripeCalls.at(-1), { name: `${plural}.del`, args: [id] });
      assert.strictEqual(f.state.remoteReaders.size, 0);
      assert.strictEqual(f.state.remoteLocations.size, 0);
      assert.strictEqual(f.state.readers.length, 0);
      assert(!JSON.stringify(f.state.writes).includes("test-one-time-code"));
    });
  }
}

test("compensation restores the old Stripe address after a location update persistence failure", async () => {
  const f = fixture({ location: locationRow() });
  f.terminalStore.updateLocation = async () => { throw new Error("raw location failure"); };
  await assert.rejects(() => f.service.registerReader({ ...registration(), address: { ...address, city: "Lyon" } }), (error) => error.code === "TERMINAL_INTERNAL_ERROR");
  assert.deepStrictEqual(f.state.stripeCalls.map((entry) => entry.name), ["locations.update", "locations.update"]);
  assert.deepStrictEqual(f.state.stripeCalls[1].args, ["tml_5", {
    address: { line1: address.line1, postal_code: "75001", city: "Paris", country: "FR" },
  }]);
});

for (const resource of ["Reader", "Location"]) {
  test(`compensation failure for ${resource} is sanitized and the lock is released`, async () => {
    const f = fixture({ location: resource === "Reader" ? locationRow() : null });
    let released = false;
    f.terminalStore.withRegistrationLock = async (scope, work) => {
      try { return await work({ terminalStore: f.terminalStore, staffStore: f.staffStore }); }
      finally { released = true; }
    };
    f.terminalStore[`create${resource}`] = async () => { throw new Error("test-one-time-code DB"); };
    f.stripe.terminal[resource === "Reader" ? "readers" : "locations"].del = async () => {
      throw new Error("test-one-time-code raw Stripe cleanup");
    };
    const logs = [];
    const previous = [console.log, console.warn, console.error];
    console.log = console.warn = console.error = (...args) => logs.push(args);
    try {
      const response = await invoke(f.controller, "registerReader", { body: registration() });
      assert.strictEqual(response.statusCode, 502);
      assert.strictEqual(response.body.error, "TERMINAL_CLEANUP_FAILED");
      assert(!JSON.stringify([response.body, logs, f.state.writes]).includes("test-one-time-code"));
      assert.strictEqual(released, true);
    } finally {
      [console.log, console.warn, console.error] = previous;
    }
  });
}

test("compensation treats an already deleted reader as cleaned up", async () => {
  const f = fixture({ location: locationRow() });
  f.terminalStore.createReader = async () => { throw new Error("DB failure"); };
  f.stripe.terminal.readers.del = async () => { throw Object.assign(new Error("raw Stripe"), { statusCode: 404, code: "resource_missing" }); };
  await assert.rejects(() => f.service.registerReader(registration()), (error) => error.code === "TERMINAL_INTERNAL_ERROR");
});

test("compensation requires Stripe to confirm deletion", async () => {
  const f = fixture({ location: locationRow() });
  f.terminalStore.createReader = async () => { throw new Error("DB failure"); };
  f.stripe.terminal.readers.del = async () => ({ id: "tmr_new", deleted: false });
  await assert.rejects(() => f.service.registerReader(registration()), (error) => error.code === "TERMINAL_CLEANUP_FAILED");
});

test("a DTO read failure after a successful insert does not delete a tracked reader", async () => {
  const f = fixture({ location: locationRow() });
  f.terminalStore.findReader = async () => { throw new Error("read failed"); };
  await assert.rejects(() => f.service.registerReader(registration()), (error) => error.code === "TERMINAL_INTERNAL_ERROR");
  assert.strictEqual(f.state.readers.length, 1);
  assert.strictEqual(f.state.remoteReaders.size, 1);
  assert(!f.state.stripeCalls.some((entry) => entry.name.endsWith(".del")));
});

test("registration rechecks the administrator and assignee while holding the database lock", async () => {
  for (const target of [0, 1]) {
    const f = fixture();
    f.terminalStore.withRegistrationLock = async (scope, work) => {
      f.state.users[target].status = 0;
      return work({ terminalStore: f.terminalStore, staffStore: f.staffStore });
    };
    await rejectsWithoutStripe(f, () => f.service.registerReader(registration()), target === 0 ? "TERMINAL_FORBIDDEN" : "TERMINAL_INVALID_ASSIGNEE");
  }
});

test("registration lock timeout is sanitized and performs no Stripe mutation", async () => {
  const f = fixture();
  f.terminalStore.withRegistrationLock = async () => { throw Object.assign(new Error("raw lock error"), { code: "TERMINAL_REGISTRATION_BUSY" }); };
  await rejectsWithoutStripe(f, () => f.service.registerReader(registration()), "TERMINAL_REGISTRATION_BUSY");
});

// Model MySQL named locks at the SQL boundary, shared by independent pool/service instances.
const databasePools = (f) => {
  const holders = new Map();
  const calls = [];
  let onWait = () => {};
  const execute = async (sql, params) => {
    const store = f.terminalStore;
    if (sql.includes("FROM users")) return [await f.staffStore.findUserByIdAndShop({ id: params[0], shopId: params[1] })].filter(Boolean);
    if (sql.startsWith("SELECT * FROM stripe_terminal_locations")) return [await store.findLocation({ shopId: params[0] })].filter(Boolean);
    if (sql.startsWith("INSERT INTO stripe_terminal_locations")) {
      const data = params[0];
      return store.createLocation({ shopId: data.shopid, stripeLocationId: data.stripe_location_id, displayName: data.display_name, address: { line1: data.address_line1, postalCode: data.postal_code, city: data.city, country: data.country } });
    }
    if (sql.includes("FROM stripe_terminal_readers r")) {
      const row = sql.includes("assigned_user_id = ?")
        ? await store.findAssignedReader({ shopId: params[0], userId: params[1] })
        : await store.findReader({ shopId: params[0], readerId: params[1] });
      return row ? [row] : [];
    }
    if (sql.includes("INSERT INTO stripe_terminal_readers")) {
      if (f.state.readers.some((r) => r.is_active && r.assigned_user_id === params[5])) {
        throw Object.assign(new Error("duplicate assignment"), { code: "ER_DUP_ENTRY" });
      }
      return store.createReader({ stripeReaderId: params[0], serialNumber: params[1], deviceType: params[2], label: params[3], status: params[4], assignedUserId: params[5], assignedServicePointId: params[6], shopId: params[7], locationId: params[8] });
    }
    throw new Error(`Unexpected test SQL: ${sql}`);
  };
  const pool = () => ({
    query: async (sql, params) => [await execute(sql, params)],
    getConnection: async () => {
      let unlock;
      return {
        query: async (sql, params) => {
          calls.push({ sql, params });
          if (sql.includes("GET_LOCK")) {
            const previous = holders.get(params[0]);
            let release;
            const held = new Promise((resolve) => { release = resolve; });
            holders.set(params[0], held);
            if (previous) { onWait(); await previous; }
            unlock = () => { if (holders.get(params[0]) === held) holders.delete(params[0]); release(); };
            return [[{ acquired: 1 }]];
          }
          if (sql.includes("RELEASE_LOCK")) { unlock(); unlock = null; return [[{ released: 1 }]]; }
          return [await execute(sql, params)];
        },
        release: () => { assert.strictEqual(unlock, null); },
        destroy: () => { if (unlock) unlock(); },
      };
    },
  });
  return { pool, calls, holders, onWait: (listener) => { onWait = listener; } };
};

test("concurrent registrations across service instances create one tracked reader and one location", async () => {
  const f = fixture();
  const db = databasePools(f);
  const first = buildStripeTerminalReaderService({ stripe: f.stripe, terminalStore: buildStripeTerminalModule({ connection: db.pool() }), staffStore: f.staffStore });
  const second = buildStripeTerminalReaderService({ stripe: f.stripe, terminalStore: buildStripeTerminalModule({ connection: db.pool() }), staffStore: f.staffStore });
  let allowCreate;
  const gate = new Promise((resolve) => { allowCreate = resolve; });
  let started;
  const creating = new Promise((resolve) => { started = resolve; });
  let waiting;
  const lockedOut = new Promise((resolve) => { waiting = resolve; });
  db.onWait(waiting);
  const create = f.stripe.terminal.readers.create;
  let attempts = 0;
  f.stripe.terminal.readers.create = async (...args) => {
    attempts += 1;
    if (attempts === 1) { started(); await gate; }
    return create(...args);
  };
  const one = first.registerReader(registration());
  await creating;
  const two = second.registerReader(registration());
  try {
    await Promise.race([lockedOut, two.catch(() => {})]);
    assert.strictEqual(attempts, 1, "second registration must wait before Stripe mutation");
  } finally {
    allowCreate();
    const results = await Promise.allSettled([one, two]);
    assert.strictEqual(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.strictEqual(results.find((r) => r.status === "rejected").reason.code, "TERMINAL_ASSIGNMENT_CONFLICT");
  }
  assert.strictEqual(f.state.remoteReaders.size, 1);
  assert.strictEqual(f.state.remoteLocations.size, 1);
  assert.strictEqual(f.state.stripeCalls.filter((entry) => entry.name === "locations.create").length, 1);
  assert.strictEqual(f.state.readers.length, 1);
  assert(f.state.remoteReaders.has(f.state.readers[0].stripe_reader_id));
  assert.strictEqual(db.holders.size, 0);
  assert.strictEqual(db.calls.filter((entry) => entry.sql.includes("GET_LOCK")).length, 2);
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
    const { authentication, authAdmin, authorizeCashRegister } = require("../src/helpers/middleware/auth");
    for (const [verb, path, handler, admin] of [
      ["get", "/stripe/terminal/readers", "listReaders", true],
      ["post", "/stripe/terminal/readers", "registerReader", true],
      ["patch", "/stripe/terminal/readers/:id/assignment", "assignReader", true],
      ["patch", "/stripe/terminal/readers/:id/status", "setReaderActive", true],
      ["post", "/stripe/terminal/readers/refresh", "refreshReaders", true],
      ["get", "/stripe/terminal/current-reader", "getCurrentReader", false],
    ]) {
      const route = routers.stack.find((layer) => layer.route && layer.route.path === path && layer.route.methods[verb]).route;
      assert.deepStrictEqual(route.stack.map((layer) => layer.handle), admin ? [authentication, authAdmin, controller[handler]] : [authentication, authorizeCashRegister, controller[handler]]);
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
  const selected = tests.filter(({ name }) => !process.argv[2] || name.includes(process.argv[2]));
  assert(selected.length, "No tests matched the requested filter");
  for (const { name, run } of selected) {
    await run();
    console.log(`PASS ${name}`);
  }
  console.log(`stripe terminal reader tests passed (${selected.length} tests)`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
