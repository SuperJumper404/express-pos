const fs = require("fs");
const path = require("path");
const productModule = require("../modules/m_products");
const DomainError = require("../helpers/domainError");
const { envPUBLICIMAGEPATH } = require("../helpers/env");
const { isMissing, parseMoney } = require("../helpers/money");
const { normalizeVatRate } = require("../helpers/vat");
const { success, custom, failed } = require("../helpers/response");

const normalizeProductCustomizations = (customizations) =>
  customizations.map((customization) => ({
    ...customization,
    items: (customization.items || []).map((item) => ({
      ...item,
      price: parseMoney(item.price) || 0,
    })),
  }));

const normalizeProductVisibility = (body) => {
  if (body.is_hidden === undefined) return;
  body.is_hidden = [true, 1, "1", "true"].includes(body.is_hidden) ? 1 : 0;
};

const parseArray = (value, code, message) => {
  if (value === undefined) return undefined;
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      throw new DomainError(422, code, message);
    }
  }
  if (!Array.isArray(parsed)) throw new DomainError(422, code, message);
  return parsed;
};

const buildProductController = ({
  products = productModule,
  fileSystem = fs,
  logger = console,
  publicImagePath = envPUBLICIMAGEPATH,
} = {}) => {
  const productImagePath = (filename) => {
    if (typeof filename !== "string" || filename !== path.basename(filename)) return null;
    const directory = path.resolve(publicImagePath, "products");
    const resolved = path.resolve(directory, filename);
    return path.dirname(resolved) === directory ? resolved : null;
  };

  const removeImageBestEffort = (filename) => {
    const resolved = productImagePath(filename);
    if (!resolved) return;
    try {
      if (fileSystem.existsSync(resolved)) fileSystem.unlinkSync(resolved);
    } catch (error) {
      logger.error("Product image cleanup failed:", error);
    }
  };

  const sendConfigurationError = (res, error) => {
    if (!(error instanceof DomainError)) {
      logger.error("Unexpected product customization error:", error);
      return custom(res, 500, "Erreur serveur.", null, {
        code: "INTERNAL_ERROR",
        product_id: null,
        product_step_id: null,
        choice_id: null,
      });
    }
    return custom(res, error.status || 500, error.message, null, {
      code: error.code || "INTERNAL_ERROR",
      product_id: error.product_id || null,
      product_step_id: error.product_step_id || error.step_id || null,
      choice_id: error.choice_id || null,
    });
  };

  const normalizeWriteBody = (requestBody, { creation = false } = {}) => {
    const body = { ...(requestBody || {}) };
    normalizeProductVisibility(body);
    if (Object.prototype.hasOwnProperty.call(body, "product_customization")) {
      body.product_customization = normalizeProductCustomizations(parseArray(
        body.product_customization,
        "LEGACY_CUSTOMIZATION_INVALID",
        "La personnalisation legacy doit être un tableau.",
      ));
    }
    if (Object.prototype.hasOwnProperty.call(body, "customization_config")) {
      body.customization_config = parseArray(
        body.customization_config,
        "CUSTOMIZATION_CONFIG_INVALID",
        "La configuration produit doit être un tableau.",
      );
    }
    if (!isMissing(body.price)) {
      const parsedPrice = parseMoney(body.price);
      if (parsedPrice === null) {
        throw new DomainError(400, "PRODUCT_PRICE_INVALID", "Requête invalide.");
      }
      body.price = parsedPrice;
    }
    if (creation || Object.prototype.hasOwnProperty.call(body, "vat_rate")) {
      try {
        body.vat_rate = normalizeVatRate(body.vat_rate, 10);
      } catch (error) {
        throw new DomainError(422, "VAT_RATE_INVALID", "Taux de TVA invalide.");
      }
    }
    if (creation) body.is_hidden = body.is_hidden || 0;
    return body;
  };

  const addProduct = async (req, res) => {
    const uploadedFilename = req.file && req.file.filename;
    try {
      const body = normalizeWriteBody(req.body, { creation: true });
      body.image = uploadedFilename;
      body.shopid = req.shopid;
      body.created = new Date();
      if (
        !body.name
        || !body.categoryid
        || isMissing(body.price)
        || !body.stock
        || !uploadedFilename
      ) {
        throw new DomainError(400, "PRODUCT_REQUEST_INVALID", "Requête invalide.");
      }
      await products.mAddProduct(body);
      return custom(res, 201, "Produit créé avec succès.", {}, null);
    } catch (error) {
      if (uploadedFilename) removeImageBestEffort(uploadedFilename);
      if (error instanceof DomainError) return sendConfigurationError(res, error);
      logger.error("Product creation failed:", error);
      return failed(res, "Erreur serveur.", error.message);
    }
  };

  const allProduct = async (req, res) => {
    try {
      const response = await products.mAllProduct(req.shopid);
      return success(res, "Produits récupérés.", null, response);
    } catch (error) {
      return failed(res, "Erreur serveur.", error.message);
    }
  };

  const detailProduct = async (req, res) => {
    try {
      const response = await products.mDetailProduct(req.params.id);
      if (response.length > 0) {
        return success(res, "Détail du produit récupéré.", null, response);
      }
      return custom(res, 404, "Produit introuvable.", null, []);
    } catch (error) {
      return failed(res, "Erreur serveur.", error.message);
    }
  };

  const updateProduct = async (req, res) => {
    const uploadedFilename = req.file && req.file.filename;
    let previousImage = null;
    try {
      const body = normalizeWriteBody(req.body);
      body.updated = new Date();
      if (uploadedFilename) {
        const detail = await products.mDetailProduct(req.params.id);
        if (detail.length === 0) {
          throw new DomainError(404, "PRODUCT_NOT_FOUND", "Produit introuvable.");
        }
        previousImage = detail[0].image;
        body.image = uploadedFilename;
      }
      await products.mUpdateProduct(body, req.params.id);
      if (previousImage && previousImage !== uploadedFilename) {
        removeImageBestEffort(previousImage);
      }
      return success(
        res,
        uploadedFilename
          ? "Image du produit mise à jour avec succès."
          : "Produit mis à jour avec succès.",
        {},
        null,
      );
    } catch (error) {
      if (uploadedFilename) removeImageBestEffort(uploadedFilename);
      if (error instanceof DomainError) return sendConfigurationError(res, error);
      return failed(res, "Erreur serveur.", error.message);
    }
  };

  const updateProductCustomizationConfig = async (req, res) => {
    try {
      const body = req.body || {};
      const rawSteps = Array.isArray(body)
        ? body
        : (body.steps === undefined ? body.customization_config : body.steps);
      const steps = parseArray(
        rawSteps,
        "CUSTOMIZATION_CONFIG_INVALID",
        "La configuration produit doit être un tableau.",
      );
      if (steps === undefined) {
        throw new DomainError(
          422,
          "CUSTOMIZATION_CONFIG_INVALID",
          "La configuration produit doit être un tableau.",
          { product_id: req.params.id },
        );
      }
      await products.mReplaceProductCustomizationConfig({
        shopId: req.shopid,
        productId: req.params.id,
        steps,
      });
      return success(res, "Configuration du produit mise à jour.", null, null);
    } catch (error) {
      return sendConfigurationError(res, error);
    }
  };

  const deleteProduct = async (req, res) => {
    try {
      const id = req.params.id;
      const detail = await products.mDetailProduct(id);
      if (detail.length === 0) return custom(res, 404, "Produit introuvable.", null, null);
      const usage = await products.mUsedProduct(id);
      if (usage[0].cnt > 0) {
        await products.mArchiveProduct(id);
        return success(res, "Produit archivé avec succès.", {}, null);
      }
      const result = await products.mDeleteProduct(id);
      if (!result.affectedRows) {
        return custom(res, 404, "Produit introuvable.", null, null);
      }
      removeImageBestEffort(detail[0].image);
      return success(res, "Produit supprimé avec succès.", {}, null);
    } catch (error) {
      return failed(res, "Erreur serveur.", error.message);
    }
  };

  return {
    addProduct,
    allProduct,
    deleteProduct,
    detailProduct,
    updateProduct,
    updateProductCustomizationConfig,
  };
};

module.exports = {
  ...buildProductController(),
  buildProductController,
};
