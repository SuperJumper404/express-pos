const express = require("express");
const cashRegisterSettlements = require("../controllers/c_cashRegisterSettlements");
const {
  authentication,
  authorizeCashRegister,
} = require("../helpers/middleware/auth");

const router = express.Router();

router
  .post(
    "/cash-register/settlements",
    authentication,
    authorizeCashRegister,
    cashRegisterSettlements.createSettlement,
  )
  .get(
    "/cash-register/settlements/:id",
    authentication,
    authorizeCashRegister,
    cashRegisterSettlements.getSettlement,
  );

module.exports = router;
