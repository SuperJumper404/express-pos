const {
  mAddProduct,
  mAllProduct,
  mDetailProduct,
  mUpdateProduct,
  mDeleteProduct,
  mUsedProduct,
  mArchiveProduct,
} = require("../modules/m_products");
const path = require("path");
const { envPUBLICIMAGEPATH } = require("../helpers/env");
const { isMissing, parseMoney } = require("../helpers/money");
const { success, custom, failed } = require("../helpers/response");
const fs = require("fs");

const normalizeProductCustomizations = (customizations) =>
  customizations.map((customization) => ({
    ...customization,
    items: (customization.items || []).map((item) => ({
      ...item,
      price: parseMoney(item.price) || 0,
    })),
  }));

const normalizeProductVisibility = (body) => {
  if (body.is_hidden === undefined) {
    return;
  }

  body.is_hidden = [true, 1, "1", "true"].includes(body.is_hidden) ? 1 : 0;
};

module.exports = {
  addProduct: (req, res) => {
    console.log("New Product To Add  ", req.body.product_customization);
    const body = req.body;
    normalizeProductVisibility(body);
    if (body.product_customization) {
      body.product_customization = JSON.parse(body.product_customization);
      body.product_customization = normalizeProductCustomizations(
        body.product_customization,
      );
    }
    const parsedPrice = parseMoney(body.price);
    if (parsedPrice !== null) {
      body.price = parsedPrice;
    }
    body.image = req.file.filename;
    body.shopid = req.shopid;
    body.created = new Date();
    body.is_hidden = body.is_hidden || 0;
    if (
      !body.name ||
      !body.categoryid ||
      isMissing(body.price) ||
      parsedPrice === null ||
      !body.stock
    ) {
      const locationPath = path.join(
        envPUBLICIMAGEPATH,
        "products",
        req.file.filename,
      );
      fs.unlinkSync(locationPath);
      custom(res, 400, "Requête invalide.", {}, null);
    } else {
      mAddProduct(body)
        .then(() => {
          custom(res, 201, "Produit créé avec succès.", {}, null);
        })
        .catch((error) => {
          failed(res, "Erreur serveur.", error.message);
        });
    }
  },
  allProduct: async (req, res) => {
    mAllProduct(req.shopid)
      .then((response) => {
        success(res, "Produits récupérés.", null, response);
      })
      .catch((error) => {
        console.log("erreurezrz");
        failed(res, "Erreur serveur.", error.message);
      });
  },
  detailProduct: (req, res) => {
    const id = req.params.id;
    mDetailProduct(id)
      .then((response) => {
        if (response.length > 0) {
          success(res, "Détail du produit récupéré.", null, response);
        } else {
          custom(res, 404, "Produit introuvable.", null, []);
        }
      })
      .catch((error) => {
        failed(res, "Erreur serveur.", error.message);
      });
  },
  updateProduct: async (req, res) => {
    const body = req.body;
    body.updated = new Date();
    normalizeProductVisibility(body);
    if (!isMissing(body.price)) {
      const parsedPrice = parseMoney(body.price);
      if (parsedPrice === null) {
        return custom(res, 400, "Requête invalide.", {}, null);
      }
      body.price = parsedPrice;
    }
    if (body.product_customization) {
      body.product_customization = normalizeProductCustomizations(
        body.product_customization,
      );
    }
    const id = req.params.id;
    const detail = await mDetailProduct(id);
    if (req.file) {
      body.image = req.file.filename;
      const imagePath = path.join(
        envPUBLICIMAGEPATH,
        "products",
        detail[0].image,
      );
      if (fs.existsSync(imagePath)) {
        try {
          fs.unlinkSync(imagePath);
        } catch (err) {
          console.error(err);
        }
      }
      mUpdateProduct(body, id)
        .then(() => {
          success(res, "Image du produit mise à jour avec succès.", {}, null);
        })
        .catch((error) => {
          failed(res, "Erreur serveur.", error.message);
        });
    } else {
      mUpdateProduct(body, id)
        .then(() => {
          success(res, "Produit mis à jour avec succès.", {}, null);
        })
        .catch((error) => {
          failed(res, "Erreur serveur.", error.message);
        });
    }
  },
  deleteProduct: async (req, res) => {
    try {
      const id = req.params.id;
      const callDetail = await mDetailProduct(id);
      const isUsedProduct = await mUsedProduct(id);
      console.log("isUsedProduct", isUsedProduct);
      if (isUsedProduct[0].cnt > 0) {
        console.log("Product used, archive it", id);
        await mArchiveProduct(id)
          .then(() => {
            success(res, "Produit archivé avec succès.", {}, null);
          })
          .catch((error) => {
            failed(res, "Erreur serveur.", error.message);
          });
      } else {
        console.log("Product not used, delete it", id);
        mDeleteProduct(id)
          .then((response) => {
            if (response.affectedRows) {
              const locationPath = path.join(
                envPUBLICIMAGEPATH,
                "products",
                callDetail[0].image,
              );
              fs.unlinkSync(locationPath);
              success(res, "Produit supprimé avec succès.", {}, null);
            } else {
              custom(res, 404, "Produit introuvable.", null, null);
            }
          })
          .catch((error) => {
            failed(res, "Erreur serveur.", error.message);
          });
      }
    } catch (error) {
      failed(res, "Erreur serveur.", error.message);
    }
  },
};
