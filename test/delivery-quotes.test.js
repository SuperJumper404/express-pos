const assert = require("assert");
const http = require("http");
const { buildDeliveryQuotes } = require("../src/modules/m_deliveryQuotes");
const { buildOrderQuoteModule } = require("../src/modules/m_orderQuote");
const { buildDeliveryTokenCodec } = require("../src/helpers/deliveryAddress");
const { buildDeliveryGeocoding, buildSqlGeocodingQuota, requestJson } = require("../src/services/deliveryGeocoding");
const { buildDeliverySettings, buildSqlDeliverySettingsRepository } = require("../src/modules/m_deliverySettings");
const { buildDeliveryController } = require("../src/controllers/c_delivery");
const { buildDeliveryRouter } = require("../src/routers/r_delivery");

const settings = {
  shopId: 7, revision: 1, enabled: true, origin: { latitude: 48.82, longitude: 2.36 },
  maxDistanceMeters: 6000, minimumItemsCents: 1500, freeDeliveryEnabled: true, freeDeliveryThresholdCents: 2500,
  fiscalPolicy: { mode: "configured_rate", vatRate: 10 },
  bands: [{ upToMeters: 3000, feeCents: 200 }, { upToMeters: 6000, feeCents: 400 }],
};
const address = { street: "12 rue de l'\u00c9glise", postalCode: "75013", city: "Paris", country: "FR", complement: "interphone 42", instructions: "Appeler au portail" };
const feature = (id = "address-12", coords = [2.41, 48.82]) => ({ type: "Feature", geometry: { type: "Point", coordinates: coords }, properties: {
  id, label: "12 Rue de l'\u00c9glise 75013 Paris", housenumber: "12", street: "Rue de l'\u00c9glise", postcode: "75013", city: "Paris", type: "housenumber", _type: "address", score: 0.95,
} });
const response = () => ({ status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return body; } });

async function unitTests() {
  for (const failure of ["release-null", "release-throw", "rollback-throw"]) {
    let destroyed = false;
    let released = false;
    const connection = {
      async query(sql) {
        if (sql.includes("GET_LOCK")) return [[{ acquired: 1 }]];
        if (sql.includes("RELEASE_LOCK")) {
          if (failure === "release-throw") throw new Error("lost SQL connection");
          return [[{ released: failure === "release-null" ? null : 1 }]];
        }
        if (sql.includes("SUM(attempts)")) return [[{ total: failure === "rollback-throw" ? 40 : 0 }]];
        if (sql.includes("UTC_TIMESTAMP() AS now")) return [[{ now: new Date(), previous: new Date() }]];
        return [{}];
      },
      async beginTransaction() {}, async commit() {},
      async rollback() { if (failure === "rollback-throw") throw new Error("rollback failed"); },
      release() { released = true; }, destroy() { destroyed = true; },
    };
    const reserve = buildSqlGeocodingQuota({ pool: { getConnection: async () => connection } });
    await assert.rejects(reserve({ shopId: 7 }), { code: "DELIVERY_GEOCODING_UNAVAILABLE" });
    assert.equal(destroyed, true, failure);
    assert.equal(released, false, "never return a connection with a possible held lock/transaction");
  }
  let now = new Date("2026-10-17T12:00:00Z");
  const tokenCodec = buildDeliveryTokenCodec({ secret: "test-only-delivery-token-secret-32-bytes" });
  let providerCalls = 0;
  let quotaCalls = 0;
  const geocoder = buildDeliveryGeocoding({
    reserveQuota: async () => { quotaCalls++; },
    clock: () => now,
    transport: async (url, options) => {
      providerCalls++;
      assert.equal(url.origin, "https://data.geopf.fr");
      assert.equal(url.pathname, "/geocodage/search");
      assert.equal(url.searchParams.get("index"), "address");
      assert.equal(url.searchParams.get("autocomplete"), "0");
      assert.equal(url.searchParams.get("postcode"), "75013");
      assert.ok(url.searchParams.get("q").includes("\u00c9glise"));
      assert.ok(!url.href.includes("interphone") && !url.href.includes("portail"));
      assert.equal(options.timeoutMs, 5000);
      return { type: "FeatureCollection", features: [feature()] };
    },
  });
  let productPrice = 25;
  let loadedShop;
  const engine = buildOrderQuoteModule({
    repository: { getProducts: async ({ shopId }) => { loadedShop = shopId; return [{ id: 21, price: productPrice, vat_rate: 10, shopid: shopId }]; } },
    getResolvedProductConfigurations: async () => new Map(),
    buildStockRequirements: () => [],
  });
  const quotes = buildDeliveryQuotes({ repository: { getSettings: async () => settings }, quoteOrderItems: engine.quoteOrderItems, geocoder, clock: () => now, tokenCodec });
  const resolution = await quotes.resolveAddress({ shopId: 7, address });
  assert.equal(resolution.addressSnapshot.complement, "interphone 42");
  assert.equal(resolution.addressSnapshot.instructions, "Appeler au portail");
  await quotes.resolveAddress({ shopId: 8, address: { ...address, complement: "autre" } });
  assert.equal(providerCalls, 1, "postal cache is reusable without leaking private instructions");
  assert.equal(quotaCalls, 1);
  const input = { shopId: 7, items: [{ productId: 21, quantity: 1, selectedChoiceIds: [], price: 0 }], addressResolutionToken: resolution.addressResolutionToken };
  const quote = await quotes.createQuote({ ...input, discount: { type: "amount", value: 0.01 } });
  assert.equal(loadedShop, 7);
  assert.equal(quote.itemsTotalCents, 2500);
  assert.equal(quote.itemsDiscountCents, 1);
  assert.equal(quote.itemsNetCents, 2499);
  assert.equal(quote.deliveryFeeCents, 400, "R3: one cent removes free delivery");
  assert.equal(quote.grandTotalCents, 2899);
  assert.equal(quote.chargeSnapshot.bandFeeCents, 400);
  assert.equal(quote.chargeSnapshot.freeDeliveryApplied, false);
  assert.equal(quote.expiresAt, "2026-10-17T12:05:00.000Z");
  assert.equal(quotes.validateQuoteToken(quote.quoteToken).grandTotalCents, 2899);
  productPrice = 26;
  const freeQuote = await quotes.createQuote(input);
  assert.equal(freeQuote.itemsTotalCents, 2600, "prices reloaded each quote");
  assert.equal(freeQuote.chargeSnapshot.bandFeeCents, 400);
  assert.equal(freeQuote.chargeSnapshot.freeDeliveryApplied, true);
  assert.equal(freeQuote.deliveryFeeCents, 0);
  assert.equal(providerCalls, 1, "quotes reuse the signed unchanged address without provider requests");
  await assert.rejects(quotes.createQuote({ ...input, shopId: 8 }), { code: "DELIVERY_ADDRESS_INVALID" });
  await assert.rejects(quotes.createQuote({ ...input, discount: { type: "percent", value: Infinity } }), { code: "DELIVERY_REQUEST_INVALID" });
  await assert.rejects(quotes.createQuote({ ...input, items: [{ productId: 21, quantity: NaN, selectedChoiceIds: [] }] }), { code: "DELIVERY_REQUEST_INVALID" });
  now = new Date("2026-10-17T12:05:00Z");
  assert.throws(() => quotes.validateQuoteToken(quote.quoteToken), { code: "DELIVERY_QUOTE_CHANGED" });
  assert.throws(() => quotes.validateQuoteToken(quote.quoteToken + "bad"), { code: "DELIVERY_QUOTE_CHANGED" });
  now = new Date("2026-10-17T12:15:00Z");
  await assert.rejects(quotes.createQuote(input), { code: "DELIVERY_ADDRESS_INVALID" });
  for (const payload of [{ type: "FeatureCollection", features: [] }, { type: "FeatureCollection", features: [feature("a"), feature("b")] }]) {
    const service = buildDeliveryGeocoding({ reserveQuota: async () => {}, transport: async () => payload });
    await assert.rejects(service.resolve({ shopId: 7, address }), { code: "DELIVERY_ADDRESS_INVALID" });
  }
  const ambiguous = buildDeliveryGeocoding({ reserveQuota: async () => {}, transport: async () => ({ type: "FeatureCollection", features: [feature("a"), feature("b")] }) });
  assert.equal((await ambiguous.resolve({ shopId: 7, address, candidateId: "b" })).providerId, "b");
  let refusalCalls = 0;
  const refusal = buildDeliveryGeocoding({ reserveQuota: async () => {}, transport: async () => { refusalCalls++; throw new Error("provider refused"); } });
  await assert.rejects(refusal.resolve({ shopId: 7, address }), { code: "DELIVERY_GEOCODING_UNAVAILABLE" });
  await assert.rejects(refusal.resolve({ shopId: 7, address }), { code: "DELIVERY_GEOCODING_UNAVAILABLE" });
  assert.equal(refusalCalls, 2, "provider failures are not negative cached");
  let malformedCalls = 0;
  const malformed = buildDeliveryGeocoding({ reserveQuota: async () => {}, transport: async () => { malformedCalls++; return { type: "FeatureCollection", features: [feature("broken", [NaN, 1])] }; } });
  await assert.rejects(malformed.resolve({ shopId: 7, address }), { code: "DELIVERY_GEOCODING_UNAVAILABLE" });
  await assert.rejects(malformed.resolve({ shopId: 7, address }), { code: "DELIVERY_GEOCODING_UNAVAILABLE" });
  assert.equal(malformedCalls, 2);
  await assert.rejects(geocoder.resolve({ shopId: 7, address: { ...address, country: "DE" } }), { code: "DELIVERY_ADDRESS_INVALID" });

  const controller = buildDeliveryController({ quotes, settings: { getSettings: async ({ shopId }) => ({ ...settings, shopId }), updateSettings: async () => settings } });
  now = new Date("2026-10-17T12:00:00Z");
  const staff = { shopid: 7, id: 10, access: 1, sessionSubject: "staff" };
  const publicPoint = { shopid: 7, id: null, access: 0, servicePointId: 3, sessionSubject: "service_point" };
  const body = { shopId: 8, shop_id: 8, items: [{ product_id: 21, quantity: 1, selected_product_step_choice_ids: [], price: 0 }], address_resolution_token: resolution.addressResolutionToken, discount: { type: "amount", value: 0.01 } };
  const staffResult = response();
  await controller.createQuote({ ...staff, body }, staffResult);
  assert.equal(staffResult.statusCode, 200);
  assert.equal(staffResult.body.data.shopId, 7);
  assert.equal(staffResult.body.data.itemsTotalCents, 2600);
  const publicDiscount = response();
  await controller.createQuote({ ...publicPoint, body }, publicDiscount);
  assert.equal(publicDiscount.statusCode, 403);
  const publicQuote = response();
  await controller.createQuote({ ...publicPoint, body: { ...body, discount: undefined } }, publicQuote);
  assert.equal(publicQuote.statusCode, 200);
  for (const req of [publicPoint, staff, { ...staff, access: 6 }]) {
    for (const method of ["getSettings", "updateSettings"]) {
      const result = response();
      await controller[method]({ ...req, body: { ...settings, expectedRevision: 1 } }, result);
      assert.equal(result.statusCode, 403);
    }
  }
  const courier = response();
  await controller.createQuote({ ...staff, access: 6, body }, courier);
  assert.equal(courier.statusCode, 403);
  const admin = response();
  await controller.getSettings({ ...staff, access: 0 }, admin);
  assert.equal(admin.statusCode, 200);
  const initialSettings = { ...settings, enabled: false, origin: null, revision: 1 };
  const settingValidation = buildDeliverySettings({ repository: { getSettings: async () => initialSettings }, tokenCodec, clock: () => now });
  await assert.rejects(settingValidation.updateSettings({ shopId: 7, expectedRevision: 1, settings }), { code: "DELIVERY_ADDRESS_INVALID" });
  await assert.rejects(settingValidation.updateSettings({ shopId: 7, settings }), { code: "DELIVERY_SETTINGS_INVALID" });
  const originResolution = await quotes.resolveAddress({ shopId: 7, address });
  await assert.rejects(settingValidation.updateSettings({ shopId: 7, expectedRevision: 1, settings: { ...settings, originResolutionToken: originResolution.addressResolutionToken, fiscalPolicy: { mode: "configured_rate", vatRate: null } } }), { code: "DELIVERY_SETTINGS_INVALID" });

  const express = require("express");
  const app = express();
  app.use(express.json());
  app.use("/protected", buildDeliveryRouter({ controller }));
  app.use(buildDeliveryRouter({ controller, authentication: (req, res, next) => { Object.assign(req, publicPoint); next(); } }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${url}/protected/delivery/quotes`, { method: "POST" })).status, 401);
    const result = await fetch(`${url}/delivery/quotes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, discount: undefined }) });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).data.shopId, 7);
    assert.equal((await fetch(`${url}/delivery/settings`)).status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }

  const slow = http.createServer(() => {});
  await new Promise(resolve => slow.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(requestJson(new URL(`http://127.0.0.1:${slow.address().port}`), { timeoutMs: 20 }), { code: "DELIVERY_GEOCODING_UNAVAILABLE" });
  } finally { await new Promise(resolve => slow.close(resolve)); }
  for (const statusCode of [429, 503]) {
    const rejected = http.createServer((req, res) => { res.statusCode = statusCode; res.end("provider refusal"); });
    await new Promise(resolve => rejected.listen(0, "127.0.0.1", resolve));
    try {
      await assert.rejects(requestJson(new URL(`http://127.0.0.1:${rejected.address().port}`)), { code: "DELIVERY_GEOCODING_UNAVAILABLE" });
    } finally { await new Promise(resolve => rejected.close(resolve)); }
  }

  const empty = buildDeliverySettings({ repository: { getSettings: async ({ shopId }) => ({ shopId, revision: 0, enabled: false, origin: null, maxDistanceMeters: 0, minimumItemsCents: 0, freeDeliveryEnabled: false, freeDeliveryThresholdCents: null, fiscalPolicy: { mode: "configured_rate", vatRate: null }, bands: [] }) } });
  assert.equal((await empty.getSettings({ shopId: 7 })).enabled, false);
  const disabledQuotes = buildDeliveryQuotes({ repository: { getSettings: async () => ({ enabled: false }) } });
  await assert.rejects(disabledQuotes.createQuote(input), { code: "DELIVERY_DISABLED" });
  const { execFileSync } = require("child_process");
  const childEnv = { ...process.env, ENV_FILE: ".env.delivery-test-does-not-exist" };
  delete childEnv.DELIVERY_TOKEN_SECRET;
  execFileSync(process.execPath, ["-e", "require('./src/routers/r_delivery').buildDeliveryRouter(); console.log('lazy delivery boot passed')"], { cwd: require("path").join(__dirname, ".."), env: childEnv });
  console.log("delivery quotes tests passed (server prices/discounts, IGN privacy/cache/errors, HTTP scope/roles, expiry, timeout)");
}

async function databaseTests() {
  const { withDeliveryDatabase } = require("./helpers/deliveryDatabase");
  await withDeliveryDatabase(async ({ pool, seedScenario, readRows }) => {
    await seedScenario();
    const settingsService = buildDeliverySettings({ repository: buildSqlDeliverySettingsRepository({ pool }) });
    assert.equal((await settingsService.getSettings({ shopId: 7 })).enabled, false);
    const validOriginCodec = buildDeliveryTokenCodec({ secret: "test-only-delivery-token-secret-32-bytes" });
    const { signAddressResolution } = require("../src/helpers/deliveryAddress");
    const originToken = signAddressResolution({ shopId: 7, addressSnapshot: { ...address, latitude: 48.82, longitude: 2.36, providerId: "fixture" }, now: new Date(), tokenCodec: validOriginCodec });
    const service = buildDeliverySettings({ repository: buildSqlDeliverySettingsRepository({ pool }), tokenCodec: validOriginCodec });
    await pool.query("DELETE FROM shop_delivery_settings WHERE shopid = 8");
    const newOriginToken = signAddressResolution({ shopId: 8, addressSnapshot: { ...address, latitude: 48.82, longitude: 2.36, providerId: "fixture" }, now: new Date(), tokenCodec: validOriginCodec });
    const initialUpdate = { shopId: 8, expectedRevision: 0, settings: { ...settings, originResolutionToken: newOriginToken } };
    const first = await Promise.allSettled([service.updateSettings(initialUpdate), service.updateSettings(initialUpdate)]);
    assert.equal(first.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(first.find(r => r.status === "fulfilled").value.revision, 1, "first accepted revision is 1");
    assert.equal(first.find(r => r.status === "rejected").reason.code, "DELIVERY_VERSION_CONFLICT");
    const current = await service.getSettings({ shopId: 7 });
    const update = { shopId: 7, expectedRevision: current.revision, settings: { ...settings, originResolutionToken: originToken } };
    const result = await service.updateSettings(update);
    assert.equal(result.revision, current.revision + 1);
    assert.deepEqual(result.origin, settings.origin);
    const races = await Promise.allSettled([service.updateSettings({ ...update, expectedRevision: result.revision }), service.updateSettings({ ...update, expectedRevision: result.revision })]);
    assert.equal(races.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(races.find(r => r.status === "rejected").reason.code, "DELIVERY_VERSION_CONFLICT");
    const badUpdate = { ...update, expectedRevision: result.revision + 1, settings: { ...settings, bands: [] } };
    await assert.rejects(service.updateSettings(badUpdate), { code: "DELIVERY_SETTINGS_INVALID" });
    assert.equal((await service.getSettings({ shopId: 7 })).bands.length, 2);
    const repository = buildSqlDeliverySettingsRepository({ pool });
    await assert.rejects(repository.saveSettings({ shopId: 7, expectedRevision: result.revision + 1, settings: { ...settings, bands: [settings.bands[0], settings.bands[0]] } }), { code: "ER_DUP_ENTRY" });
    assert.equal((await service.getSettings({ shopId: 7 })).revision, result.revision + 1, "SQL insertion failure rolls back settings and bands together");
    assert.deepEqual((await service.getSettings({ shopId: 7 })).bands, settings.bands);

    const reserveA = buildSqlGeocodingQuota({ pool });
    const reserveB = buildSqlGeocodingQuota({ pool });
    // Pin old counters in both active seconds, proving the aggregate cannot reset per shop.
    const hash = require("crypto").createHash("sha256").update("ign-global").digest("hex");
    await pool.query(`INSERT INTO service_rate_limits (shopid, scope, subject_hash, window_start, expires_at, attempts)
      VALUES (7, 'delivery_geocoding', ?, UTC_TIMESTAMP(), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 2 SECOND), 39)`, [hash]);
    const reservations = await Promise.allSettled([reserveA({ shopId: 7 }), reserveB({ shopId: 8 })]);
    assert.equal(reservations.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(reservations.find(r => r.status === "rejected").reason.code, "DELIVERY_GEOCODING_RATE_LIMITED");
    const counters = await readRows("SELECT SUM(attempts) AS total FROM service_rate_limits WHERE scope = 'delivery_geocoding'");
    assert.equal(Number(counters[0].total), 40);
    // Narrow repository projections never select new BIGINT ids through the legacy pool.
    const projected = await service.getSettings({ shopId: 7 });
    assert.equal(projected.id, undefined);
    assert.equal(projected.bands[0].id, undefined);
    console.log("delivery quotes SQL tests passed (atomic settings/revision, shared two-shop quota, narrow identifier projection)");
  });
}
(process.argv.includes("--database") ? databaseTests() : unitTests()).catch(error => { console.error(error); process.exitCode = 1; });
