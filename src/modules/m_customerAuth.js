const crypto = require("crypto");
const { isIP } = require("net");
const DomainError = require("../helpers/domainError");
const { normalizeCustomerDestination } = require("../helpers/customerIdentity");
const { authSecretReady } = require("../services/customerCodeTransports");

const invalid = () => new DomainError(400, "CUSTOMER_REQUEST_INVALID", "Invalid customer request");
const invalidCode = () => new DomainError(401, "CUSTOMER_CODE_INVALID", "Invalid or expired code");
const limited = () => new DomainError(429, "CUSTOMER_RATE_LIMITED", "Code limit reached; retry later");
const unavailable = () => new DomainError(503, "CUSTOMER_AUTH_UNAVAILABLE", "Customer authentication unavailable");
const validId = value => typeof value === "string" && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
const validShop = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const validBinding = value => typeof value === "string" && value.length >= 32 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value);
const hash = (secret, ...parts) => crypto.createHmac("sha256", secret).update(JSON.stringify(parts)).digest("hex");
const sameHash = (a, b) => typeof a === "string" && /^[a-f0-9]{64}$/.test(a) && crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
const sqlTime = date => date.toISOString().slice(0, 19).replace("T", " ");
const challengeColumns = "CAST(id AS CHAR) AS id, shopid, CAST(customer_id AS CHAR) AS customer_id, purpose, channel, destination, code_hash, browser_binding_hash, attempts, send_status, sent_at, DATE_FORMAT(expires_at,'%Y-%m-%dT%H:%i:%sZ') AS expires_at, invalidated_at, verified_at, consumed_at, CAST(verified_customer_id AS CHAR) AS verified_customer_id, created_at";

const buildSqlCustomerAuthRepository = ({ pool = require("../config/dbPool") } = {}) => ({
  async transaction(work) {
    const connection = await pool.getConnection();
    let locked = false;
    let transaction = false;
    let broken = false;
    let lockName;
    try {
      const [[database]] = await connection.query("SELECT DATABASE() AS name");
      lockName = `customer_auth_${crypto.createHash("sha256").update(database.name).digest("hex").slice(0, 48)}`;
      const [[lock]] = await connection.query("SELECT GET_LOCK(?, 5) AS acquired", [lockName]);
      if (!lock || Number(lock.acquired) !== 1) throw unavailable();
      locked = true;
      await connection.beginTransaction();
      transaction = true;
      const result = await work(connection);
      await connection.commit();
      transaction = false;
      return result;
    } catch (error) {
      if (transaction) {
        try { await connection.rollback(); } catch (_) { broken = true; }
      }
      if (error instanceof DomainError && !broken) throw error;
      broken = true;
      throw unavailable();
    } finally {
      let cleanupFailed = false;
      if (locked) {
        try {
          const [[released]] = await connection.query("SELECT RELEASE_LOCK(?) AS released", [lockName]);
          cleanupFailed = !released || Number(released.released) !== 1;
        } catch (_) { cleanupFailed = true; }
      }
      if (broken || cleanupFailed) connection.destroy();
      else connection.release();
      if (cleanupFailed) throw unavailable();
    }
  },
  async reserve({ connection, shopId, channel, destination, contactHash, ipHash, browserHash, purpose, customerId, now, expiresAt, makeCodeHash }) {
    // Match Shop-first archive/FK ordering before locking an existing customer.
    const [[shop]] = await connection.query("SELECT id FROM shop WHERE id=? FOR SHARE", [shopId]);
    if (!shop) throw invalid();
    if (purpose === "link") {
      const [[customer]] = await connection.query("SELECT id FROM customers WHERE shopid=? AND id=? FOR UPDATE", [shopId, customerId]);
      if (!customer) throw invalid();
    }
    // All shops' buckets are counted under the same database-wide advisory lock.
    // Explicit UTC strings bypass mysql2's configured/local Date conversion.
    const timestamp = sqlTime(now);
    const [counters] = await connection.query(`SELECT scope,DATE_FORMAT(window_start,'%Y-%m-%dT%H:%i:%sZ') AS window_start,attempts FROM service_rate_limits
      WHERE expires_at > ? AND ((scope='customer_otp_contact' AND subject_hash=?) OR (scope='customer_otp_ip' AND subject_hash=?)) FOR UPDATE`, [timestamp, contactHash, ipHash]);
    const contacts = counters.filter(row => row.scope === "customer_otp_contact");
    if (contacts.reduce((sum, row) => sum + row.attempts, 0) >= 5 || counters.filter(row => row.scope === "customer_otp_ip").reduce((sum, row) => sum + row.attempts, 0) >= 20
      || contacts.some(row => now.getTime() - new Date(row.window_start).getTime() < 60000)) throw limited();
    await connection.query(`UPDATE customer_otp_challenges SET invalidated_at=?
      WHERE shopid=? AND channel=? AND destination=? AND consumed_at IS NULL AND invalidated_at IS NULL`, [timestamp, shopId, channel, destination]);
    await connection.query(`INSERT INTO customer_otp_challenges
      (shopid,customer_id,purpose,channel,destination,code_hash,browser_binding_hash,expires_at,created_at)
      VALUES (?,?,?,?,?,REPEAT('0',64),?,?,?)`, [shopId, customerId, purpose, channel, destination, browserHash, sqlTime(expiresAt), timestamp]);
    const [[inserted]] = await connection.query("SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id");
    await connection.query("UPDATE customer_otp_challenges SET code_hash=? WHERE id=?", [makeCodeHash(inserted.id), inserted.id]);
    for (const [scope, subject] of [["customer_otp_contact", contactHash], ["customer_otp_ip", ipHash]]) {
      await connection.query(`INSERT INTO service_rate_limits (shopid,scope,subject_hash,window_start,expires_at,attempts)
        VALUES (?,?,?,?,?,1) ON DUPLICATE KEY UPDATE attempts=attempts+1`, [shopId, scope, subject, timestamp, sqlTime(new Date(now.getTime() + 3600000))]);
    }
    return inserted.id;
  },
  async getChallenge({ connection, shopId, challengeId }) {
    const [[row]] = await connection.query(`SELECT ${challengeColumns} FROM customer_otp_challenges WHERE shopid=? AND id=? FOR UPDATE`, [shopId, challengeId]);
    return row;
  },
  async recordSend({ connection, shopId, challengeId, status, now }) {
    await connection.query(`UPDATE customer_otp_challenges SET send_status=?, sent_at=?
      WHERE shopid=? AND id=? AND consumed_at IS NULL AND invalidated_at IS NULL AND verified_at IS NULL AND send_status='pending'`,
    [status, status === "sent" ? sqlTime(now) : null, shopId, challengeId]);
    return this.getChallenge({ connection, shopId, challengeId });
  },
  async wrongCode({ connection, challenge, now }) {
    await connection.query("UPDATE customer_otp_challenges SET invalidated_at=IF(attempts+1 >= 5,?,invalidated_at),attempts=attempts+1 WHERE shopid=? AND id=?",
      [sqlTime(now), challenge.shopid, challenge.id]);
  },
  async consume({ connection, challenge, now }) {
    const timestamp = sqlTime(now);
    const [[identity]] = await connection.query("SELECT CAST(customer_id AS CHAR) AS customerId FROM customer_identities WHERE shopid=? AND channel=? AND destination=? FOR UPDATE", [challenge.shopid, challenge.channel, challenge.destination]);
    let customerId = identity && identity.customerId;
    if (challenge.purpose === "link" && customerId && customerId !== challenge.customer_id) {
      await connection.query("UPDATE customer_otp_challenges SET invalidated_at=? WHERE id=?", [timestamp, challenge.id]);
      return { error: new DomainError(409, "CUSTOMER_IDENTITY_CONFLICT", "Contact belongs to another customer") };
    }
    if (!identity) {
      customerId = challenge.customer_id;
      if (challenge.purpose === "login") {
        await connection.query("INSERT INTO customers (shopid,created_at,updated_at) VALUES (?,?,?)", [challenge.shopid, timestamp, timestamp]);
        const [[row]] = await connection.query("SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id");
        customerId = row.id;
      }
      await connection.query("INSERT INTO customer_identities (shopid,customer_id,channel,destination,verified_at,created_at) VALUES (?,?,?,?,?,?)", [challenge.shopid, customerId, challenge.channel, challenge.destination, timestamp, timestamp]);
    }
    await connection.query(`UPDATE customer_otp_challenges SET send_status='sent',verified_at=?,consumed_at=?,verified_customer_id=?
      WHERE shopid=? AND id=?`, [timestamp, timestamp, customerId, challenge.shopid, challenge.id]);
    return { shopId: challenge.shopid, customerId, verifiedChallengeId: challenge.id };
  },
});

const buildCustomerAuth = ({ repository = buildSqlCustomerAuthRepository(),
  transports = require("../services/customerCodeTransports").buildCustomerCodeTransports(), clock = () => new Date(),
  randomCode = () => crypto.randomInt(0, 1000000).toString().padStart(6, "0"), secret } = {}) => {
  const getSecret = () => {
    const config = require("../helpers/env").getCustomerAuthConfig();
    const value = secret === undefined ? config.secret : secret;
    if (!authSecretReady({ secret: value, jwtSecret: config.jwtSecret })) throw unavailable();
    return value;
  };
  const currentTime = () => {
    const now = new Date(clock());
    if (!Number.isFinite(now.getTime())) throw unavailable();
    // SQL DATETIME is whole-second precision; keep cryptographic expiry boundaries identical.
    return new Date(Math.floor(now.getTime() / 1000) * 1000);
  };
  const codeHash = (key, challenge, code) => hash(key, "code", challenge.id, challenge.shopid, challenge.purpose,
    challenge.customer_id, challenge.channel, challenge.destination, challenge.browser_binding_hash, code);
  const verify = async ({ shopId, challengeId, code, browserBinding, purpose, customerId = null }) => {
    const key = getSecret();
    if (!validShop(shopId) || !validId(challengeId) || !validBinding(browserBinding) || typeof code !== "string" || !/^\d{6}$/.test(code)) throw invalidCode();
    const result = await repository.transaction(async connection => {
      const now = currentTime();
      const challenge = await repository.getChallenge({ connection, shopId, challengeId });
      if (!challenge || challenge.purpose !== purpose || (purpose === "link" && challenge.customer_id !== customerId)
        || !sameHash(challenge.browser_binding_hash, hash(key, "browser", browserBinding))
        || challenge.invalidated_at || challenge.consumed_at || challenge.attempts >= 5
        || challenge.send_status === "failed" || new Date(challenge.expires_at).getTime() <= now.getTime()) return { error: invalidCode() };
      if (!sameHash(challenge.code_hash, codeHash(key, challenge, code))) {
        await repository.wrongCode({ connection, challenge, now });
        // Return then throw outside the transaction: failed attempts must commit.
        return { error: invalidCode() };
      }
      return repository.consume({ connection, challenge, now });
    });
    if (result.error) throw result.error;
    return result;
  };
  return {
    async requestChallenge({ shopId, channel, destination, countryCode, ip, browserBinding, purpose = "login", customerId = null, locale }) {
      const key = getSecret();
      if (!validShop(shopId) || !validBinding(browserBinding) || !["login", "link"].includes(purpose)
        || (purpose === "link" ? !validId(customerId) : customerId !== null) || typeof ip !== "string" || !isIP(ip)) throw invalid();
      if (!transports.channels()[channel]) throw new DomainError(503, "CUSTOMER_CHANNEL_UNAVAILABLE", "Customer channel unavailable");
      destination = normalizeCustomerDestination({ channel, value: destination, countryCode });
      if (locale !== undefined && (typeof locale !== "string" || !/^[a-z]{2,3}(?:[-_][A-Za-z]{2})?$/.test(locale))) throw invalid();
      const normalizedIp = isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1).replace(/^::ffff:(\w{1,4}):(\w{1,4})$/, (_all, a, b) => [parseInt(a, 16) >> 8, parseInt(a, 16) & 255, parseInt(b, 16) >> 8, parseInt(b, 16) & 255].join(".")) : ip;
      const code = randomCode();
      if (typeof code !== "string" || !/^\d{6}$/.test(code)) throw unavailable();
      let now;
      let expiresAt;
      const challengeId = await repository.transaction(async connection => {
        now = currentTime();
        expiresAt = new Date(now.getTime() + 600000);
        return repository.reserve({ connection, shopId, channel, destination, purpose, customerId, now, expiresAt,
          contactHash: hash(key, "contact", channel, destination), ipHash: hash(key, "ip", normalizedIp),
          browserHash: hash(key, "browser", browserBinding), makeCodeHash: id => codeHash(key, { id, shopid: shopId, purpose, customer_id: customerId,
            channel, destination, browser_binding_hash: hash(key, "browser", browserBinding) }, code) });
      });
      // The reservation has committed and its SQL/advisory locks have been released.
      let status = "pending";
      try {
        const result = await transports.sendCode({ channel, destination, code, expiresInMinutes: 10, locale });
        status = result.accepted === true ? "sent" : "failed";
      } catch (error) { status = error && error.code === "CUSTOMER_CODE_UNAVAILABLE" ? "failed" : "pending"; }
      const row = await repository.transaction(connection => repository.recordSend({ connection, shopId, challengeId, status, now: currentTime() }));
      return { challengeId, expiresAt: expiresAt.toISOString(), resendAfter: new Date(now.getTime() + 60000).toISOString(), status: row.send_status };
    },
    verifyChallenge: input => verify({ ...input, purpose: "login", customerId: null }),
    linkIdentity({ customerSession, challengeId, code, browserBinding }) {
      if (!customerSession || !validShop(customerSession.shopId) || !validId(customerSession.customerId)) return Promise.reject(invalidCode());
      return verify({ shopId: customerSession.shopId, customerId: customerSession.customerId, challengeId, code,
        browserBinding: browserBinding || customerSession.browserBinding, purpose: "link" });
    },
  };
};

module.exports = { buildCustomerAuth, buildSqlCustomerAuthRepository };
