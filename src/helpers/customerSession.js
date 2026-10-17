const crypto = require("crypto");
const DomainError = require("./domainError");
const { authSecretReady } = require("../services/customerCodeTransports");

const SESSION_SECONDS = 30 * 24 * 60 * 60;
const invalid = () => new DomainError(401, "CUSTOMER_SESSION_INVALID", "Customer session required");
const unavailable = () => new DomainError(503, "CUSTOMER_SESSION_UNAVAILABLE", "Customer session unavailable");
const validShop = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const validId = value => typeof value === "string" && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
const validToken = value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, "base64url").toString("base64url") === value;
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const sqlTime = date => date.toISOString().slice(0, 19).replace("T", " ");
const columns = "CAST(id AS CHAR) AS id, shopid AS shopId, CAST(customer_id AS CHAR) AS customerId, token_hash AS tokenHash, csrf_secret_hash AS csrfSecretHash, DATE_FORMAT(expires_at,'%Y-%m-%dT%H:%i:%sZ') AS expiresAt";
const asSession = row => row ? { ...row, subject: "customer" } : null;

const buildSqlCustomerSessionRepository = ({ pool = require("../config/dbPool") } = {}) => {
  const transactionForShop = async ({ shopId }, work) => {
    const connection = await pool.getConnection();
    let broken = false;
    try {
      await connection.beginTransaction();
      // Match Shop-first producers before taking owner/challenge locks or inserting FKs.
      const [[shop]] = await connection.query("SELECT id FROM shop WHERE id=? FOR SHARE", [shopId]);
      if (!shop) throw invalid();
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      try { await connection.rollback(); } catch (_) { broken = true; throw unavailable(); }
      throw error;
    } finally {
      if (broken) connection.destroy();
      else connection.release();
    }
  };
  return {
    transactionForShop,
    async create({ shopId, customerId, verifiedChallengeId, tokenHash, csrfSecretHash, now, expiresAt }) {
      try {
        return await transactionForShop({ shopId }, async connection => {
          const [[owner]] = await connection.query("SELECT id FROM customers WHERE shopid=? AND id=? FOR SHARE", [shopId, customerId]);
          if (!owner) throw invalid();
          const [[challenge]] = await connection.query(`SELECT CAST(id AS CHAR) AS id FROM customer_otp_challenges
            WHERE shopid=? AND id=? AND verified_customer_id=? AND purpose='login' AND customer_id IS NULL
              AND verified_at IS NOT NULL AND consumed_at IS NOT NULL AND send_status='sent'
              AND invalidated_at IS NULL AND expires_at>? FOR UPDATE`, [shopId, verifiedChallengeId, customerId, sqlTime(now)]);
          if (!challenge) throw invalid();
          await connection.query(`INSERT INTO customer_sessions
            (shopid,customer_id,verified_challenge_id,token_hash,csrf_secret_hash,created_at,expires_at) VALUES (?,?,?,?,?,?,?)`,
          [shopId, customerId, verifiedChallengeId, tokenHash, csrfSecretHash, sqlTime(now), sqlTime(expiresAt)]);
          const [[row]] = await connection.query(`SELECT ${columns} FROM customer_sessions WHERE id=LAST_INSERT_ID()`);
          return asSession(row);
        });
      } catch (error) {
        if (error instanceof DomainError) throw error;
        if (error.code === "ER_DUP_ENTRY") throw invalid();
        throw unavailable();
      }
    },
    async read({ tokenHash, shopId, now }) {
      const [[row]] = await pool.query(`SELECT ${columns} FROM customer_sessions
        WHERE token_hash=? AND shopid=? AND revoked_at IS NULL AND expires_at>?`, [tokenHash, shopId, sqlTime(now)]);
      return asSession(row);
    },
    revoke: ({ tokenHash, shopId, now }) => pool.query("UPDATE customer_sessions SET revoked_at=? WHERE token_hash=? AND shopid=? AND revoked_at IS NULL", [sqlTime(now), tokenHash, shopId]),
  };
};

const buildCustomerSession = ({ repository = buildSqlCustomerSessionRepository(), clock = () => new Date(), secret, allowedOrigins } = {}) => {
  const getSecret = () => {
    const config = require("./env").getCustomerAuthConfig();
    const value = secret === undefined ? config.secret : secret;
    if (!authSecretReady({ secret: value, jwtSecret: config.jwtSecret })) throw unavailable();
    return value;
  };
  const currentTime = () => {
    const value = new Date(clock()).getTime();
    if (!Number.isFinite(value)) throw unavailable();
    return new Date(Math.floor(value / 1000) * 1000);
  };
  const csrfToken = session => crypto.createHmac("sha256", getSecret()).update(JSON.stringify([
    "customer-csrf-v1", session.id, session.shopId, session.customerId, session.tokenHash, session.csrfSecretHash,
  ])).digest("hex");
  return {
    async create({ shopId, customerId, verifiedChallengeId }) {
      getSecret();
      if (!validShop(shopId) || !validId(customerId) || !validId(verifiedChallengeId)) throw invalid();
      const rawToken = crypto.randomBytes(32).toString("base64url");
      const now = currentTime();
      const session = await repository.create({ shopId, customerId, verifiedChallengeId, tokenHash: digest(rawToken),
        csrfSecretHash: digest(crypto.randomBytes(32)), now, expiresAt: new Date(now.getTime() + SESSION_SECONDS * 1000) });
      return { rawToken, session, csrfToken: csrfToken(session) };
    },
    async read({ rawToken, shopId }) {
      if (!validToken(rawToken) || !validShop(shopId)) return null;
      getSecret();
      return repository.read({ tokenHash: digest(rawToken), shopId, now: currentTime() });
    },
    async revoke({ rawToken, shopId }) {
      if (!validToken(rawToken) || !validShop(shopId)) return;
      getSecret();
      await repository.revoke({ tokenHash: digest(rawToken), shopId, now: currentTime() });
    },
    csrfToken,
    verifyCsrf({ session, token, origin }) {
      const origins = allowedOrigins === undefined ? require("./env").getCustomerSessionConfig().allowedOrigins : allowedOrigins;
      if (!session || new Date(session.expiresAt).getTime() <= currentTime().getTime() || !origins.includes(origin)
        || typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return false;
      return crypto.timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(csrfToken(session), "hex"));
    },
  };
};

module.exports = { buildCustomerSession, buildSqlCustomerSessionRepository, SESSION_SECONDS };
