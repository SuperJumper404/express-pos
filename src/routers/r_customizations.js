const express = require("express");
const {
  createCustomizationChoice,
  createCustomizationStep,
  deleteCustomizationChoice,
  deleteCustomizationStep,
  detailCustomizationStep,
  listCustomizationSteps,
  updateCustomizationChoice,
  updateCustomizationStep,
} = require("../controllers/c_customizations");
const { authentication, authAdmin } = require("../helpers/middleware/auth");
const uploadChoiceImage = require("../helpers/middleware/customizationChoiceImages");

const routers = express.Router();

routers
  .get("/customization-steps", authentication, listCustomizationSteps)
  .post("/customization-steps", authentication, authAdmin, createCustomizationStep)
  .get("/customization-steps/:id", authentication, detailCustomizationStep)
  .patch("/customization-steps/:id", authentication, authAdmin, updateCustomizationStep)
  .delete("/customization-steps/:id", authentication, authAdmin, deleteCustomizationStep)
  .post(
    "/customization-steps/:id/choices",
    authentication,
    authAdmin,
    uploadChoiceImage,
    createCustomizationChoice,
  )
  .patch(
    "/customization-choices/:id",
    authentication,
    authAdmin,
    uploadChoiceImage,
    updateCustomizationChoice,
  )
  .delete("/customization-choices/:id", authentication, authAdmin, deleteCustomizationChoice);

module.exports = routers;
