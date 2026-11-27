const { Router } = require("express");
const { authentication, authAdmin } = require("../helpers/middleware/auth");
const mollie = require("../controllers/c_mollie");

const router = Router();
router.use("/mollie", (_req, res, next) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  next();
});
router.get("/mollie/connect/status", authentication, authAdmin, mollie.status);
router.post("/mollie/connect/authorize", authentication, authAdmin, mollie.authorize);
router.get("/mollie/oauth/callback", mollie.callback);
router.post("/mollie/connect/confirm", authentication, authAdmin, mollie.confirm);

module.exports = router;
