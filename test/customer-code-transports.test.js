const assert = require("assert/strict");
const { test } = require("node:test");
const http = require("http");
const https = require("https");
const path = require("path");

const config = () => ({ secret: "task9-auth-secret-fixture-distinct-from-jwt", jwtSecret: "task9-jwt-fixture",
  email: "central@example.test", mailApiKey: "fixture-public-key", mailSecretKey: "fixture-private-key",
  whatsappAccessToken: "fixture-meta-token", whatsappPhoneNumberId: "777000",
  whatsappTemplateName: "smarteat_auth", whatsappTemplateLanguage: "fr", whatsappGraphVersion: "v99.0" });
const input = { channel: "email", destination: "Alice@example.test", code: "123456", expiresInMinutes: 10, locale: "fr" };

// Only the outbound HTTP boundary is replaced; Mailjet's installed SDK still runs.
async function withProviderHttp(work) {
  const requests = [];
  let respond = (_request, response) => response.end(JSON.stringify({ Messages: [{ Status: "success", To: [{ MessageUUID: "mail-fixture-id" }] }] }));
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = { path: req.url, method: req.method, headers: req.headers, body: JSON.parse(raw) };
    requests.push(request);
    res.setHeader("Content-Type", "application/json");
    await respond(request, res);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const original = https.request;
  https.request = (urlOrOptions, optionsOrCallback, callback) => {
    const isUrl = typeof urlOrOptions === "string" || urlOrOptions instanceof URL;
    const url = isUrl ? new URL(urlOrOptions) : null;
    const options = isUrl ? (typeof optionsOrCallback === "object" ? optionsOrCallback : {}) : urlOrOptions;
    const host = url ? url.hostname : options.hostname || options.host;
    assert.ok(["api.mailjet.com", "graph.facebook.com"].includes(host), `Unexpected outbound host: ${host}`);
    return http.request({ ...options, protocol: "http:", hostname: "127.0.0.1", host: "127.0.0.1",
      port: server.address().port, path: url ? url.pathname + url.search : options.path, agent: undefined },
    isUrl ? (typeof optionsOrCallback === "function" ? optionsOrCallback : callback) : optionsOrCallback);
  };
  try { return await work({ requests, setResponse: fn => { respond = fn; } }); }
  finally {
    https.request = original;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

if (require.main === module) {
  process.env.ENV_FILE = path.join(__dirname, "task9-nonexistent.env");
  test("customer code transports use real SDK with HTTP-only doubles", async t => {
    const { buildCustomerCodeTransports } = require("../src/services/customerCodeTransports");
    await withProviderHttp(async boundary => {
      const transports = buildCustomerCodeTransports({ getConfig: config });
      await t.test("Mailjet uses central sender and checks per-message status", async () => {
        assert.deepEqual(await transports.sendCode(input), { accepted: true, providerMessageId: "mail-fixture-id" });
        const request = boundary.requests[0];
        assert.equal(request.path, "/v3.1/send");
        assert.equal(request.method, "POST");
        const [message] = request.body.Messages;
        assert.deepEqual(message.From, { Email: "central@example.test", Name: "Smart Eat" });
        assert.deepEqual(message.To, [{ Email: "Alice@example.test" }]);
        assert.match(message.TextPart, /123456/);
        assert.match(message.TextPart, /10/);
        assert.doesNotMatch(JSON.stringify(request.body), /activation|delivery|livraison|https?:/i);
        boundary.setResponse((_req, res) => res.end(JSON.stringify({ Messages: [{ Status: "error", Errors: [{ ErrorMessage: JSON.stringify(input) }] }] })));
        await assert.rejects(transports.sendCode(input), error => {
          assert.equal(error.code, "CUSTOMER_CODE_UNAVAILABLE");
          assert.doesNotMatch(JSON.stringify(error), /123456|Alice|fixture-private/);
          return true;
        });
      });
      await t.test("Meta authentication body and copy-code URL button carry the same code, configured version only", async () => {
        boundary.setResponse((_req, res) => res.end(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: "meta-fixture-id" }] })));
        assert.deepEqual(await transports.sendCode({ ...input, channel: "whatsapp", destination: "+33612345678" }), { accepted: true, providerMessageId: "meta-fixture-id" });
        const request = boundary.requests.at(-1);
        assert.equal(request.path, "/v99.0/777000/messages");
        assert.equal(request.headers.authorization, "Bearer fixture-meta-token");
        assert.deepEqual(request.body, { messaging_product: "whatsapp", recipient_type: "individual", to: "33612345678", type: "template",
          template: { name: "smarteat_auth", language: { code: "fr" }, components: [
            { type: "body", parameters: [{ type: "text", text: "123456" }] },
            { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "123456" }] },
          ] } });
      });
      await t.test("discovery is lazy, contains only booleans, and requires independent auth secret plus each provider config", async () => {
        let current = {};
        const lazy = buildCustomerCodeTransports({ getConfig: () => current });
        assert.deepEqual(lazy.channels(), { email: false, whatsapp: false, sms: false, smsDevelopment: false });
        current = config();
        assert.deepEqual(lazy.channels(), { email: true, whatsapp: true, sms: false, smsDevelopment: false });
        for (const key of ["secret", "jwtSecret", "email", "mailApiKey", "mailSecretKey", "whatsappAccessToken", "whatsappPhoneNumberId", "whatsappTemplateName", "whatsappTemplateLanguage", "whatsappGraphVersion"]) {
          current = { ...config(), [key]: "" };
          const channels = lazy.channels();
          if (key === "secret") assert.deepEqual(channels, { email: false, whatsapp: false, sms: false, smsDevelopment: false });
          else if (key !== "jwtSecret") assert.equal(channels[key.startsWith("whatsapp") ? "whatsapp" : "email"], false);
        }
        current = { ...config(), secret: config().jwtSecret };
        assert.deepEqual(lazy.channels(), { email: false, whatsapp: false, sms: false, smsDevelopment: false });
        const count = boundary.requests.length;
        await assert.rejects(lazy.sendCode(input), { code: "CUSTOMER_CHANNEL_UNAVAILABLE" });
        assert.equal(boundary.requests.length, count);
      });
      await t.test("configuration is not read on construction and invalid input never sends", async () => {
        buildCustomerCodeTransports({ getConfig: () => { throw new Error("must stay lazy"); } });
        const before = boundary.requests.length;
        for (const extra of [{ code: 123456 }, { code: "00000" }, { channel: "sms" }, { destination: "bad@example.test/path" }, { expiresInMinutes: 0 }]) {
          await assert.rejects(transports.sendCode({ ...input, ...extra }));
        }
        assert.equal(boundary.requests.length, before);
      });
      await t.test("missing/malformed acknowledgements and HTTP rejection fail safely without retry", async () => {
        for (const [channel, body] of [["email", {}], ["email", { Messages: [] }], ["whatsapp", { messages: [] }]]) {
          boundary.setResponse((_req, res) => res.end(JSON.stringify(body)));
          const before = boundary.requests.length;
          await assert.rejects(transports.sendCode({ ...input, channel, destination: channel === "email" ? input.destination : "+33612345678" }), { code: "CUSTOMER_CODE_UNAVAILABLE" });
          assert.equal(boundary.requests.length, before + 1);
        }
        boundary.setResponse((_req, res) => { res.statusCode = 401; res.end(JSON.stringify({ secret: "do-not-expose" })); });
        await assert.rejects(transports.sendCode(input), { code: "CUSTOMER_CODE_UNAVAILABLE" });
      });
      await t.test("provider deadline is five seconds and never retries", async () => {
        boundary.setResponse(() => {});
        for (const channel of ["email", "whatsapp"]) {
          const before = boundary.requests.length;
          const started = Date.now();
          await assert.rejects(transports.sendCode({ ...input, channel, destination: channel === "email" ? input.destination : "+33612345678" }), { code: "CUSTOMER_CODE_TIMEOUT" });
          assert.ok(Date.now() - started >= 4900 && Date.now() - started < 7500);
          assert.equal(boundary.requests.length, before + 1);
        }
      });
    });
  });
}

module.exports = { withProviderHttp, config };
