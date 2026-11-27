const { custom, success } = require("../helpers/response");
const store = require("../modules/m_mollie");
const {
  readMollieConfig, newState, stateHash, authorizeUrl, exchangeAuthorizationCode, encryptCredentials,
} = require("../services/mollieOAuth");

const validState = (value) => typeof value === "string" && /^[a-z0-9_-]{43}$/i.test(value);
const validPendingId = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const scope = (req) => ({ shopId: req.shopid, staffId: req.id });

function buildMollieController({ repository = store, getConfig = readMollieConfig, exchange = exchangeAuthorizationCode } = {}) {
  const unavailable = (res) => custom(res, 503, "Mollie Connect est indisponible.");
  const returnToSettings = (res, config, status) => {
    const url = new URL(config.returnUrl);
    url.searchParams.set("mollie", status);
    return res.redirect(303, url.href);
  };

  return {
    async status(req, res) {
      if (!getConfig()) return success(res, "Mollie Connect", null, { available: false });
      try {
        const status = await repository.getStatus(scope(req));
        return success(res, "Mollie Connect", null, { available: true, ...status });
      } catch (_) { return unavailable(res); }
    },

    async authorize(req, res) {
      const config = getConfig();
      if (!config) return unavailable(res);
      try {
        const state = newState();
        await repository.beginAttempt({ ...scope(req), stateHash: stateHash(state) });
        return success(res, "Autorisation Mollie", null, { url: authorizeUrl(config, state) });
      } catch (_) { return unavailable(res); }
    },

    async callback(req, res) {
      const config = getConfig();
      if (!config) return unavailable(res);
      const { state, code, error } = req.query;
      if (!validState(state)) return returnToSettings(res, config, "expired");
      try {
        const hash = stateHash(state);
        const shopId = await repository.claimAttempt(hash);
        if (!shopId) return returnToSettings(res, config, "expired");
        if (error === "access_denied") return returnToSettings(res, config, "cancelled");
        if (typeof code !== "string" || !code || code.length > 2048 || error) {
          return returnToSettings(res, config, "failed");
        }
        const { organizationId, organizationName, credentials } = await exchange(config, code);
        const staged = await repository.stageConnection({
          shopId, stateHash: hash, organizationId, organizationName,
          encryptedTokens: encryptCredentials(config, credentials, shopId, organizationId),
        });
        return returnToSettings(res, config, staged ? "confirm" : "expired");
      } catch (_) { return returnToSettings(res, config, "failed"); }
    },

    async confirm(req, res) {
      if (!getConfig()) return unavailable(res);
      const pendingId = req.body?.pendingId;
      if (!validPendingId(pendingId)) return custom(res, 400, "Connexion Mollie invalide.");
      try {
        const result = await repository.confirmConnection({ ...scope(req), pendingId });
        if (result === "expired") return custom(res, 409, "Cette autorisation a expiré. Relancez la connexion Mollie.");
        if (result === "different_organization") return custom(res, 409, "Sélectionnez le compte Mollie déjà associé à cet établissement.");
        return success(res, "Compte Mollie associé.");
      } catch (_) { return unavailable(res); }
    },
  };
}

module.exports = { ...buildMollieController(), buildMollieController };
