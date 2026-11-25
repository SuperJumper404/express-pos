const express = require("express");
const {
  attachCustomizationStepToProducts,
  createCustomizationChoice,
  createCustomizationStep,
  deleteCustomizationChoice,
  deleteCustomizationChoicePermanently,
  deleteCustomizationStep,
  detailCustomizationStep,
  duplicateCustomizationStep,
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
  .post("/customization-steps/:id/duplicate", authentication, authAdmin, duplicateCustomizationStep)
  .post("/customization-steps/:id/products", authentication, authAdmin, attachCustomizationStepToProducts)
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
  .delete(
    "/customization-choices/:id/permanent",
    authentication,
    authAdmin,
    deleteCustomizationChoicePermanently,
  )
  .delete("/customization-choices/:id", authentication, authAdmin, deleteCustomizationChoice);

module.exports = routers;
