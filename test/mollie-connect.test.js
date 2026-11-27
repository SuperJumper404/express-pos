const assert = require("node:assert/strict");
const { createDecipheriv } = require("node:crypto");
const { test } = require("node:test");
const { readMollieConfig, exchangeAuthorizationCode, stateHash } = require("../src/services/mollieOAuth");
const { buildMollieController } = require("../src/controllers/c_mollie");

const env = {
  MOLLIE_CLIENT_ID: "app_demo",
  MOLLIE_CLIENT_SECRET: "fake-secret",
  MOLLIE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 42).toString("base64"),
  MOLLIE_OAUTH_REDIRECT_URI: "https://api.example.test/baseurl/api/v1/mollie/oauth/callback",
  MOLLIE_CONNECT_RETURN_URL: "https://pos.example.test/settings",
};
const config = readMollieConfig(env);

function response() {
  return {
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    redirect(code, url) { this.statusCode = code; this.location = new URL(url); return this; },
  };
}

test("uses the registered callback and exchanges the code through the Mollie API", async () => {
  assert.equal(readMollieConfig({}), null);
  assert.equal(readMollieConfig({ ...env, MOLLIE_TOKEN_ENCRYPTION_KEY: "invalid" }), null);
  assert.equal(readMollieConfig({ ...env, MOLLIE_OAUTH_REDIRECT_URI: "https://api.example.test/api/mollie" }), null);

  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.endsWith("/tokens")
      ? { access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 3600 }
      : { id: "org_123456", name: "Restaurant pilote" } };
  };
  const entity = await exchangeAuthorizationCode(config, "auth-code", request);
  assert.equal(entity.organizationId, "org_123456");
  assert.equal(calls[0].url, "https://api.mollie.com/oauth2/tokens");
  assert.equal(calls[0].options.body.get("grant_type"), "authorization_code");
  assert.equal(calls[0].options.body.get("code"), "auth-code");
  assert.equal(calls[0].options.body.get("redirect_uri"), env.MOLLIE_OAUTH_REDIRECT_URI);
  assert.equal(calls[0].options.headers.Authorization,
    `Basic ${Buffer.from("app_demo:fake-secret").toString("base64")}`);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[1].url, "https://api.mollie.com/v2/organizations/me");
  assert.equal(calls[1].options.headers.Authorization, "Bearer fake-access");
});

test("a callback is single-use and requires the initiating shop administrator to confirm", async () => {
  let attempt;
  let exchanges = 0;
  let pending;
  let linked;
  const controller = buildMollieController({
    getConfig: () => config,
    exchange: async () => {
      exchanges += 1;
      return { organizationId: "org_123456", organizationName: "Restaurant pilote",
        credentials: { accessToken: "fake-access", refreshToken: "fake-refresh", expiresAt: 123 } };
    },
    repository: {
      async beginAttempt(data) { attempt = data; },
      async claimAttempt(hash) {
        if (hash !== attempt.stateHash || attempt.claimed) return null;
        attempt.claimed = true;
        return attempt.shopId;
      },
      async stageConnection(data) { pending = data; return true; },
      async confirmConnection({ shopId, staffId, pendingId }) {
        if (shopId !== attempt.shopId || staffId !== attempt.staffId || pendingId !== pending?.stateHash) return "expired";
        linked = pending.organizationId;
        pending = null;
        return "connected";
      },
    },
  });
  const admin = { shopid: 5, id: 9 };
  const start = response();
  await controller.authorize(admin, start);
  const url = new URL(start.body.data.url);
  const state = url.searchParams.get("state");
  assert.equal(url.origin, "https://my.mollie.com");
  assert.equal(url.searchParams.get("redirect_uri"), env.MOLLIE_OAUTH_REDIRECT_URI);
  assert.match(url.searchParams.get("scope"), /terminals\.write/);
  assert.equal(attempt.stateHash, stateHash(state));
  assert.notEqual(attempt.stateHash, state);

  const invalid = response();
  await controller.callback({ query: { state: "A".repeat(43), code: "other" } }, invalid);
  assert.equal(invalid.location.searchParams.get("mollie"), "expired");
  assert.equal(exchanges, 0);

  const callback = response();
  await controller.callback({ query: { state, code: "fake-code" } }, callback);
  assert.equal(callback.location.href, `${env.MOLLIE_CONNECT_RETURN_URL}?mollie=confirm`);
  assert.equal(exchanges, 1);
  assert.equal(linked, undefined);
  assert.equal(pending.shopId, 5);
  assert.doesNotMatch(pending.encryptedTokens, /fake-access|fake-refresh/);
  const [version, iv, tag, ciphertext] = pending.encryptedTokens.split(".");
  assert.equal(version, "v1");
  const decipher = createDecipheriv("aes-256-gcm", config.encryptionKey, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(JSON.stringify(["mollie-oauth-v1", "5", "org_123456"])));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]);
  assert.equal(JSON.parse(decrypted).refreshToken, "fake-refresh");

  const replay = response();
  await controller.callback({ query: { state, code: "fake-code" } }, replay);
  assert.equal(replay.location.searchParams.get("mollie"), "expired");
  assert.equal(exchanges, 1);

  const body = { pendingId: pending.stateHash };
  for (const requester of [{ shopid: 6, id: 9 }, { shopid: 5, id: 10 }]) {
    const rejected = response();
    await controller.confirm({ ...requester, body }, rejected);
    assert.equal(rejected.statusCode, 409);
    assert.equal(linked, undefined);
  }
  const confirmed = response();
  await controller.confirm({ ...admin, body }, confirmed);
  assert.equal(confirmed.statusCode, 200);
  assert.equal(linked, "org_123456");
});
