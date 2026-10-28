const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const https = require("https");
const http2 = require("http2");
const { execFile } = require("child_process");
const { promisify } = require("util");
const DomainError = require("../helpers/domainError");

const unavailable = (code = "WALLET_UNAVAILABLE") => new DomainError(503, code, "Wallet indisponible. Vérifiez la configuration du service.");
const invalidPushToken = (status, reason) => (status === 410 && reason === "Unregistered") ||
  (status === 400 && ["BadDeviceToken", "DeviceTokenNotForTopic"].includes(reason));
const safeUrl = value => {
  try { const url = new URL(value); if (url.protocol === "https:" && !url.username && !url.password) return url.toString(); } catch (_) { /* invalid */ }
  throw unavailable("WALLET_URL_INVALID");
};
const readConfig = () => ({
  mode: process.env.LOYALTY_WALLET_MODE || "disabled",
  offersBaseUrl: process.env.LOYALTY_OFFERS_BASE_URL,
  applePassTypeId: process.env.APPLE_WALLET_PASS_TYPE_ID,
  appleTeamId: process.env.APPLE_WALLET_TEAM_ID,
  appleCertificatePath: process.env.APPLE_WALLET_CERTIFICATE_PATH,
  appleKeyPath: process.env.APPLE_WALLET_KEY_PATH,
  appleKeyPassphrase: process.env.APPLE_WALLET_KEY_PASSPHRASE,
  appleWwdrPath: process.env.APPLE_WALLET_WWDR_PATH,
  appleAssetsPath: process.env.APPLE_WALLET_ASSETS_PATH,
  appleWebServiceUrl: process.env.APPLE_WALLET_WEB_SERVICE_URL,
  opensslPath: process.env.LOYALTY_OPENSSL_PATH || "openssl",
  googleIssuerId: process.env.GOOGLE_WALLET_ISSUER_ID,
  googleEmail: process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL,
  googlePrivateKeyPath: process.env.GOOGLE_WALLET_PRIVATE_KEY_PATH,
  googleOrigins: (process.env.GOOGLE_WALLET_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean),
});

const buildWalletPayload = ({ program, member, shopId, offersUrl }) => {
  if (!program || !member || !Number.isInteger(shopId) || shopId < 1 || !Number.isSafeInteger(Number(member.balance)) || typeof member.qr !== "string") throw unavailable();
  const balance = Number(member.balance);
  const reserved = Number(member.reserved || 0);
  if (!Number.isSafeInteger(reserved) || reserved < 0 || reserved > balance) throw unavailable();
  const available = balance - reserved;
  const rewards = (program.rewards || []).filter(reward => (!reward.expiresAt || Date.parse(reward.expiresAt) > Date.now()) && Number.isFinite(reward.points)).sort((a, b) => a.points - b.points);
  const usable = rewards.find(reward => reward.points <= available);
  const next = rewards.find(reward => reward.points > available);
  return { name: program.name || "SmartEat", active: program.enabled !== false, shopId, balance, available, qr: member.qr, offersUrl: safeUrl(offersUrl),
    offer: usable ? `${usable.name} — ${usable.points} points (conditions dans SmartEat)` : "Découvrez vos récompenses dans SmartEat",
    next: next ? `${next.name} à ${next.points} points` : "Tous les paliers atteints",
    logoUrl: program.logoUrl ? safeUrl(program.logoUrl) : null,
    backgroundColor: /^#[a-f0-9]{6}$/i.test(program.backgroundColor || "") ? program.backgroundColor : "#173A32",
    foregroundColor: /^#[a-f0-9]{6}$/i.test(program.foregroundColor || "") ? program.foregroundColor : "#FFFFFF" };
};

const signJwt = (claims, privateKey) => {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const message = `${header}.${body}`;
  return `${message}.${crypto.sign("RSA-SHA256", Buffer.from(message), privateKey).toString("base64url")}`;
};

// Uncompressed ZIP avoids a dependency; PKPass integrity is provided by its signed manifest.
const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
};
const createZip = files => {
  const local = []; const central = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const filename = Buffer.from(name); const bytes = Buffer.from(content); const crc = crc32(bytes);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(bytes.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
    local.push(header, filename, bytes); central.push(entry, filename); offset += header.length + filename.length + bytes.length;
  }
  const centralBytes = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
};

const jsonRequest = ({ url, method = "GET", headers = {}, body }) => new Promise((resolve, reject) => {
  const target = new URL(url);
  if (target.protocol !== "https:" || !["oauth2.googleapis.com", "walletobjects.googleapis.com"].includes(target.hostname)) return reject(unavailable());
  const bytes = body === undefined ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const request = https.request({ hostname: target.hostname, path: target.pathname + target.search, method,
    headers: { ...headers, ...(bytes ? { "Content-Length": bytes.length } : {}) } }, response => {
    let raw = "";
    response.setEncoding("utf8");
    response.on("data", chunk => { raw += chunk; if (raw.length > 1048576) request.destroy(unavailable()); });
    response.on("error", () => reject(unavailable()));
    response.on("end", () => { try { resolve({ status: response.statusCode, data: raw ? JSON.parse(raw) : {} }); } catch (_) { reject(unavailable()); } });
  });
  request.setTimeout(8000, () => request.destroy(unavailable())); request.on("error", () => reject(unavailable())); request.end(bytes);
});

const buildSqlWalletRepository = ({ pool = require("../config/dbPool") } = {}) => {
  const withSequence = async work => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      // Keep this global lock until the pass update commits: tags follow commit visibility, not clocks.
      const [[sequence]] = await connection.query("SELECT CAST(revision AS CHAR) AS revision FROM loyalty_wallet_sequence WHERE id=1 FOR UPDATE");
      if (!sequence) throw unavailable();
      const allocate = async () => {
        const next = BigInt(sequence.revision) + 1n;
        if (next > 18446744073709551615n) throw unavailable();
        await connection.query("UPDATE loyalty_wallet_sequence SET revision=? WHERE id=1", [next.toString()]);
        sequence.revision = next.toString(); return sequence.revision;
      };
      const result = await work(connection, allocate);
      await connection.commit(); return result;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  };
  return {
  async ensurePass({ shopId, member, provider }) {
    return withSequence(async (connection, allocate) => {
      const [[existing]] = await connection.query("SELECT * FROM loyalty_wallet_passes WHERE shopid=? AND member_id=? AND provider=?", [shopId, member.id, provider]);
      if (existing) return existing;
      const serial = crypto.randomUUID(); const auth = crypto.randomBytes(32).toString("hex");
      const tag = await allocate();
      await connection.query(`INSERT INTO loyalty_wallet_passes (serial,shopid,member_id,provider,auth_token,updated_tag)
        VALUES (?,?,?,?,?,?)`, [serial, shopId, member.id, provider, auth, tag]);
      const [[row]] = await connection.query("SELECT * FROM loyalty_wallet_passes WHERE shopid=? AND member_id=? AND provider=?", [shopId, member.id, provider]);
      if (!row) throw unavailable(); return row;
    });
  },
  async findPass(serial) {
    const [[row]] = await pool.query("SELECT *,DATE_FORMAT(updated_at,'%Y-%m-%dT%H:%i:%sZ') AS updated_at FROM loyalty_wallet_passes WHERE serial=? AND provider='apple'", [serial]); return row;
  },
  async readMember({ shopid, member_id }) {
    const [[row]] = await pool.query(`SELECT m.*,p.config FROM loyalty_members m JOIN loyalty_programs p ON p.shopid=m.shopid WHERE m.shopid=? AND m.id=?`, [shopid, member_id]);
    if (!row) throw unavailable(); return { shopId: row.shopid, member: row, program: typeof row.config === "string" ? JSON.parse(row.config) : row.config };
  },
  async register({ serial, deviceId, pushToken }) {
    const [[existing]] = await pool.query("SELECT serial FROM loyalty_wallet_registrations WHERE serial=? AND device_id=?", [serial, deviceId]);
    await pool.query(`INSERT INTO loyalty_wallet_registrations (serial,device_id,push_token) VALUES (?,?,?) ON DUPLICATE KEY UPDATE push_token=VALUES(push_token)`, [serial, deviceId, pushToken]);
    return !existing;
  },
  unregister: ({ serial, deviceId }) => pool.query("DELETE FROM loyalty_wallet_registrations WHERE serial=? AND device_id=?", [serial, deviceId]),
  async updated({ deviceId, since }) {
    const [rows] = await pool.query(`SELECT p.serial,CAST(p.updated_tag AS CHAR) AS updated_tag FROM loyalty_wallet_passes p
      JOIN loyalty_wallet_registrations r ON r.serial=p.serial WHERE r.device_id=? AND p.provider='apple' AND p.updated_tag>? ORDER BY p.updated_tag`, [deviceId, since || "0"]);
    return rows;
  },
  async passesForMember({ shopId, memberId }) { const [rows] = await pool.query("SELECT * FROM loyalty_wallet_passes WHERE shopid=? AND member_id=?", [shopId, memberId]); return rows; },
  async markUpdated(serial) {
    return withSequence(async (connection, allocate) => {
      const tag = await allocate();
      await connection.query("UPDATE loyalty_wallet_passes SET updated_tag=?,updated_at=UTC_TIMESTAMP(3) WHERE serial=?", [tag, serial]);
    });
  },
  async registrations(serial) { const [rows] = await pool.query("SELECT * FROM loyalty_wallet_registrations WHERE serial=?", [serial]); return rows; },
  deletePushToken: pushToken => pool.query("DELETE FROM loyalty_wallet_registrations WHERE push_token=?", [pushToken]),
  };
};

const buildLoyaltyWallet = ({ getConfig = readConfig, repository, request = jsonRequest, clock = () => Date.now() } = {}) => {
  const repo = () => repository || (repository = buildSqlWalletRepository());
  let access = null;
  const configured = (config, provider) => {
    if (!["development", "production"].includes(config.mode)) throw unavailable("WALLET_NOT_CONFIGURED");
    const keys = provider === "apple" ? ["applePassTypeId", "appleTeamId", "appleCertificatePath", "appleKeyPath", "appleWwdrPath", "appleAssetsPath", "appleWebServiceUrl"] : ["googleIssuerId", "googleEmail"];
    if (keys.some(key => !config[key]) || (provider === "google" && !config.googlePrivateKey && !config.googlePrivateKeyPath)) throw unavailable("WALLET_NOT_CONFIGURED");
  };
  const googleKey = config => config.googlePrivateKey || fs.readFile(config.googlePrivateKeyPath, "utf8");
  const googleToken = async config => {
    if (access && access.expires > clock() + 60000 && access.email === config.googleEmail) return access.token;
    const now = Math.floor(clock() / 1000);
    const assertion = signJwt({ iss: config.googleEmail, scope: "https://www.googleapis.com/auth/wallet_object.issuer", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }, await googleKey(config));
    const response = await request({ url: "https://oauth2.googleapis.com/token", method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString() });
    if (response.status !== 200 || !response.data.access_token) throw unavailable();
    access = { token: response.data.access_token, email: config.googleEmail, expires: clock() + Math.min(Number(response.data.expires_in) || 3600, 3600) * 1000 }; return access.token;
  };
  const googleData = (config, payload, pass, shopId) => {
    if (!/^\d+$/.test(config.googleIssuerId)) throw unavailable("WALLET_NOT_CONFIGURED");
    const classId = `${config.googleIssuerId}.smarteat_${shopId}`;
    const loyaltyClass = { id: classId, issuerName: payload.name, programName: `${config.mode === "development" ? "[TEST] " : ""}${payload.name}`,
      reviewStatus: "UNDER_REVIEW", hexBackgroundColor: payload.backgroundColor,
      programLogo: { sourceUri: { uri: payload.logoUrl }, contentDescription: { defaultValue: { language: "fr-FR", value: payload.name } } } };
    if (!payload.logoUrl) throw unavailable("WALLET_LOGO_REQUIRED");
    return { loyaltyClass, loyaltyObject: { id: `${config.googleIssuerId}.smarteat_${shopId}_${pass.serial}`, classId, state: payload.active ? "ACTIVE" : "INACTIVE",
      accountId: pass.serial.slice(0, 20), loyaltyPoints: { label: "Points", balance: { string: String(payload.balance) } },
      barcode: { type: "QR_CODE", value: payload.qr, alternateText: "Carte fidélité" },
      textModulesData: [{ id: "offer", header: "Vos récompenses", body: payload.offer }, { id: "next", header: "Prochain palier", body: payload.next }],
      linksModuleData: { uris: [{ id: "offers", uri: payload.offersUrl, description: "Voir mes offres" }] } } };
  };
  const upsertGoogle = async (config, data) => {
    const token = await googleToken(config); const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    for (const [kind, resource] of [["loyaltyClass", data.loyaltyClass], ["loyaltyObject", data.loyaltyObject]]) {
      const url = `https://walletobjects.googleapis.com/walletobjects/v1/${kind}`;
      const found = await request({ url: `${url}/${encodeURIComponent(resource.id)}`, headers });
      if (found.status !== 200 && found.status !== 404) throw unavailable();
      // Never reset an approved class's reviewStatus during an update.
      const patch = { ...resource }; if (found.status === 200 && kind === "loyaltyClass") delete patch.reviewStatus;
      const response = await request({ url: found.status === 404 ? url : `${url}/${encodeURIComponent(resource.id)}`, headers, method: found.status === 404 ? "POST" : "PATCH", body: patch });
      if (![200, 201].includes(response.status)) throw unavailable();
    }
  };
  const offers = (config, shopId) => `${safeUrl(config.offersBaseUrl).replace(/\/$/, "")}/compte/fidelite?shopId=${shopId}`;
  const applePass = async ({ config, payload, pass }) => {
    safeUrl(config.appleWebServiceUrl);
    const rgb = hex => `rgb(${[1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(", ")})`;
    const json = { formatVersion: 1, passTypeIdentifier: config.applePassTypeId, serialNumber: pass.serial, teamIdentifier: config.appleTeamId,
      organizationName: payload.name, description: `Fidélité ${payload.name}`, logoText: `${config.mode === "development" ? "TEST — " : ""}${payload.name}`, voided: !payload.active,
      backgroundColor: rgb(payload.backgroundColor), foregroundColor: rgb(payload.foregroundColor), labelColor: rgb(payload.foregroundColor),
      webServiceURL: config.appleWebServiceUrl.replace(/\/$/, ""), authenticationToken: pass.auth_token,
      barcodes: [{ format: "PKBarcodeFormatQR", message: payload.qr, messageEncoding: "iso-8859-1" }],
      storeCard: { primaryFields: [{ key: "points", label: "POINTS", value: payload.balance, changeMessage: "Votre solde est de %@ points." }],
        secondaryFields: [{ key: "offer", label: "RÉCOMPENSE", value: payload.offer }], auxiliaryFields: [{ key: "next", label: "PROCHAIN PALIER", value: payload.next }],
        backFields: [{ key: "offers", label: "Voir mes offres", value: payload.offersUrl }, { key: "conditions", label: "Conditions", value: "Consultez SmartEat pour les conditions et la confirmation d’utilisation des points." }] } };
    const files = { "pass.json": Buffer.from(JSON.stringify(json)) };
    for (const name of ["icon.png", "icon@2x.png", "icon@3x.png", "logo.png", "logo@2x.png", "logo@3x.png"]) {
      try {
        // Per-shop resources take precedence over global icons. Never fetch arbitrary remote URLs on the signing server.
        try { files[name] = await fs.readFile(path.join(config.appleAssetsPath, String(payload.shopId), name)); }
        catch (error) { if (error.code !== "ENOENT") throw error; files[name] = await fs.readFile(path.join(config.appleAssetsPath, name)); }
      }
      catch (error) { if (name === "icon.png" || name === "icon@2x.png") throw unavailable("WALLET_ASSETS_MISSING"); }
    }
    const manifest = {}; for (const [name, bytes] of Object.entries(files)) manifest[name] = crypto.createHash("sha1").update(bytes).digest("hex");
    files["manifest.json"] = Buffer.from(JSON.stringify(manifest));
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), "smarteat-pass-"));
    try {
      await fs.chmod(folder, 0o700); const input = path.join(folder, "manifest.json"); const output = path.join(folder, "signature");
      await fs.writeFile(input, files["manifest.json"], { mode: 0o600 });
      await promisify(execFile)(config.opensslPath || "openssl", ["smime", "-binary", "-sign", "-certfile", config.appleWwdrPath,
        "-signer", config.appleCertificatePath, "-inkey", config.appleKeyPath, "-in", input, "-out", output, "-outform", "DER",
        ...(config.appleKeyPassphrase ? ["-passin", "env:SMARTEAT_PASS_PHRASE"] : [])],
      { timeout: 10000, windowsHide: true, env: { ...process.env, SMARTEAT_PASS_PHRASE: config.appleKeyPassphrase || "" }, maxBuffer: 65536 });
      files.signature = await fs.readFile(output); return createZip(files);
    } catch (_) { throw unavailable("WALLET_SIGNING_FAILED"); }
    finally { await fs.rm(folder, { recursive: true, force: true }); }
  };
  const issueWallet = async ({ provider, program, member, shopId }) => {
    if (!["apple", "google"].includes(provider)) throw new DomainError(400, "WALLET_PROVIDER_INVALID", "Fournisseur Wallet invalide.");
    const config = getConfig(); configured(config, provider);
    const payload = buildWalletPayload({ program, member, shopId, offersUrl: offers(config, shopId) });
    const pass = await repo().ensurePass({ provider, member, shopId });
    if (provider === "apple") {
      const bytes = await applePass({ config, payload, pass });
      return { provider, mode: config.mode, status: "ready", contentType: "application/vnd.apple.pkpass", fileName: "fidelite.pkpass", passBase64: bytes.toString("base64") };
    }
    const data = googleData(config, payload, pass, shopId); await upsertGoogle(config, data);
    const now = Math.floor(clock() / 1000);
    const jwt = signJwt({ iss: config.googleEmail, aud: "google", typ: "savetowallet", iat: now, exp: now + 3600,
      origins: config.googleOrigins || [], payload: { loyaltyObjects: [{ id: data.loyaltyObject.id }] } }, await googleKey(config));
    return { provider, mode: config.mode, status: "ready", url: `https://pay.google.com/gp/v/save/${jwt}` };
  };
  const getApplePass = async pass => {
    const config = getConfig(); configured(config, "apple"); const input = await repo().readMember(pass);
    return applePass({ config, pass, payload: buildWalletPayload({ ...input, offersUrl: offers(config, input.shopId) }) });
  };
  const notifyApple = async registration => {
    const config = getConfig(); configured(config, "apple");
    // Wallet pass push uses production APNs even for development cards.
    const [cert, key] = await Promise.all([fs.readFile(config.appleCertificatePath), fs.readFile(config.appleKeyPath)]);
    return new Promise((resolve, reject) => {
      const client = http2.connect("https://api.push.apple.com", { cert, key, passphrase: config.appleKeyPassphrase });
      const timer = setTimeout(() => { client.destroy(); reject(unavailable()); }, 8000);
      const done = (error, status) => { clearTimeout(timer); client.close(); if (error) reject(unavailable()); else resolve(status); };
      client.on("error", () => done(true));
      const request = client.request({ ":method": "POST", ":path": `/3/device/${encodeURIComponent(registration.push_token)}`,
        "apns-topic": config.applePassTypeId, "apns-priority": "5", "apns-push-type": "background" });
      let status; let body = ""; request.on("response", headers => { status = headers[":status"]; });
      request.on("data", chunk => { if (body.length < 4096) body += chunk.toString(); }); request.on("error", () => done(true));
      request.on("end", () => {
        let reason; try { reason = JSON.parse(body).reason; } catch (_) { /* no reason */ }
        done(false, { status, reason });
      }); request.end("{}");
    });
  };
  const synchronizeMember = async ({ shopId, memberId }) => {
    const passes = await repo().passesForMember({ shopId, memberId });
    for (const pass of passes) {
      if (pass.provider === "google") { const input = await repo().readMember(pass); const config = getConfig(); configured(config, "google");
        await upsertGoogle(config, googleData(config, buildWalletPayload({ ...input, offersUrl: offers(config, shopId) }), pass, shopId)); }
      else {
        // Publish revision before push so a device can fetch it as soon as notified.
        await repo().markUpdated(pass.serial);
        for (const registration of await repo().registrations(pass.serial)) {
          const response = await notifyApple(registration);
          if (invalidPushToken(response.status, response.reason)) await repo().deletePushToken(registration.push_token);
          else if (response.status !== 200) throw unavailable();
        }
      }
    }
  };
  return { issueWallet, getApplePass, synchronizeMember, repository: repo, getConfig };
};

module.exports = { buildWalletPayload, buildLoyaltyWallet, buildSqlWalletRepository, createZip, signJwt, readConfig, invalidPushToken };
