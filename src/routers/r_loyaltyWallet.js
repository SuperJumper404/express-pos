const crypto = require("crypto");
const express = require("express");
const DomainError = require("../helpers/domainError");

const tokenEqual = (expected, supplied) => typeof expected === "string" && typeof supplied === "string" &&
  Buffer.byteLength(expected) === Buffer.byteLength(supplied) && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
const validIdentifier = value => typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value);
const buildLoyaltyWalletRouter = ({ wallet = require("../services/loyaltyWallet").buildLoyaltyWallet() } = {}) => {
  const router = express.Router();
  const endpoint = work => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { return await work(req, res); }
    catch (error) { return res.status(error instanceof DomainError ? error.status : 503).end(); }
  };
  const passType = req => {
    if (!validIdentifier(req.params.passTypeIdentifier) || req.params.passTypeIdentifier !== wallet.getConfig().applePassTypeId) throw new DomainError(404, "WALLET_PASS_NOT_FOUND", "Pass not found");
  };
  const authorizePass = async req => {
    passType(req);
    if (!validIdentifier(req.params.serialNumber)) throw new DomainError(404, "WALLET_PASS_NOT_FOUND", "Pass not found");
    const header = req.headers.authorization || "";
    if (!header.startsWith("ApplePass ")) throw new DomainError(401, "WALLET_UNAUTHORIZED", "Unauthorized");
    const pass = await wallet.repository().findPass(req.params.serialNumber);
    if (!pass || !tokenEqual(pass.auth_token, header.slice(10))) throw new DomainError(401, "WALLET_UNAUTHORIZED", "Unauthorized");
    return pass;
  };
  const scope = req => {
    if (!validIdentifier(req.params.deviceLibraryIdentifier)) throw new DomainError(400, "WALLET_INVALID_DEVICE", "Invalid device");
    return { serial: req.params.serialNumber, deviceId: req.params.deviceLibraryIdentifier };
  };
  router.post("/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber", endpoint(async (req, res) => {
    await authorizePass(req);
    const pushToken = req.body && req.body.pushToken;
    if (typeof pushToken !== "string" || !/^[a-f0-9]{32,256}$/i.test(pushToken)) return res.status(400).end();
    const created = await wallet.repository().register({ ...scope(req), pushToken });
    return res.status(created ? 201 : 200).end();
  }));
  router.delete("/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber", endpoint(async (req, res) => {
    await authorizePass(req); await wallet.repository().unregister(scope(req)); return res.status(200).end();
  }));
  router.get("/v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier", endpoint(async (req, res) => {
    passType(req); const { deviceId } = scope(req); const since = req.query.passesUpdatedSince;
    if (since !== undefined && (typeof since !== "string" || !/^\d{1,20}$/.test(since))) return res.status(400).end();
    const rows = await wallet.repository().updated({ deviceId, since });
    if (!rows.length) return res.status(204).end();
    const lastUpdated = rows.reduce((largest, row) => BigInt(row.updated_tag) > BigInt(largest) ? row.updated_tag : largest, "0");
    return res.json({ serialNumbers: rows.map(row => row.serial), lastUpdated });
  }));
  router.get("/v1/passes/:passTypeIdentifier/:serialNumber", endpoint(async (req, res) => {
    const pass = await authorizePass(req);
    const bytes = await wallet.getApplePass(pass);
    res.set("Content-Type", "application/vnd.apple.pkpass");
    res.set("Last-Modified", new Date(pass.updated_at || Date.now()).toUTCString());
    return res.send(bytes);
  }));
  // Device diagnostics are deliberately neither persisted nor logged: they may contain pass tokens.
  router.post("/v1/log", endpoint(async (_req, res) => res.status(200).end()));
  return router;
};

module.exports = buildLoyaltyWalletRouter();
module.exports.buildLoyaltyWalletRouter = buildLoyaltyWalletRouter;
module.exports.tokenEqual = tokenEqual;
