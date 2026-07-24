const fs = require("fs");
const path = require("path");
const catalogModule = require("../modules/m_customizations");
const DomainError = require("../helpers/domainError");
const { envPUBLICIMAGEPATH } = require("../helpers/env");
const { custom } = require("../helpers/response");

const buildCustomizationController = ({
  catalog = catalogModule,
  fileSystem = fs,
  publicImagePath = envPUBLICIMAGEPATH,
} = {}) => {
  const imageDirectory = path.resolve(publicImagePath, "customization-choices");

  const imagePath = (filename) => {
    if (typeof filename !== "string" || filename !== path.basename(filename)) return null;
    const resolved = path.resolve(imageDirectory, filename);
    return path.dirname(resolved) === imageDirectory ? resolved : null;
  };

  const removeImageBestEffort = (filename) => {
    const resolved = imagePath(filename);
    if (!resolved) return;
    try {
      if (fileSystem.existsSync(resolved)) fileSystem.unlinkSync(resolved);
    } catch (error) {
      console.error("Customization choice image cleanup failed:", error.message);
    }
  };

  const sendError = (res, error, uploadedFilename = null) => {
    if (uploadedFilename) removeImageBestEffort(uploadedFilename);
    return custom(res, error.status || 500, error.message, null, {
      code: error.code || "INTERNAL_ERROR",
      product_id: error.product_id || null,
      product_step_id: error.product_step_id || null,
      choice_id: error.choice_id || null,
    });
  };

  const validationError = (code, message, context = {}) => (
    new DomainError(422, code, message, context)
  );

  const missingError = (resource, id) => {
    if (resource === "step") {
      return new DomainError(
        404,
        "CUSTOMIZATION_STEP_NOT_FOUND",
        "Étape de personnalisation introuvable.",
        { step_id: id },
      );
    }
    return new DomainError(
      404,
      "CUSTOMIZATION_CHOICE_NOT_FOUND",
      "Choix de personnalisation introuvable.",
      { choice_id: id },
    );
  };

  const normalizeStepData = (body, partial = false) => {
    const data = { ...body };
    if ((!partial || Object.prototype.hasOwnProperty.call(data, "name"))
      && (typeof data.name !== "string" || data.name.trim() === "")) {
      throw validationError(
        "CUSTOMIZATION_STEP_NAME_REQUIRED",
        "Le nom de l'étape de personnalisation est requis.",
      );
    }
    if (typeof data.name === "string") data.name = data.name.trim();
    return data;
  };

  const normalizeChoiceData = (body, file, partial = false) => {
    const data = { ...body };
    delete data.image;
    const isLinkedProduct = data.choice_type === "linked_product";
    const requiresSimpleName = !isLinkedProduct
      && (!partial
        || Object.prototype.hasOwnProperty.call(data, "name"));
    if (requiresSimpleName
      && (typeof data.name !== "string" || data.name.trim() === "")) {
      throw validationError(
        "CUSTOMIZATION_CHOICE_NAME_REQUIRED",
        "Le nom d'un choix simple est requis.",
      );
    }
    if (typeof data.name === "string") data.name = data.name.trim();
    if (file) data.image = file.filename;
    return data;
  };

  const findOwnedChoice = async (shopId, choiceId) => {
    const steps = await catalog.listCustomizationSteps(shopId);
    for (const step of steps) {
      const choice = (step.choices || []).find(({ id }) => String(id) === String(choiceId));
      if (choice) return choice;
    }
    return null;
  };

  const listCustomizationSteps = async (req, res) => {
    try {
      const steps = await catalog.listCustomizationSteps(req.shopid);
      return custom(res, 200, "Étapes de personnalisation récupérées.", null, steps);
    } catch (error) {
      return sendError(res, error);
    }
  };

  const detailCustomizationStep = async (req, res) => {
    try {
      const step = await catalog.getCustomizationStep({
        shopId: req.shopid,
        stepId: req.params.id,
      });
      if (!step) throw missingError("step", req.params.id);
      return custom(res, 200, "Étape de personnalisation récupérée.", null, step);
    } catch (error) {
      return sendError(res, error);
    }
  };

  const createCustomizationStep = async (req, res) => {
    try {
      const data = normalizeStepData(req.body || {});
      const result = await catalog.createCustomizationStep({
        shopId: req.shopid,
        data,
      });
      return custom(res, 201, "Étape de personnalisation créée.", null, {
        id: result.insertId,
      });
    } catch (error) {
      return sendError(res, error);
    }
  };

  const updateCustomizationStep = async (req, res) => {
    try {
      const data = normalizeStepData(req.body || {}, true);
      const result = await catalog.updateCustomizationStep({
        shopId: req.shopid,
        stepId: req.params.id,
        data,
      });
      if (!result || result.affectedRows === 0) throw missingError("step", req.params.id);
      return custom(res, 200, "Étape de personnalisation mise à jour.", null, null);
    } catch (error) {
      return sendError(res, error);
    }
  };

  const deleteCustomizationStep = async (req, res) => {
    try {
      const result = await catalog.deleteCustomizationStep({
        shopId: req.shopid,
        stepId: req.params.id,
      });
      if (!result || result.affectedRows === 0) throw missingError("step", req.params.id);
      return custom(res, 200, "Étape de personnalisation désactivée.", null, null);
    } catch (error) {
      return sendError(res, error);
    }
  };

  const createCustomizationChoice = async (req, res) => {
    const uploadedFilename = req.file && req.file.filename;
    let persisted = false;
    try {
      const data = normalizeChoiceData(req.body || {}, req.file);
      if (data.choice_type === "linked_product" && req.file) {
        throw validationError(
          "CUSTOMIZATION_LINKED_PRODUCT_IMAGE_NOT_ALLOWED",
          "L'image d'un produit lié est héritée du produit.",
        );
      }
      const result = await catalog.createCustomizationChoice({
        shopId: req.shopid,
        stepId: req.params.id,
        data,
      });
      persisted = true;
      return custom(res, 201, "Choix de personnalisation créé.", null, {
        id: result.insertId,
      });
    } catch (error) {
      return sendError(res, error, persisted ? null : uploadedFilename);
    }
  };

  const updateCustomizationChoice = async (req, res) => {
    const uploadedFilename = req.file && req.file.filename;
    let currentChoice = null;
    let persisted = false;
    try {
      const data = normalizeChoiceData(req.body || {}, req.file, true);
      if (req.file) {
        currentChoice = await findOwnedChoice(req.shopid, req.params.id);
        if (!currentChoice) throw missingError("choice", req.params.id);
        const finalType = data.choice_type || currentChoice.choice_type;
        if (finalType === "linked_product") {
          throw validationError(
            "CUSTOMIZATION_LINKED_PRODUCT_IMAGE_NOT_ALLOWED",
            "L'image d'un produit lié est héritée du produit.",
          );
        }
      }
      const result = await catalog.updateCustomizationChoice({
        shopId: req.shopid,
        choiceId: req.params.id,
        data,
      });
      if (!result || result.affectedRows === 0) throw missingError("choice", req.params.id);
      persisted = true;
      if (currentChoice && currentChoice.image && currentChoice.image !== uploadedFilename) {
        removeImageBestEffort(currentChoice.image);
      }
      return custom(res, 200, "Choix de personnalisation mis à jour.", null, null);
    } catch (error) {
      return sendError(res, error, persisted ? null : uploadedFilename);
    }
  };

  const deleteCustomizationChoice = async (req, res) => {
    try {
      const result = await catalog.deleteCustomizationChoice({
        shopId: req.shopid,
        choiceId: req.params.id,
      });
      if (!result || result.affectedRows === 0) throw missingError("choice", req.params.id);
      return custom(res, 200, "Choix de personnalisation désactivé.", null, null);
    } catch (error) {
      return sendError(res, error);
    }
  };

  return {
    createCustomizationChoice,
    createCustomizationStep,
    deleteCustomizationChoice,
    deleteCustomizationStep,
    detailCustomizationStep,
    listCustomizationSteps,
    updateCustomizationChoice,
    updateCustomizationStep,
  };
};

module.exports = {
  ...buildCustomizationController(),
  buildCustomizationController,
};
