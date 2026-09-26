const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const vm = require("vm");
const { createRequire } = require("module");
const express = require("express");

const indexPath = path.join(__dirname, "../index.js");
const indexRequire = createRequire(indexPath);

// Run the actual middleware assembly, replacing only startup, storage, and route dependencies.
const loadApp = (mode, logs) => {
  const app = express();
  app.set("env", mode);
  const routes = express.Router();
  routes.post("/stripe/terminal/readers", (req, res) => res.json(req.body));
  routes.post("/stripe/payment-intents/qr-table", (req, res) => res.json(req.body));
  const webhookRouter = express.Router();
  webhookRouter.post("/", (req, res) => res.json({ raw: Buffer.isBuffer(req.body), body: req.body.toString() }));
  const dependencies = {
    express: Object.assign(() => app, express),
    fs: { existsSync: () => true },
    "./src/config/prefix": "/api/v1",
    "./src/helpers/env": { envPUBLICIMAGEPATH: __dirname, envPORT: 0 },
    "./src/config/dbPool": {},
    "./src/helpers/waitForDatabase": { waitForDatabase: () => new Promise(() => {}) },
    "./src/services/stripePaymentMaintenance": { buildNonOverlappingRunner: () => () => {}, runStripePaymentMaintenance: () => {} },
    "./src/routers/r_stripe": { routers: routes, webhookRouter },
  };
  vm.runInNewContext(fs.readFileSync(indexPath, "utf8"), {
    require: (name) => {
      if (Object.prototype.hasOwnProperty.call(dependencies, name)) return dependencies[name];
      if (name.startsWith("./src/routers/")) return express.Router();
      return indexRequire(name);
    },
    console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    process, Buffer, setInterval,
  }, { filename: indexPath });
  return app;
};

const request = (server, route, body) => new Promise((resolve, reject) => {
  const req = http.request({
    host: "127.0.0.1", port: server.address().port, path: `/api/v1${route}`, method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
  }, (res) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { text += chunk; });
    res.on("end", () => resolve({ status: res.statusCode, text, contentType: res.headers["content-type"] }));
  });
  req.on("error", reject);
  req.end(body);
});

(async () => {
  const failures = [];
  for (const mode of ["production", "development"]) {
    const logs = [];
    const app = loadApp(mode, logs);
    const originalError = console.error;
    console.error = (...args) => logs.push(args);
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const secret = "TPEsecret";
      for (const body of [`[${secret}]`, `{"registrationCode":${secret}}`]) {
        const response = await request(server, "/stripe/terminal/readers", body);
        await new Promise(setImmediate);
        const logText = logs.flat().map(String).join("\n");
        assert.strictEqual(response.status, 400);
        assert(!response.text.includes(secret), `${mode}: registration code leaked in response`);
        assert(!logText.includes(secret), `${mode}: registration code leaked in logs`);
        assert.match(response.contentType, /application\/json/);
        assert.strictEqual(JSON.parse(response.text).error, "INVALID_JSON");
        assert(!response.text.includes("SyntaxError"));
        assert(!response.text.includes("registrationCode"));
      }
      const validBody = '{"orderIds":[1,2]}';
      const valid = await request(server, "/stripe/payment-intents/qr-table", validBody);
      assert.strictEqual(valid.status, 200);
      assert.strictEqual(valid.text, validBody);
      const webhook = await request(server, "/stripe/webhook", "intentionally-not-json");
      assert.deepStrictEqual(JSON.parse(webhook.text), { raw: true, body: "intentionally-not-json" });
      console.log(`PASS ${mode}: malformed JSON is sanitized; valid QR JSON and raw webhook are preserved`);
    } catch (error) {
      failures.push(error.message);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      console.error = originalError;
    }
  }
  assert.deepStrictEqual(failures, []);
  console.log("JSON body error tests passed (production and development)");
})().catch((error) => { console.error(error); process.exitCode = 1; });
