const assert = require("assert/strict");
const http = require("http");
const https = require("https");
const express = require("express");
const jwt = require("jsonwebtoken");
const { withDeliveryDatabase } = require("./helpers/deliveryDatabase");
const { config } = require("./customer-code-transports.test");

process.env.ENV_FILE = "NUL";
Object.assign(process.env, {
  JWTKEY: config().jwtSecret, CUSTOMER_AUTH_SECRET: config().secret,
  CUSTOMER_ALLOWED_ORIGINS: "https://journey.example.test",
  DELIVERY_TOKEN_SECRET: "task17-local-disposable-signing-secret",
  STRIPE_PUBLISHABLE_KEY: "pk_test_disposable", STRIPE_WEBHOOK_SECRET: "whsec_disposable_task17",
});

async function listen(server, work) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { return await work(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

// Installed provider SDKs and production transports run; only HTTP leaves through this fixture.
async function withProviders(work) {
  const calls = { geocoder: 0, email: 0, whatsapp: 0, intents: 0, refunds: 0 };
  const intents = new Map();
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.setHeader("Content-Type", "application/json");
    const url = new URL(req.url, "http://fixture.test");
    if (url.pathname === "/geocodage/search") {
      calls.geocoder++;
      assert.doesNotMatch(req.url, /PRIVATE|intercom|instructions|complement/);
      return res.end(JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature",
        geometry: { type: "Point", coordinates: [2.353, 48.857] }, properties: { id: "task17-postal",
          label: "7 Rue Test 75001 Paris", housenumber: "7", street: "Rue Test", postcode: "75001",
          city: "Paris", type: "housenumber", _type: "address", score: 0.99 } }] }));
    }
    if (url.pathname === "/v3.1/send") {
      calls.email++;
      return res.end(JSON.stringify({ Messages: [{ Status: "success", To: [{ MessageUUID: "local-only" }] }] }));
    }
    if (url.pathname === "/v99.0/777000/messages") {
      calls.whatsapp++;
      const body = JSON.parse(raw);
      assert.equal(body.template.components[0].parameters[0].text, body.template.components[1].parameters[0].text);
      return res.end(JSON.stringify({ messages: [{ id: "local-only" }] }));
    }
    if (url.pathname === "/v1/payment_intents" && req.method === "POST") {
      calls.intents++;
      const params = new URLSearchParams(raw);
      const intent = { id: `pi_task17_${calls.intents}`, client_secret: "local-only-client-secret",
        status: "requires_payment_method", amount: Number(params.get("amount")), currency: "eur",
        payment_method_types: ["card"] };
      intents.set(intent.id, intent);
      return res.end(JSON.stringify(intent));
    }
    if (url.pathname.startsWith("/v1/payment_intents/")) return res.end(JSON.stringify(intents.get(url.pathname.split("/").pop())));
    if (url.pathname.startsWith("/v1/charges/")) return res.end(JSON.stringify({ id: url.pathname.split("/").pop(), payment_method_details: { type: "card" } }));
    if (url.pathname === "/v1/refunds") calls.refunds++;
    res.statusCode = 500;
    res.end(JSON.stringify({ error: { message: "Unexpected provider operation" } }));
  });
  await listen(server, async () => {
    const originalRequest = https.request;
    const originalGet = https.get;
    https.request = (urlOrOptions, optionsOrCallback, callback) => {
      const isUrl = typeof urlOrOptions === "string" || urlOrOptions instanceof URL;
      const url = isUrl ? new URL(urlOrOptions) : null;
      const options = isUrl ? (typeof optionsOrCallback === "object" ? optionsOrCallback : {}) : urlOrOptions;
      const host = url ? url.hostname : options.hostname || options.host;
      assert.ok(["api.mailjet.com", "graph.facebook.com", "data.geopf.fr", "api.stripe.com"].includes(host), "Unexpected outbound provider host");
      const request = http.request({ ...options, protocol: "http:", hostname: "127.0.0.1", host: "127.0.0.1",
        port: server.address().port, path: url ? url.pathname + url.search : options.path, agent: undefined },
      isUrl ? (typeof optionsOrCallback === "function" ? optionsOrCallback : callback) : optionsOrCallback);
      // Stripe waits for the TLS event before writing on a fresh HTTPS socket.
      request.on("socket", socket => { if (socket.connecting) socket.once("connect", () => socket.emit("secureConnect")); });
      return request;
    };
    https.get = (...args) => { const request = https.request(...args); request.end(); return request; };
    try { await work({ calls, intents }); }
    finally { https.request = originalRequest; https.get = originalGet; }
  });
}

async function main() {
  await withDeliveryDatabase(async db => {
    await db.seedScenario({ legacy: true });
    await db.pool.query("DELETE FROM orders");
    await db.pool.query("DELETE FROM archives");
    await db.pool.query("UPDATE users SET module_permissions='[\"delivery\",\"cashregister\"]' WHERE id=10");
    await db.pool.query("UPDATE users SET access=6,courier_available=1 WHERE id=11");
    await db.pool.query("UPDATE products SET price=26,track_stock=1,vat_rate_takeaway=5.5 WHERE id=21");
    await db.pool.query(`INSERT INTO service_points (id,shopid,name,type,system_key,created) VALUES
      (70,7,'Counter','counter','counter',NOW()),(71,7,'Web','click_collect','click_collect',NOW())`);
    await db.pool.query(`INSERT INTO shop_delivery_settings (shopid,enabled,revision,origin_latitude,origin_longitude,
      max_distance_meters,minimum_items_cents,free_delivery_enabled,fiscal_mode,vat_rate)
      VALUES (7,1,1,48.8566,2.3522,5000,0,0,'configured_rate',10)`);
    await db.pool.query("INSERT INTO shop_delivery_fee_bands (shopid,up_to_meters,fee_cents) VALUES (7,5000,400)");
    await db.pool.query("UPDATE shop SET qr_payment_mode='stripe_before_order',stripe_account_id='acct_task17_fixture',stripe_charges_enabled=1 WHERE id=7");
    require.cache[require.resolve("../src/config/dbPool")] = { exports: db.pool };
    require.cache[require.resolve("../src/config/db")] = { exports: db.pool.pool };
    const stripe = require("stripe")("sk_test_disposable_task17", { maxNetworkRetries: 0, timeout: 5000 });
    require.cache[require.resolve("../src/config/stripe")] = { exports: { getStripe: () => stripe } };
    // Financial clock crosses Europe's repeated 02:30 hour using distinct UTC instants.
    let postingTime = "2026-10-25 00:30:00.123456";
    const clock = () => postingTime;
    const closures = require("../src/modules/m_cashClosures");
    Object.assign(closures, closures.buildCashClosures({ clock }));
    const { buildCustomerCodeTransports } = require("../src/services/customerCodeTransports");
    const transports = buildCustomerCodeTransports({ getConfig: config });
    const customerAuth = require("../src/modules/m_customerAuth").buildCustomerAuth({ transports, secret: config().secret, randomCode: () => "123456" });
    const sessions = require("../src/helpers/customerSession").buildCustomerSession();
    const app = express();
    const prefix = "/baseurl/api/v1";
    const origin = process.env.CUSTOMER_ALLOWED_ORIGINS;
    app.use(require("../src/helpers/customerCors").buildCustomerCors());
    const stripeRoutes = require("../src/routers/r_stripe");
    app.use(`${prefix}/stripe/webhook`, express.raw({ type: "application/json" }), stripeRoutes.webhookRouter);
    app.use(express.json());
    app.use(prefix, require("../src/routers/r_customers").buildCustomersRouter({ customerAuthController:
      require("../src/controllers/c_customers").buildCustomerAuthController({ customerAuth, sessions, transports }) }));
    app.use(prefix, require("../src/helpers/middleware/auth").authenticationIfPresent);
    app.use(prefix, require("../src/routers/r_orders"));
    app.use(prefix, stripeRoutes.routers);
    app.use(prefix, require("../src/routers/r_delivery").buildDeliveryRouter({ controller:
      require("../src/controllers/c_delivery").buildDeliveryController({
        cash: require("../src/modules/m_courierCash").buildCourierCash({ clock }),
        refunds: require("../src/modules/m_deliveryRefunds").buildDeliveryRefunds({ clock }),
      }) }));
    app.use(prefix, require("../src/routers/r_courier").buildCourierRouter({ controller:
      require("../src/controllers/c_courier").buildCourierController({
        collections: require("../src/modules/m_deliveryCollections").buildDeliveryCollections({ clock }),
      }) }));
    const staff = jwt.sign({ id: 10, shopid: 7, access: 1 }, config().jwtSecret);
    const courier = jwt.sign({ id: 11, shopid: 7, access: 6 }, config().jwtSecret);
    const web = jwt.sign({ subject_type: "service_point", service_point_id: 71, shopid: 7, access: 2, source: "web" }, config().jwtSecret);
    await withProviders(async providers => listen(http.createServer(app), async base => {
      const request = async (path, { body, bearer, who, method = body ? "POST" : "GET", headers = {} } = {}) => {
        const response = await fetch(base + prefix + path, { method, signal: AbortSignal.timeout(15000), headers: {
          ...(body ? { "Content-Type": "application/json" } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          ...(who ? { Cookie: who.cookie, Origin: origin, "X-CSRF-Token": who.csrf } : {}), ...headers,
        }, ...(body ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
        const raw = await response.text();
        return { status: response.status, headers: response.headers, body: raw.startsWith("{") ? JSON.parse(raw) : raw };
      };
      const ok = async (path, options, status = 200) => {
        const result = await request(path, options);
        assert.equal(result.status, status, `${path}: ${JSON.stringify(result.body)}`);
        return result.body.data;
      };
      const mutation = async (delivery, action, bearer = courier, extra = {}) => {
        const current = await ok(`/deliveries/${delivery.id}`, { bearer: staff });
        const path = bearer === courier ? `/courier/deliveries/${delivery.id}/${action}` : `/deliveries/${delivery.id}/${action}`;
        const body = { expectedVersion: current.version, idempotencyKey: `${delivery.id}-${action}`, ...extra };
        const result = await ok(path, { bearer, body });
        return { path, body, bearer, result };
      };
      const replay = async operation => ok(operation.path, { bearer: operation.bearer, body: operation.body });
      const resolve = async () => ok("/delivery/address-resolutions", { bearer: staff, body: { address: {
        street: "7 Rue Test", postalCode: "75001", city: "Paris", country: "FR", complement: "PRIVATE apartment", instructions: "PRIVATE intercom",
      } } });
      const attempt = async (key, proof, extra = {}) => {
        proof = proof || await resolve();
        const items = [{ product_id: 21, quantity: 1, selected_product_step_choice_ids: [] }];
        const quote = await ok("/delivery/quotes", { bearer: staff, body: { items, address_resolution_token: proof.addressResolutionToken } });
        assert.equal(quote.grandTotalCents, 3000);
        return { client_order_token: key, customer: "Fictional journey", phone: "0700000000", service_point_id: 70,
          expected_total: 30, payment: "cash", fulfillment_type: "delivery", items,
          address_resolution_token: proof.addressResolutionToken, delivery_quote_token: quote.quoteToken,
          delivery_confirmation_secret: "d".repeat(64), ...extra };
      };
      const create = async (key, proof, who) => {
        const body = await attempt(key, proof);
        const result = await ok("/orders/checkout", { bearer: staff, who, body }, 201);
        await prepare(result);
        return { ...result, checkoutBody: body, who };
      };
      const prepare = async order => {
        for (const status of [2, 3]) await ok(`/orders/${order.orderId}`, { bearer: staff, method: "PATCH", body: { status } });
      };
      const archive = order => ok(`/orders/archive/${order.orderId}`, { bearer: staff, body: {} });
      const assignPickup = async order => {
        await mutation(order.delivery, "assign", staff, { courierId: 11 });
        return mutation(order.delivery, "pickup");
      };
      const balance = () => ok("/delivery/couriers/11/cash-balance", { bearer: staff });
      const refund = (order, source, key) => ({ path: `/deliveries/${order.delivery.id}/refund`, bearer: staff,
        body: { returnSource: source, reason: "Restaurant confirmed full fictional return", idempotencyKey: key } });

      // A: guest web -> real Stripe reconciliation -> archive -> courier delivery.
      const onlineBody = await attempt("task17-online");
      const online = await ok("/stripe/payment-intents/qr-table", { bearer: web, body: onlineBody });
      const intent = providers.intents.get(online.paymentIntentId);
      assert.equal(intent.amount, 3000);
      Object.assign(intent, { status: "succeeded", latest_charge: "ch_task17_fixture" });
      const event = JSON.stringify({ id: "evt_task17_paid", type: "payment_intent.succeeded", data: { object: intent } });
      const webhook = () => request("/stripe/webhook", { body: event, headers: {
        "Stripe-Signature": stripe.webhooks.generateTestHeaderString({ payload: event, secret: process.env.STRIPE_WEBHOOK_SECRET }),
      } });
      assert.equal((await webhook()).status, 200);
      const onlineView = await ok(`/deliveries/${online.delivery.id}`, { bearer: staff });
      assert.equal(onlineView.paymentStatus, "paid");
      assert.notEqual(onlineView.preparationStatus, 3);
      await prepare(online);
      await archive(online);
      assert.equal((await db.readRows("SELECT id FROM orders WHERE id=?", [online.orderId])).length, 0);
      assert.equal((await db.readRows("SELECT id FROM archives WHERE delivery_id=?", [online.delivery.id])).length, 1);
      await assignPickup(online);
      const deliveredA = await mutation(online.delivery, "deliver");
      assert.equal(deliveredA.result.deliveryStatus, "delivered");
      const tracked = await ok("/delivery/tracking/read", { body: { token: online.tracking_url.split("#")[1] } });
      assert.equal(tracked.stage, "delivered");
      assert.equal(tracked.payment.totalCents, 3000);
      assert.equal(tracked.addressSnapshot.complement, undefined);
      assert.equal(providers.calls.intents, 1);
      console.log("PASS journey A guest web, actual signed webhook/payment/stock, archive before delivered");

      // B: WhatsApp login + stored address, POS cash collection, later 200-cent short handover.
      const binding = "task17-browser-binding-disposable-32-bytes";
      const challenge = await ok("/customer-auth/challenges", { headers: { Origin: origin }, body: {
        shopId: 7, channel: "whatsapp", destination: "+33612345678", browserBinding: binding,
      } });
      const login = await request("/customer-auth/verify", { headers: { Origin: origin }, body: {
        shopId: 7, challengeId: challenge.challengeId, code: "123456", browserBinding: binding,
      } });
      assert.equal(login.status, 200);
      const who = { cookie: login.headers.get("set-cookie").split(";")[0], csrf: login.body.data.csrfToken };
      const emailChallenge = await ok("/customer-auth/challenges", { headers: { Origin: origin }, body: {
        shopId: 7, channel: "email", destination: "journey@example.test", browserBinding: binding,
      } });
      await ok("/customer-auth/verify", { headers: { Origin: origin }, body: {
        shopId: 7, challengeId: emailChallenge.challengeId, code: "123456", browserBinding: binding,
      } });
      const proof = await resolve();
      const saved = await ok("/customer/addresses?shopId=7", { who, body: { addressResolutionToken: proof.addressResolutionToken, makeDefault: true } });
      const stored = await ok("/customer/address-resolutions?shopId=7", { who, body: { addressId: saved.id } });
      const denied = await request("/customer/addresses?shopId=7", { who, body: { addressResolutionToken: proof.addressResolutionToken }, headers: { Origin: "https://unauthorized.example.test" } });
      assert.equal(denied.status, 403);
      const cashOrder = await create("task17-cash", stored, who);
      assert.equal((await db.readRows("SELECT CAST(customer_account_id AS CHAR) id FROM deliveries WHERE id=?", [cashOrder.delivery.id]))[0].id, login.body.data.customerId);
      await assignPickup(cashOrder);
      const collectionB = await mutation(cashOrder.delivery, "collect-payment", courier, { method: "cash" });
      assert.equal((await balance()).remainingDueCents, 3000);
      const deliveredB = await mutation(cashOrder.delivery, "deliver");
      await archive(cashOrder);
      console.log("PASS journey B verified WhatsApp/stored address and actual POS/courier cash producers");

      // C: one courier departure, two picked-up orders, independent TPE and issue/restaurant return.
      const cardOrder = await create("task17-card");
      const returnOrder = await create("task17-return");
      await assignPickup(cardOrder);
      await assignPickup(returnOrder);
      const missions = await ok("/courier/deliveries", { bearer: courier });
      assert.ok(missions.filter(row => row.deliveryStatus === "in_transit").length >= 2);
      await db.pool.query("UPDATE users SET status=0 WHERE id=11");
      const disabled = await request(`/courier/deliveries/${cardOrder.delivery.id}/collect-payment`, { bearer: courier,
        body: { method: "external_card", expectedVersion: 3, idempotencyKey: "disabled-attempt" } });
      assert.equal(disabled.status, 403);
      assert.equal((await db.readRows("SELECT id FROM delivery_payment_collections WHERE delivery_id=?", [cardOrder.delivery.id])).length, 0);
      await db.pool.query("UPDATE users SET status=1 WHERE id=11");
      const cardCollection = await mutation(cardOrder.delivery, "collect-payment", courier, { method: "external_card" });
      const cardDelivered = await mutation(cardOrder.delivery, "deliver");
      const returnCollection = await mutation(returnOrder.delivery, "collect-payment", courier, { method: "cash" });
      const issue = await mutation(returnOrder.delivery, "report-issue", courier, { reason: "Fictional unreachable recipient" });
      const returned = await mutation(returnOrder.delivery, "resolve-issue", staff, { action: "return", reason: "Restaurant accepts physical return", physicalTransferConfirmed: true });
      assert.equal(returned.result.deliveryStatus, "unassigned");
      assert.equal(Number((await db.readRows("SELECT COUNT(*) n FROM delivery_manual_refunds"))[0].n), 0, "issue and return never refund automatically");
      assert.equal(providers.calls.refunds, 0);
      await archive(cardOrder);
      await archive(returnOrder);
      assert.equal((await balance()).remainingDueCents, 6000);

      // Full courier refund affects only the original still-held cash source.
      const courierRefund = refund(returnOrder, "courier", "task17-courier-refund");
      assert.equal((await request(courierRefund.path, { bearer: courier, body: courierRefund.body })).status, 403);
      const refundedCourier = await replay(courierRefund);
      assert.equal(refundedCourier.amountCents, 3000);
      assert.equal((await balance()).remainingDueCents, 3000);
      const externalRefund = refund(cardOrder, "external_card", "task17-external-refund");
      const refundedCard = await replay(externalRefund);
      assert.equal(refundedCard.providerVerified, false);
      assert.equal(refundedCard.confirmation, "restaurant_declaration");
      assert.equal((await balance()).remainingDueCents, 3000);
      console.log("PASS journey C two missions/departure, external TPE, issue/physical return, explicit original-source and card refunds");

      postingTime = "2026-10-25 00:59:59.999998";
      const saleClosure = await ok("/reports/z/close", { bearer: staff, body: {} }, 201);
      assert.equal(saleClosure.orders_count, 4);
      assert.equal(saleClosure.total_revenue, 120);
      const frozen = await db.readRows("SELECT * FROM cash_closures WHERE id=?", [saleClosure.id]);
      const fiscalBefore = await db.readRows("SELECT * FROM archivesdetail ORDER BY id");
      postingTime = "2026-10-25 01:30:00.123456";
      const localHour = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });
      assert.equal(localHour.format(new Date("2026-10-25T00:30:00Z")), "02:30");
      assert.equal(localHour.format(new Date("2026-10-25T01:30:00Z")), "02:30");
      const handover = { path: "/delivery/couriers/11/remittances", bearer: staff, body: {
        receivedCents: 2800, expectedBalanceVersion: (await balance()).version, idempotencyKey: "task17-short-remittance",
      } };
      const remitted = await replay(handover);
      assert.equal(remitted.remainingDueCents, 200);
      assert.equal(remitted.discrepancyCents, -200);
      // Register returns the full sale after closure; the original courier still owes 200 cents.
      const registerRefund = refund(cashOrder, "register", "task17-register-refund");
      assert.equal((await replay(registerRefund)).amountCents, 3000);
      assert.equal((await balance()).remainingDueCents, 200);
      postingTime = "2026-10-25 01:30:00.123457";
      const physicalClosure = await ok("/reports/z/close", { bearer: staff, body: {} }, 201);
      assert.equal(physicalClosure.orders_count, 0);
      assert.equal(physicalClosure.total_revenue, 0);
      assert.deepEqual(physicalClosure.vat_summary, []);
      assert.equal(physicalClosure.courier_cash.received_cents, 2800);
      assert.equal(physicalClosure.courier_cash.cash_refunded_by_register_cents, 3000);
      assert.equal(physicalClosure.courier_cash.cash_refunded_by_courier_cents, 0);
      assert.equal(physicalClosure.courier_cash.external_card_refunded_cents, 0);

      const totals = async () => db.readRows(`SELECT COUNT(*) n,SUM(subtotal) total FROM
        (SELECT id,subtotal FROM orders WHERE shopid=7 UNION ALL SELECT id,subtotal FROM archives WHERE shopid=7) sales`);
      const initialTotalSales = await totals();
      assert.deepEqual(initialTotalSales.map(row => [Number(row.n), Number(row.total)]), [[4, 120]]);
      const stock = await db.readRows("SELECT stock FROM products WHERE id=21");
      const journals = await db.readRows("SELECT * FROM stocks ORDER BY id");
      for (const operation of [deliveredA, collectionB, deliveredB, cardCollection, cardDelivered, returned,
        courierRefund, externalRefund, handover, registerRefund]) await replay(operation);
      for (const operation of [returnCollection, issue]) {
        assert.equal((await request(operation.path, { bearer: operation.bearer, body: operation.body })).status, 404,
          "original courier loses mission authority after restaurant physical return, including replay");
      }
      for (const order of [cashOrder, cardOrder, returnOrder]) {
        const repeated = await ok("/orders/checkout", { bearer: staff, who: order.who, body: order.checkoutBody });
        assert.equal(repeated.orderId, order.orderId);
        assert.equal(repeated.idempotent_replay, true);
        assert.equal(repeated.tracking_url, undefined, "checkout replay never rotates or republishes a tracking secret");
      }
      assert.equal((await webhook()).status, 200);
      const onlineReplay = await request("/stripe/payment-intents/qr-table", { bearer: web, body: onlineBody });
      assert.equal(onlineReplay.status, 409);
      assert.equal(providers.calls.intents, 1);
      assert.deepEqual(await totals(), initialTotalSales);
      assert.deepEqual(await db.readRows("SELECT stock FROM products WHERE id=21"), stock);
      assert.deepEqual(await db.readRows("SELECT * FROM stocks ORDER BY id"), journals);
      assert.deepEqual(await db.readRows("SELECT * FROM archivesdetail ORDER BY id"), fiscalBefore);
      assert.deepEqual(await db.readRows("SELECT * FROM cash_closures WHERE id=?", [saleClosure.id]), frozen);
      assert.equal((await balance()).remainingDueCents, 200);
      assert.equal(Number((await db.readRows("SELECT COUNT(*) n FROM delivery_manual_refunds"))[0].n), 3);
      assert.equal(providers.calls.whatsapp, 1);
      assert.equal(providers.calls.email, 1);
      assert.equal(providers.calls.refunds, 0);
      assert.ok(providers.calls.geocoder > 0);
      console.log("PASS R5 UTC/DST replay: four sales/120 euros, immutable VAT/stock/old closure, physical-only later period, debt 200 cents");
    }));
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
