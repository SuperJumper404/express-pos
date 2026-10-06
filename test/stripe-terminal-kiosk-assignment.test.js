const assert = require("assert");
const { buildStripeTerminalModule } = require("../src/modules/m_stripeTerminal");
const { buildStripeTerminalReaderService } = require("../src/services/stripeTerminalReaders");

const tests = [];
const test = (name, run) => tests.push({ name, run });

const address = { line1: "10 rue de Paris", postalCode: "75001", city: "Paris", country: "FR" };
const context = { shopId: 7, actorUserId: 10 };

const readerRow = (overrides = {}) => ({
  id: 21,
  shopid: 7,
  terminal_location_id: 5,
  stripe_reader_id: "tmr_21",
  serial_number: "S710-123",
  device_type: "stripe_s710",
  label: "Borne reader",
  status: "online",
  assigned_user_id: null,
  assigned_service_point_id: 44,
  is_active: 1,
  ...overrides,
});

const locationRow = () => ({
  id: 5,
  shopid: 7,
  stripe_location_id: "tml_5",
  display_name: "Restaurant 7",
  address_line1: address.line1,
  postal_code: address.postalCode,
  city: address.city,
  country: "FR",
});

const fixture = ({
  readers = [],
  servicePoints,
  users,
  location = locationRow(),
} = {}) => {
  const state = {
    readers,
    location,
    writes: [],
    stripeCalls: [],
    servicePoints: servicePoints || [
      { id: 44, shopid: 7, type: "kiosk", is_active: 1 },
      { id: 45, shopid: 7, type: "kiosk", is_active: 1 },
      { id: 46, shopid: 7, type: "table", is_active: 1 },
      { id: 47, shopid: 7, type: "kiosk", is_active: 0 },
      { id: 48, shopid: 8, type: "kiosk", is_active: 1 },
    ],
    users: users || [
      { id: 10, shopid: 7, access: 0, status: 1 },
      { id: 11, shopid: 7, access: 1, status: 1 },
    ],
  };

  const terminalStore = {
    findLocation: async ({ shopId }) =>
      state.location && state.location.shopid === shopId ? state.location : null,
    createLocation: async (data) => {
      state.writes.push(data);
      state.location = { ...locationRow(), shopid: data.shopId, stripe_location_id: data.stripeLocationId };
      return { insertId: state.location.id, affectedRows: 1 };
    },
    listReaders: async ({ shopId }) => state.readers.filter((reader) => reader.shopid === shopId),
    findReader: async ({ shopId, readerId }) =>
      state.readers.find((reader) => reader.shopid === shopId && reader.id === readerId) || null,
    findAssignedReader: async ({ shopId, userId }) =>
      state.readers.find((reader) =>
        reader.shopid === shopId && reader.assigned_user_id === userId && reader.is_active === 1) || null,
    findAssignedReaderByServicePoint: async ({ shopId, servicePointId }) =>
      state.readers.find((reader) =>
        reader.shopid === shopId && reader.assigned_service_point_id === servicePointId && reader.is_active === 1) || null,
    createReader: async (data) => {
      state.writes.push(data);
      const row = readerRow({
        id: 21 + state.readers.length,
        shopid: data.shopId,
        terminal_location_id: data.locationId,
        stripe_reader_id: data.stripeReaderId,
        serial_number: data.serialNumber,
        device_type: data.deviceType,
        label: data.label,
        status: data.status,
        assigned_user_id: data.assignedUserId == null ? null : data.assignedUserId,
        assigned_service_point_id: data.assignedServicePointId == null ? null : data.assignedServicePointId,
      });
      state.readers.push(row);
      return { insertId: row.id, affectedRows: 1 };
    },
    updateReader: async (data) => {
      state.writes.push(data);
      const row = await terminalStore.findReader(data);
      if (!row) return { affectedRows: 0 };
      if (data.assignedUserId !== undefined) row.assigned_user_id = data.assignedUserId;
      if (data.assignedServicePointId !== undefined) row.assigned_service_point_id = data.assignedServicePointId;
      if (data.isActive !== undefined) row.is_active = data.isActive;
      return { affectedRows: 1 };
    },
  };
  const staffStore = {
    findUserByIdAndShop: async ({ id, shopId }) =>
      state.users.find((user) => user.id === id && user.shopid === shopId) || null,
    findServicePointByIdAndShop: async ({ id, shopId }) =>
      state.servicePoints.find((point) => point.id === id && point.shopid === shopId) || null,
  };
  terminalStore.withRegistrationLock = async ({ shopId }, work) => work({ terminalStore, staffStore });
  const stripe = {
    terminal: {
      locations: {
        create: async () => {
          state.stripeCalls.push({ name: "locations.create" });
          return { id: "tml_5" };
        },
        del: async (id) => {
          state.stripeCalls.push({ name: "locations.del", id });
          return { id, deleted: true };
        },
      },
      readers: {
        create: async (params) => {
          state.stripeCalls.push({ name: "readers.create", params });
          return {
            id: "tmr_new",
            serial_number: "S710-123",
            device_type: "stripe_s710",
            status: "online",
          };
        },
        del: async (id) => {
          state.stripeCalls.push({ name: "readers.del", id });
          return { id, deleted: true };
        },
      },
    },
  };
  const service = buildStripeTerminalReaderService({ stripe, terminalStore, staffStore });
  return { state, terminalStore, staffStore, service };
};

const registration = (overrides = {}) => ({
  ...context,
  registrationCode: "test-registration-code",
  label: "Borne 1",
  assignedServicePointId: 44,
  address: { ...address },
  ...overrides,
});

const rejectsWithoutMutation = async (f, work, code) => {
  await assert.rejects(work, (error) => error.code === code);
  assert.deepStrictEqual(f.state.stripeCalls, []);
  assert.deepStrictEqual(f.state.writes, []);
};

test("registration accepts an active kiosk service point assignment", async () => {
  const f = fixture();
  const result = await f.service.registerReader(registration());
  assert.strictEqual(result.assignedUserId, null);
  assert.strictEqual(result.assignedServicePointId, 44);
  assert.deepStrictEqual(f.state.stripeCalls.map((call) => call.name), ["readers.create"]);
  assert.strictEqual(f.state.writes[0].assignedUserId, null);
  assert.strictEqual(f.state.writes[0].assignedServicePointId, 44);
});

test("assignment can move a reader from cashier to kiosk and clears the cashier", async () => {
  const f = fixture({ readers: [readerRow({ assigned_user_id: 11, assigned_service_point_id: null })] });
  const result = await f.service.assignReader({ ...context, readerId: 21, assignedServicePointId: 44 });
  assert.strictEqual(result.assignedUserId, null);
  assert.strictEqual(result.assignedServicePointId, 44);
  assert.strictEqual(f.state.readers[0].assigned_user_id, null);
  assert.strictEqual(f.state.readers[0].assigned_service_point_id, 44);
  assert.strictEqual(f.state.writes[0].assignedUserId, null);
  assert.strictEqual(f.state.writes[0].assignedServicePointId, 44);
});

test("assignment payloads must target either a cashier or a kiosk but not both", async () => {
  for (const input of [
    registration({ assignedUserId: 11 }),
    { ...context, readerId: 21 },
  ]) {
    const f = fixture({ readers: [readerRow()] });
    const work = input.registrationCode
      ? () => f.service.registerReader(input)
      : () => f.service.assignReader(input);
    await rejectsWithoutMutation(f, work, "TERMINAL_INVALID_INPUT");
  }
});

for (const [name, assignedServicePointId] of [
  ["table", 46],
  ["inactive kiosk", 47],
  ["cross-shop kiosk", 48],
  ["missing kiosk", 999],
]) {
  test(`assignment rejects ${name} service points before mutation`, async () => {
    const f = fixture({ readers: [readerRow({ assigned_service_point_id: null })] });
    await rejectsWithoutMutation(
      f,
      () => f.service.assignReader({ ...context, readerId: 21, assignedServicePointId }),
      "TERMINAL_INVALID_ASSIGNEE"
    );
  });
}

test("a second active reader cannot use the same kiosk assignment", async () => {
  const f = fixture({
    readers: [
      readerRow({ id: 21, assigned_service_point_id: 44 }),
      readerRow({ id: 22, assigned_service_point_id: null }),
    ],
  });
  await rejectsWithoutMutation(
    f,
    () => f.service.assignReader({ ...context, readerId: 22, assignedServicePointId: 44 }),
    "TERMINAL_ASSIGNMENT_CONFLICT"
  );
});

test("repository finds active readers assigned to a service point in the shop", async () => {
  const calls = [];
  const reader = readerRow();
  const store = buildStripeTerminalModule({
    connection: {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return [[reader]];
      },
    },
  });
  assert.deepStrictEqual(await store.findAssignedReaderByServicePoint({
    shopId: 7,
    servicePointId: 44,
    forUpdate: true,
  }), reader);
  assert.match(calls[0].sql, /JOIN service_points/);
  assert.match(calls[0].sql, /r\.shopid = \?/);
  assert.match(calls[0].sql, /r\.assigned_service_point_id = \?/);
  assert.match(calls[0].sql, /r\.is_active = 1/);
  assert.match(calls[0].sql, /sp\.is_active = 1/);
  assert.match(calls[0].sql, /sp\.type = 'kiosk'/);
  assert.match(calls[0].sql, /FOR UPDATE/);
  assert.deepStrictEqual(calls[0].params, [7, 44]);
});

(async () => {
  const selected = tests.filter(({ name }) => !process.argv[2] || name.includes(process.argv[2]));
  assert(selected.length, "No tests matched the requested filter");
  for (const { name, run } of selected) {
    await run();
    console.log(`PASS ${name}`);
  }
  console.log(`stripe terminal kiosk assignment tests passed (${selected.length} tests)`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
