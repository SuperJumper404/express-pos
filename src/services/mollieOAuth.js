const { createCipheriv, createHash, randomBytes } = require("node:crypto");
const prefix = require("../config/prefix");

const scopes = [
  "organizations.read", "onboarding.read", "profiles.read",
  "payments.read", "payments.write", "terminals.read", "terminals.write",
].join(" ");

function httpsUrl(value, pathname) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.pathname === pathname && !url.username && !url.password &&
        !url.search && !url.hash) return url.href;
  } catch (_) { /* Missing or invalid environment configuration. */ }
  return null;
}

function readMollieConfig(env = process.env) {
  const clientId = env.MOLLIE_CLIENT_ID || "";
  const clientSecret = env.MOLLIE_CLIENT_SECRET;
  const redirectUri = httpsUrl(env.MOLLIE_OAUTH_REDIRECT_URI, `${prefix}/mollie/oauth/callback`);
  const returnUrl = httpsUrl(env.MOLLIE_CONNECT_RETURN_URL, "/settings");
  const rawKey = env.MOLLIE_TOKEN_ENCRYPTION_KEY || "";
  const encryptionKey = Buffer.from(rawKey, "base64");
  if (!/^app_[a-z0-9_-]+$/i.test(clientId) || !clientSecret || !redirectUri || !returnUrl ||
      encryptionKey.length !== 32 || encryptionKey.toString("base64") !== rawKey) return null;
  return { clientId, clientSecret, redirectUri, returnUrl, encryptionKey };
}

const newState = () => randomBytes(32).toString("base64url");
const stateHash = (state) => createHash("sha256").update(state).digest("hex");

function authorizeUrl(config, state) {
  const url = new URL("https://my.mollie.com/oauth2/authorize");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: scopes,
    state,
  });
  return url.href;
}

async function readJson(request, url, options) {
  const response = await request(url, { ...options, redirect: "error", signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error("Mollie OAuth request failed");
  return response.json();
}

async function exchangeAuthorizationCode(config, code, request = fetch) {
  const tokens = await readJson(request, "https://api.mollie.com/oauth2/tokens", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri }),
  });
  const expiresIn = Number(tokens.expires_in);
  if (typeof tokens.access_token !== "string" || !tokens.access_token ||
      typeof tokens.refresh_token !== "string" || !tokens.refresh_token ||
      !Number.isSafeInteger(expiresIn) || expiresIn <= 0) throw new Error("Invalid Mollie tokens");

  const organization = await readJson(request, "https://api.mollie.com/v2/organizations/me", {
    headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json" },
  });
  if (!/^org_[a-z0-9_-]{1,60}$/i.test(organization.id || "") ||
      typeof organization.name !== "string" || !organization.name.trim() ||
      organization.name.length > 255) throw new Error("Invalid Mollie organization");

  return {
    organizationId: organization.id,
    organizationName: organization.name,
    credentials: { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + expiresIn * 1000 },
  };
}

function encryptCredentials(config, credentials, shopId, organizationId) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.encryptionKey, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(["mollie-oauth-v1", String(shopId), organizationId])));
  const data = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

module.exports = { readMollieConfig, newState, stateHash, authorizeUrl, exchangeAuthorizationCode, encryptCredentials };
