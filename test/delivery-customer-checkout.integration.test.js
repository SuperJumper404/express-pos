const assert = require("assert/strict");
const { test } = require("node:test");
const express = require("express");
const jwt = require("jsonwebtoken");
const { withDeliveryDatabase } = require("./helpers/deliveryDatabase");
const { withHttp } = require("./customer-cors.test");
const { withProviderHttp, config } = require("./customer-code-transports.test");

process.env.ENV_FILE = "NUL";
process.env.JWTKEY = config().jwtSecret;
process.env.CUSTOMER_AUTH_SECRET = config().secret;
process.env.CUSTOMER_ALLOWED_ORIGINS = "https://shop.smarteat.test";
process.env.DELIVERY_TOKEN_SECRET = "task12-disposable-delivery-signing-fixture";
const origin = process.env.CUSTOMER_ALLOWED_ORIGINS;

test("Task12 actual checkout routes, customer sessions and disposable SQL", async t => {
  await withDeliveryDatabase(async db => {
    await db.seedScenario();
    require.cache[require.resolve("../src/config/dbPool")] = { exports: db.pool };
    require.cache[require.resolve("../src/config/db")] = { exports: db.pool.pool };
    if (Number(process.versions.node.split(".")[0]) < 22) require.cache[require.resolve("nanoid")] = { exports: await import("nanoid") };
    const { buildCustomerAuth } = require("../src/modules/m_customerAuth");
    const { buildCustomerSession } = require("../src/helpers/customerSession");
    const { buildCustomerCodeTransports } = require("../src/services/customerCodeTransports");
    const { buildCustomerAuthController } = require("../src/controllers/c_customers");
    const { buildCustomersRouter } = require("../src/routers/r_customers");
    const { signAddressResolution } = require("../src/helpers/deliveryAddress");
    const quotes = require("../src/modules/m_deliveryQuotes").buildDeliveryQuotes();
    const checkout = require("../src/modules/m_checkout");
    await db.pool.query("UPDATE products SET price=25,track_stock=1,vat_rate_takeaway=5.5,vat_rate_dine_in=20 WHERE id=21");
    await db.pool.query(`INSERT INTO service_points (id,shopid,name,type,system_key,created) VALUES
      (70,7,'Counter','counter','counter',NOW()),(71,7,'Web','click_collect','click_collect',NOW()),
      (80,8,'Other web','click_collect','click_collect',NOW())`);
    await db.pool.query(`UPDATE shop_delivery_settings SET enabled=1,revision=1,origin_latitude=48.8566,
      origin_longitude=2.3522,max_distance_meters=5000,minimum_items_cents=0,free_delivery_enabled=1,
      free_delivery_threshold_cents=2500,fiscal_mode='configured_rate',vat_rate=10 WHERE shopid=7`);
    await db.pool.query("INSERT INTO shop_delivery_fee_bands (shopid,up_to_meters,fee_cents) VALUES (7,5000,400)");
    await db.pool.query("UPDATE shop SET qr_payment_mode='stripe_before_order',stripe_account_id='acct_local_fixture',stripe_charges_enabled=1 WHERE id=7");
    const staff = jwt.sign({ id: 10, shopid: 7, access: 1 }, config().jwtSecret);
    const web = jwt.sign({ subject_type: "service_point", service_point_id: 71, shopid: 7, access: 2, source: "web" }, config().jwtSecret);
    const foreign = jwt.sign({ subject_type: "service_point", service_point_id: 80, shopid: 8, access: 2, source: "web" }, config().jwtSecret);
    const snapshot = { street: "7 rue Test", postalCode: "75001", city: "Paris", country: "FR", latitude: 48.857, longitude: 2.353 };
    let serial = 0;
    const attempt = async (extra = {}) => {
      const addressToken = signAddressResolution({ shopId: 7, addressSnapshot: snapshot });
      const quote = await quotes.createQuote({ shopId: 7, items: [{ productId: 21, quantity: 1, selectedChoiceIds: [] }], addressResolutionToken: addressToken });
      return { client_order_token: `task12-${++serial}`, customer: "Guest without email", phone: "0700000000",
        service_point_id: 70, expected_total: 25, payment: "cash", fulfillment_type: "delivery",
        address_resolution_token: addressToken, delivery_quote_token: quote.quoteToken,
        delivery_confirmation_secret: "d".repeat(64), items: [{ product_id: 21, quantity: 1, selected_product_step_choice_ids: [] }], ...extra };
    };
    const readOrder = async id => (await db.readRows("SELECT *, CAST(customer_account_id AS CHAR) AS customer_account_id,CAST(delivery_id AS CHAR) AS delivery_id FROM orders WHERE id=?", [id]))[0];
    await withProviderHttp(async boundary => {
      boundary.setResponse((req, res) => res.end(JSON.stringify(req.path.startsWith("/v3.1") ?
        { Messages: [{ Status: "success", To: [{ MessageUUID: "fixture" }] }] } : { messages: [{ id: "fixture" }] })));
      const transports = buildCustomerCodeTransports({ getConfig: config });
      const auth = buildCustomerAuth({ transports, secret: config().secret, randomCode: () => "123456" });
      const sessions = buildCustomerSession();
      const app = express();
      const { buildCustomerCors, isCustomerCorsRequest } = require("../src/helpers/customerCors");
      app.use(buildCustomerCors({ prefix: "/api", allowedOrigins: [origin] }));
      app.use((req, res, next) => { if (!isCustomerCorsRequest(req, "/api")) res.set("Access-Control-Allow-Origin", "*"); next(); });
      app.use(express.json());
      app.use("/api", buildCustomersRouter({ customerAuthController: buildCustomerAuthController({ customerAuth: auth, sessions, transports }) }));
      const stripeController = require("../src/controllers/c_stripe");
      let paymentStarts = 0;
      const paymentIntents = new Map();
      const provider = express();
      provider.use(express.json());
      provider.post("/intents", (req, res) => {
        paymentStarts++;
        const intent = { id: `pi_local_${paymentStarts}`, client_secret: "local-provider-secret", status: "requires_payment_method", currency: "eur", amount: req.body.amount };
        paymentIntents.set(intent.id, intent);
        res.json(intent);
      });
      await withHttp(provider, async providerRequest => {
        const originalStripe = stripeController.createQrTablePaymentIntent;
        stripeController.createQrTablePaymentIntent = stripeController.buildQrTablePaymentIntentController({
          getStripe: () => ({ paymentIntents: {
            create: async params => (await providerRequest("/intents", { method: "POST", body: params })).data,
            retrieve: async id => paymentIntents.get(id),
          } }), publishableKey: "pk_local_fixture", logger: { error() {} },
        });
        try {
          // Execute actual routing declarations, not a reconstructed checkout chain.
          app.use("/api", require("../src/routers/r_orders"));
          app.use("/api", require("../src/routers/r_stripe").routers);
          app.use("/api", require("../src/routers/r_delivery"));
          await withHttp(app, async request => {
            const headers = (bearer, who) => ({ Authorization: `Bearer ${bearer}`, ...(who ? { Cookie: who.cookie, Origin: origin, "X-CSRF-Token": who.csrf } : {}) });
            const post = (body, bearer = staff, who, path = "/api/orders/checkout") => request(path, { method: "POST", body, headers: headers(bearer, who) });
            const login = async (channel, shopId = 7) => {
              const binding = "task12-browser-binding-32-bytes-fixture";
              const started = await request("/api/customer-auth/challenges", { method: "POST", headers: { Origin: origin }, body: {
                shopId, channel, destination: channel === "email" ? `guest-${++serial}@example.test` : "+33612345678", browserBinding: binding,
              } });
              assert.equal(started.status, 200);
              const result = await request("/api/customer-auth/verify", { method: "POST", headers: { Origin: origin }, body: {
                shopId, challengeId: started.data.data.challengeId, code: "123456", browserBinding: binding,
              } });
              assert.equal(result.status, 200);
              return { cookie: result.headers["set-cookie"][0].split(";")[0], csrf: result.data.data.csrfToken, id: result.data.data.customerId };
            };
            await t.test("safe availability limits fields/shop/actors and keeps full settings admin-only", async () => {
              for (const bearer of [staff, web, foreign]) {
                const result = await request("/api/delivery/availability?shopId=999", { headers: headers(bearer) });
                assert.equal(result.status, 200);
                assert.deepEqual(result.data.data, { enabled: bearer !== foreign });
              }
              assert.equal((await request("/api/delivery/availability")).status, 401);
              const courier = jwt.sign({ id: 11, shopid: 7, access: 6 }, config().jwtSecret);
              assert.equal((await request("/api/delivery/availability", { headers: headers(courier) })).status, 403);
              assert.equal((await request("/api/delivery/settings", { headers: headers(staff) })).status, 403);
            });
            await t.test("guest POS and web have identical authoritative total, no email and forged account ignored", async () => {
              const pos = await post(await attempt({ customer_account_id: "51" }));
              const site = await post(await attempt({ customer_account_id: "51" }), web);
              assert.equal(pos.status, 201);
              assert.equal(site.status, 201);
              assert.equal(pos.data.data.total, 25);
              assert.equal(site.data.data.total, 25);
              assert.equal((await readOrder(pos.data.data.orderId)).customer_account_id, null);
              assert.equal((await readOrder(site.data.data.orderId)).customer_account_id, null);
            });
            await db.pool.query("ALTER TABLE customers AUTO_INCREMENT=9007199254740993");
            const email = await login("email");
            assert.equal(email.id, "9007199254740993");
            const whatsapp = await login("whatsapp");
            await t.test("email and WhatsApp accounts attach only from verified same-shop cookie to order and dossier", async () => {
              for (const who of [email, whatsapp]) {
                const result = await post(await attempt({ customer_account_id: "52" }), web, who);
                assert.equal(result.status, 201);
                const order = await readOrder(result.data.data.orderId);
                assert.equal(order.customer_account_id, who.id);
                const [delivery] = await db.readRows("SELECT CAST(customer_account_id AS CHAR) AS customer_account_id FROM deliveries WHERE id=?", [order.delivery_id]);
                assert.equal(delivery.customer_account_id, who.id);
              }
              const other = await login("email", 8);
              const result = await post(await attempt({ customer_account_id: other.id }), web, other);
              assert.equal(result.status, 201);
              assert.equal((await readOrder(result.data.data.orderId)).customer_account_id, null);
            });
            await t.test("actual route boundary variants enforce cookie CSRF after bearer auth", async () => {
              const body = await attempt();
              for (const path of ["/api/orders/checkout", "/api//orders/checkout", "/api//ORDERS/CHECKOUT/?x=1"]) {
                const denied = await request(path, { method: "POST", body, headers: { ...headers(web, email), "X-CSRF-Token": "" } });
                assert.equal(denied.status, 403);
              }
              assert.equal((await db.readRows("SELECT id FROM orders WHERE client_order_token=?", [body.client_order_token])).length, 0);
            });
            await t.test("Stripe personal CORS preflight and response use the current customer policy at prefix variants", async () => {
              for (const path of ["/api/stripe/payment-intents/qr-table", "/api//STRIPE/payment-intents/qr-table/?x=1"]) {
                const preflight = await request(path, { method: "OPTIONS", headers: { Origin: origin,
                  "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,authorization,x-csrf-token" } });
                assert.equal(preflight.status, 204);
                assert.equal(preflight.headers["access-control-allow-origin"], origin);
                assert.equal(preflight.headers["access-control-allow-credentials"], "true");
                const forbidden = await request(path, { method: "OPTIONS", headers: { Origin: "https://evil.test",
                  "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-csrf-token" } });
                assert.equal(forbidden.status, 403);
              }
            });
            await t.test("R3 free base 2500 minus one cent quotes 2899; no payment starts until reconfirmed", async () => {
              const body = await attempt({ payment: "Stripe", discount_type: "amount", discount_value: 0.01 });
              const before = paymentStarts;
              const repriced = await post(body, staff, null, "/api/stripe/payment-intents/qr-table");
              assert.equal(repriced.status, 409);
              assert.equal(repriced.data.data.code, "DELIVERY_QUOTE_CHANGED");
              assert.equal(repriced.data.data.server_quote.grandTotalCents, 2899);
              assert.equal(paymentStarts, before);
              const accepted = await post({ ...body, delivery_quote_token: repriced.data.data.server_quote.quoteToken, expected_total: 28.99 }, staff, null, "/api/stripe/payment-intents/qr-table");
              assert.equal(accepted.status, 200);
              assert.equal(paymentStarts, before + 1);
              assert.equal(paymentIntents.get(accepted.data.data.paymentIntentId).amount, 2899);
              assert.equal(Number((await readOrder(accepted.data.data.orderId)).subtotal), 28.99);
            });
            await t.test("Stripe route requires personal CSRF and attaches verified account", async () => {
              const body = await attempt({ payment: "Stripe" });
              const path = "/api/stripe/payment-intents/qr-table";
              const before = paymentStarts;
              const denied = await request(path, { method: "POST", body, headers: { ...headers(web, email), "X-CSRF-Token": "" } });
              assert.equal(denied.status, 403);
              assert.equal(paymentStarts, before);
              const result = await post(body, web, email, path);
              assert.equal(result.status, 200);
              assert.equal((await readOrder(result.data.data.orderId)).customer_account_id, email.id);
            });
            await t.test("lost-response exact replay after suspension does not create stock/order twice; refreshed proofs conflict", async () => {
              const body = await attempt();
              const accepted = await post(body);
              assert.equal(accepted.status, 201);
              const stock = await db.readRows("SELECT stock FROM products WHERE id=21");
              await db.pool.query("UPDATE shop_delivery_settings SET enabled=0,revision=2 WHERE shopid=7");
              const replay = await post(body);
              assert.equal(replay.status, 200);
              assert.equal(replay.data.data.orderId, accepted.data.data.orderId);
              assert.deepEqual(await db.readRows("SELECT stock FROM products WHERE id=21"), stock);
              assert.equal((await db.readRows("SELECT id FROM deliveries WHERE client_order_token=?", [body.client_order_token])).length, 1);
              assert.equal(replay.data.data.tracking_url, undefined);
              const changed = await post({ ...body, address_resolution_token: signAddressResolution({ shopId: 7, addressSnapshot: { ...snapshot, street: "8 rue Test" } }) });
              assert.equal(changed.status, 409);
              assert.equal(changed.data.data.code, "DELIVERY_IDEMPOTENCY_CONFLICT");
              const unavailable = await post({ ...body, client_order_token: `task12-${++serial}` });
              assert.equal(unavailable.status, 422);
              await db.pool.query("UPDATE shop_delivery_settings SET enabled=1,revision=1 WHERE shopid=7");
            });
            await t.test("concurrent actual HTTP checkouts use one SQL order/dossier/stock movement", async () => {
              const body = await attempt();
              const before = Number((await db.readRows("SELECT stock FROM products WHERE id=21"))[0].stock);
              const results = await Promise.all([post(body, web, email), post(body, web, email)]);
              assert.deepEqual(results.map(result => result.status).sort(), [200, 201]);
              assert.equal(results[0].data.data.orderId, results[1].data.data.orderId);
              assert.equal(Number((await db.readRows("SELECT stock FROM products WHERE id=21"))[0].stock), before - 1);
              assert.equal((await db.readRows("SELECT id FROM deliveries WHERE client_order_token=?", [body.client_order_token])).length, 1);
            });
            await t.test("current minimum and radius refuse before creation and preserve commercial stock", async () => {
              const body = await attempt();
              const before = await db.readRows("SELECT stock FROM products WHERE id=21");
              await db.pool.query("UPDATE shop_delivery_settings SET minimum_items_cents=2501 WHERE shopid=7");
              const minimum = await post(body);
              assert.equal(minimum.status, 422);
              assert.equal(minimum.data.data.code, "DELIVERY_MINIMUM_NOT_MET");
              await db.pool.query("UPDATE shop_delivery_settings SET minimum_items_cents=0 WHERE shopid=7");
              const radius = await post({ ...body, address_resolution_token: signAddressResolution({ shopId: 7, addressSnapshot: { ...snapshot, latitude: 49 } }) });
              assert.equal(radius.status, 422);
              assert.equal(radius.data.data.code, "DELIVERY_OUT_OF_RANGE");
              assert.equal((await db.readRows("SELECT id FROM orders WHERE client_order_token=?", [body.client_order_token])).length, 0);
              assert.deepEqual(await db.readRows("SELECT stock FROM products WHERE id=21"), before);
            });
            await t.test("private checkout details are filtered, fingerprinted, and never rewrite paid address/VAT/stock", async () => {
              const body = await attempt({ payment: "counter_pay_before:cash", delivery_address_details: { complement: "Flat 2", instructions: "Private door" } });
              const result = await post(body);
              assert.equal(result.status, 201);
              const order = await readOrder(result.data.data.orderId);
              const [dossier] = await db.readRows("SELECT address_snapshot FROM deliveries WHERE id=?", [order.delivery_id]);
              const stored = typeof dossier.address_snapshot === "string" ? JSON.parse(dossier.address_snapshot) : dossier.address_snapshot;
              assert.equal(stored.instructions, "Private door");
              assert.equal(order.payment_status, "paid");
              const before = await db.readRows("SELECT stock FROM products WHERE id=21");
              const changed = await post({ ...body, delivery_address_details: { complement: "Flat 2", instructions: "Changed door" } });
              assert.equal(changed.status, 409);
              assert.deepEqual(await db.readRows("SELECT stock FROM products WHERE id=21"), before);
              assert.equal(Number((await db.readRows("SELECT vat_rate FROM orderdetail WHERE orderid=?", [order.id]))[0].vat_rate), 5.5);
              const bad = await post({ ...await attempt(), delivery_address_details: { latitude: 0 } });
              assert.equal(bad.status, 400);
            });
            await t.test("current paid commercial state prevents new Stripe payment from frozen accepted replay", async () => {
              const body = await attempt({ payment: "Stripe" });
              const created = await post(body);
              assert.equal(created.status, 201);
              await db.pool.query("UPDATE orders SET payment_status='paid' WHERE id=?", [created.data.data.orderId]);
              const before = paymentStarts;
              const result = await post(body, staff, null, "/api/stripe/payment-intents/qr-table");
              assert.equal(result.status, 409);
              assert.equal(result.data.data.checkout_resolved, true);
              assert.equal(result.data.data.payment_status, "paid");
              assert.equal(paymentStarts, before);
              const replay = await checkout.createCheckout({ shopId: 7, actorId: 10, ...checkout.normalizeCheckoutRequestBody(body) });
              assert.equal(replay.payment_status, "requires_payment");
            });
          });
        } finally { stripeController.createQrTablePaymentIntent = originalStripe; }
      });
    });
  });
});
