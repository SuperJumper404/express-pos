const assert = require("assert");
const http = require("http");
const { buildDeliveryQuotes } = require("../src/modules/m_deliveryQuotes");
const { buildOrderQuoteModule } = require("../src/modules/m_orderQuote");
const { buildDeliveryTokenCodec } = require("../src/helpers/deliveryAddress");
const { buildDeliveryGeocoding, buildSqlGeocodingQuota, requestJson } = require("../src/services/deliveryGeocoding");
const { buildDeliverySettings, buildSqlDeliverySettingsRepository, defaultSettings } = require("../src/modules/m_deliverySettings");
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
const response = () => ({ set() { return this; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return body; } });

const reviewQuoteFixture = async (overrides = {}) => {
  const tokenCodec = buildDeliveryTokenCodec({ secret: "test-only-delivery-token-secret-32-bytes" });
  const quotedSettings = { ...settings, minimumItemsCents: 0, freeDeliveryThresholdCents: 95, bands: [{ upToMeters: 6000, feeCents: 200 }], ...overrides };
  const quotes = buildDeliveryQuotes({
    repository: { getSettings: async () => quotedSettings }, tokenCodec,
    quoteOrderItems: async () => ({ total: 1.05 }),
    geocoder: { resolve: async () => ({ ...address, ...settings.origin, providerId: "review-fixture" }) },
  });
  const proof = await quotes.resolveAddress({ shopId: 7, address });
  return { quotes, input: { shopId: 7, items: [{ productId: 21, quantity: 1, selectedChoiceIds: [] }], discount: { type: "percent", value: 10 }, addressResolutionToken: proof.addressResolutionToken } };
};

async function reviewDiscountRegression() {
  const { quotes, input } = await reviewQuoteFixture();
  const quote = await quotes.createQuote(input);
  assert.deepEqual([quote.itemsDiscountCents, quote.itemsNetCents, quote.deliveryFeeCents, quote.grandTotalCents], [11, 94, 200, 294], "105c at 10% must round half up before the free threshold");
  const minimum = await reviewQuoteFixture({ minimumItemsCents: 95 });
  await assert.rejects(minimum.quotes.createQuote(minimum.input), { code: "DELIVERY_MINIMUM_NOT_MET" });
}

async function reviewSettingsRegression() {
  const sqlRows = [3000, 6000].map((upToMeters, i) => ({
    revision: 1, enabled: 1, origin_latitude: "48.8200000", origin_longitude: "2.3600000", max_distance_meters: 6000,
    minimum_items_cents: "1500", free_delivery_enabled: 1, free_delivery_threshold_cents: "2500",
    fiscal_mode: "configured_rate", vat_rate: "10.00", up_to_meters: upToMeters, fee_cents: i ? "400" : "200",
  }));
  for (const field of ["minimum_items_cents", "free_delivery_threshold_cents", "fee_cents"]) {
    for (const bad of ["9007199254740993", "broken", "1.5", "1e3", "", "-1", null, Infinity]) {
      const repository = buildSqlDeliverySettingsRepository({ pool: { query: async () => [sqlRows.map(row => ({ ...row, [field]: bad }))] } });
      await assert.rejects(repository.getSettings({ shopId: 7 }), { code: "DELIVERY_SETTINGS_INVALID" }, `${field} must reject ${String(bad)} before returning settings`);
    }
  }
  const unsafe = { ...settings, minimumItemsCents: 9007199254740992 };
  const invalidService = buildDeliverySettings({ repository: { getSettings: async () => unsafe } });
  await assert.rejects(invalidService.getSettings({ shopId: 7 }), { code: "DELIVERY_SETTINGS_INVALID" });
  const invalidQuote = await reviewQuoteFixture(unsafe);
  await assert.rejects(invalidQuote.quotes.createQuote(invalidQuote.input), { code: "DELIVERY_SETTINGS_INVALID" });
  const missing = buildDeliverySettings({ repository: buildSqlDeliverySettingsRepository({ pool: { query: async () => [[]] } }) });
  assert.equal((await missing.getSettings({ shopId: 7 })).enabled, false);
}

async function reviewAddressRegression() {
  const streetAddress = { street: "Rue Nationale", postalCode: "75013", city: "Paris", country: "FR", complement: "Portail B" };
  const streetFeature = { ...feature("street-nationale"), properties: { ...feature().properties, id: "street-nationale", type: "street", housenumber: undefined, street: "Rue Nationale", name: "Rue Nationale", label: "Rue Nationale 75013 Paris", score: 0.65 } };
  const localityAddress = { street: "Les Ch\u00eanes", postalCode: "12340", city: "Bozouls", country: "FR" };
  const localityFeature = { ...feature("locality-chenes", [2.72, 44.47]), properties: { id: "locality-chenes", _type: "address", type: "locality", name: "Les Ch\u00eanes", label: "Les Ch\u00eanes 12340 Bozouls", postcode: "12340", city: "Bozouls", citycode: "12033", score: 0.65 } };
  const serviceFor = payload => buildDeliveryGeocoding({ reserveQuota: async () => {}, transport: async () => ({ type: "FeatureCollection", features: [payload] }) });
  for (const [input, candidate, precision] of [[streetAddress, streetFeature, "street"], [localityAddress, localityFeature, "locality"]]) {
    const service = serviceFor(candidate);
    const selected = await service.resolve({ shopId: 7, address: input, candidateId: candidate.properties.id });
    assert.equal(selected.precision, precision);
    assert.equal(selected.street, input.street);
    assert.equal(selected.providerLabel, candidate.properties.label);
    assert.equal(selected.providerId, candidate.properties.id);
    assert.deepEqual([selected.longitude, selected.latitude], candidate.geometry.coordinates);
    const codec = buildDeliveryTokenCodec({ secret: "test-only-delivery-token-secret-32-bytes" });
    const quotes = buildDeliveryQuotes({
      repository: { getSettings: async () => ({ ...settings, origin: { latitude: selected.latitude, longitude: selected.longitude } }) },
      quoteOrderItems: async () => ({ total: 25 }), geocoder: service, tokenCodec: codec,
    });
    const proof = await quotes.resolveAddress({ shopId: 7, address: input, candidateId: candidate.properties.id });
    const quote = await quotes.createQuote({ shopId: 7, items: [{ productId: 21, quantity: 1, selectedChoiceIds: [] }], addressResolutionToken: proof.addressResolutionToken });
    assert.equal(quote.addressSnapshot.precision, precision);
    assert.equal(quote.addressSnapshot.providerLabel, candidate.properties.label);
    assert.equal(quotes.validateQuoteToken(quote.quoteToken, { shopId: 7 }).addressSnapshot.precision, precision);
    assert.equal(quote.addressSnapshot.complement, input.complement || "");
    await assert.rejects(service.resolve({ shopId: 7, address: input }), { code: "DELIVERY_ADDRESS_INVALID" }, "unnumbered locations always require explicit selection");
    await assert.rejects(service.resolve({ shopId: 7, address: { ...input, street: `12 ${input.street}` }, candidateId: candidate.properties.id }), { code: "DELIVERY_ADDRESS_INVALID" }, "never silently discard a requested house number");
    for (const properties of [
      { ...candidate.properties, type: "municipality" },
      { ...candidate.properties, _type: "poi" },
      { ...candidate.properties, postcode: "99999" },
      { ...candidate.properties, city: "Autre commune" },
      { ...candidate.properties, street: "Autre voie", name: "Autre voie" },
      { ...candidate.properties, label: "" },
    ]) {
      const bad = serviceFor({ ...candidate, properties });
      await assert.rejects(bad.resolve({ shopId: 7, address: input, candidateId: properties.id }), { code: "DELIVERY_ADDRESS_INVALID" });
    }
  }
  const lowScoreHouse = feature();
  lowScoreHouse.properties.score = 0.65;
  assert.equal((await serviceFor(lowScoreHouse).resolve({ shopId: 7, address })).precision, "housenumber");
  await assert.rejects(serviceFor(feature()).resolve({ shopId: 7, address: { ...address, street: "13 rue de l'\u00c9glise" }, candidateId: "address-12" }), { code: "DELIVERY_ADDRESS_INVALID" });
}

async function reviewRegressions() {
  const failures = [];
  for (const [name, test] of [["I1 integer discount thresholds", reviewDiscountRegression], ["I2 loaded settings safety", reviewSettingsRegression], ["I3 selected postal precision", reviewAddressRegression]]) {
    try { await test(); console.log(`PASS ${name}`); }
    catch (error) { console.error(`FAIL ${name}: ${error.message}`); failures.push(error); }
  }
  assert.equal(failures.length, 0, "Task2 review regressions must all pass");
}

function mailjetTransportRegression() {
  require("child_process").execFileSync(process.execPath, ["-e", `
    const assert = require('assert/strict');
    const http = require('http');
    const https = require('https');
    require('node-mailjet');
    const { requestJson } = require('./src/services/deliveryGeocoding');
    (async () => {
      let requests = 0;
      const server = http.createServer((req, res) => {
        requests++;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ method: req.method, path: req.url, accept: req.headers.accept }));
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const original = https.request;
      // Redirect only the TLS boundary; keep Mailjet's real patched get overload.
      https.request = (options, callback) => http.request({ ...options, protocol: 'http:' }, callback);
      try {
        for (const protocol of ['http', 'https']) {
          const url = new URL(protocol + '://127.0.0.1:' + server.address().port + '/geocodage/search?q=60+rue+Fran%C3%A7ois+Ier&postcode=75008');
          assert.deepEqual(await requestJson(url, { timeoutMs: 1000 }), {
            method: 'GET', path: '/geocodage/search?q=60+rue+Fran%C3%A7ois+Ier&postcode=75008', accept: 'application/json'
          });
        }
        assert.equal(requests, 2, 'one request per lookup, without automatic retries');
        console.log('PASS geocoding transport after real Mailjet bootstrap (HTTP and HTTPS)');
      } finally {
        https.request = original;
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: require("path").join(__dirname, ".."), env: { ...process.env, ENV_FILE: "NUL" }, timeout: 10000, stdio: "inherit" });
}

async function unitTests() {
  mailjetTransportRegression();
  for (const secret of ["", "too-short"]) {
    let geocoderCalls = 0;
    const unconfigured = buildDeliveryQuotes({
      repository: {}, quoteOrderItems: async () => ({}),
      tokenCodec: buildDeliveryTokenCodec({ secret }),
      geocoder: { resolve: async () => { geocoderCalls++; return { ...address, latitude: 48.82, longitude: 2.36 }; } },
    });
    await assert.rejects(unconfigured.resolveAddress({ shopId: 7, address }), { code: "DELIVERY_UNAVAILABLE" });
    assert.equal(geocoderCalls, 0, "missing signing configuration must refuse before any geocoder request");
  }
  await reviewRegressions();
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
  const disabledQuotes = buildDeliveryQuotes({ repository: { getSettings: async ({ shopId }) => defaultSettings(shopId) } });
  await assert.rejects(disabledQuotes.createQuote(input), { code: "DELIVERY_DISABLED" });
  const { execFileSync } = require("child_process");
  const childEnv = { ...process.env, ENV_FILE: "NUL" };
  delete childEnv.DELIVERY_TOKEN_SECRET;
  execFileSync(process.execPath, ["-e", "require('./src/routers/r_delivery').buildDeliveryRouter(); const q=require('./src/modules/m_deliveryQuotes').buildDeliveryQuotes({repository:{},quoteOrderItems:async()=>({}),geocoder:{resolve:async()=>{throw Error('unexpected geocoder')}}}); q.resolveAddress({shopId:7,address:{}}).then(()=>process.exitCode=1,e=>{require('assert').equal(e.code,'DELIVERY_UNAVAILABLE'); console.log('lazy boot and missing signer preflight passed')})"], { cwd: require("path").join(__dirname, ".."), env: childEnv });
  console.log("delivery quotes tests passed (server prices/discounts, IGN privacy/cache/errors, HTTP scope/roles, expiry, timeout)");
}

async function databaseTests() {
  const { withDeliveryDatabase } = require("./helpers/deliveryDatabase");
  await withDeliveryDatabase(async ({ pool, seedScenario, readRows }) => {
    await seedScenario();
    const settingsService = buildDeliverySettings({ repository: buildSqlDeliverySettingsRepository({ pool }) });
    assert.equal((await settingsService.getSettings({ shopId: 7 })).enabled, false);
    await pool.query("UPDATE shop_delivery_settings SET minimum_items_cents = '9007199254740991', free_delivery_threshold_cents = '9007199254740991', max_distance_meters = 6000 WHERE shopid = 7");
    await pool.query("INSERT INTO shop_delivery_fee_bands (shopid, up_to_meters, fee_cents) VALUES (7, 6000, '9007199254740991')");
    const maximum = await settingsService.getSettings({ shopId: 7 });
    assert.deepEqual([maximum.minimumItemsCents, maximum.freeDeliveryThresholdCents, maximum.bands[0].feeCents], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]);
    for (const field of ["minimum_items_cents", "free_delivery_threshold_cents", "fee_cents"]) {
      const table = field === "fee_cents" ? "b" : "s";
      const unsafeRead = buildSqlDeliverySettingsRepository({ pool: { query: (sql, params) => pool.query(sql.replace(`CAST(${table}.${field} AS CHAR)`, "CAST('9007199254740993' AS CHAR)"), params) } });
      await assert.rejects(unsafeRead.getSettings({ shopId: 7 }), { code: "DELIVERY_SETTINGS_INVALID" }, "reject an unsafe CHAR returned by actual MySQL, even though stored values obey CHECK constraints");
    }
    await pool.query("DELETE FROM shop_delivery_fee_bands WHERE shopid = 7");
    await pool.query("UPDATE shop_delivery_settings SET minimum_items_cents = 0, free_delivery_threshold_cents = NULL, max_distance_meters = 0 WHERE shopid = 7");
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
