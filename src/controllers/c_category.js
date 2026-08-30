const fs = require("fs");
const path = require("path");
const {
  mAddCategory,
  mAllCategory,
  mDetailCategory,
  mUpdateCategory,
  mReorderCategories,
  mDeleteCategory,
} = require("../modules/m_category");
const { envPUBLICIMAGEPATH } = require("../helpers/env");
const { custom, success, failed } = require("../helpers/response");

const categoryImagePath = (filename) => {
  if (typeof filename !== "string" || filename !== path.basename(filename)) return null;
  const directory = path.resolve(envPUBLICIMAGEPATH, "categories");
  const resolved = path.resolve(directory, filename);
  return path.dirname(resolved) === directory ? resolved : null;
};

const removeImageBestEffort = (filename) => {
  const resolved = categoryImagePath(filename);
  if (!resolved) return;
  try {
    if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
  } catch (error) {
    console.error("Category image cleanup failed:", error);
  }
};

module.exports = {
  addCategory: (req, res) => {
    const body = req.body;
    const uploadedFilename = req.file && req.file.filename;
    body.shopid = req.shopid;
    body.created = new Date();
    if (uploadedFilename) body.image = uploadedFilename;
    if (!body.name) {
      if (uploadedFilename) removeImageBestEffort(uploadedFilename);
      custom(res, 400, "RequÃªte invalide.", {}, null);
    } else {
      mAddCategory(body)
        .then(() => {
          custom(res, 201, "CatÃ©gorie crÃ©Ã©e avec succÃ¨s.", {}, null);
        })
        .catch((error) => {
          if (uploadedFilename) removeImageBestEffort(uploadedFilename);
          failed(res, "Erreur serveur.", error.message);
        });
    }
  },
  allCategory: async (req, res) => {
    const filterByShopid = req.shopid;
    mAllCategory(filterByShopid)
      .then((response) => {
        success(res, "CatÃ©gories rÃ©cupÃ©rÃ©es.", null, response);
      })
      .catch((error) => {
        failed(res, "Erreur serveur.", error.message);
      });
  },
  detailCategory: (req, res) => {
    const id = req.params.id;
    mDetailCategory(id)
      .then((response) => {
        if (response.length > 0) {
          success(res, "DÃ©tail de la catÃ©gorie rÃ©cupÃ©rÃ©.", null, response);
        } else {
          custom(res, 404, "CatÃ©gorie introuvable.", null, null);
        }
      })
      .catch((error) => {
        failed(res, "Erreur serveur.", error.message);
      });
  },
  updateCategory: async (req, res) => {
    const body = req.body;
    const uploadedFilename = req.file && req.file.filename;
    let previousImage = null;
    body.updated = new Date();
    if (uploadedFilename) {
      const detail = await mDetailCategory(req.params.id);
      if (detail.length > 0) previousImage = detail[0].image;
      body.image = uploadedFilename;
    }
    const id = req.params.id;
    mUpdateCategory(body, id)
      .then((response) => {
        if (response.affectedRows) {
          if (previousImage && previousImage !== uploadedFilename) {
            removeImageBestEffort(previousImage);
          }
          success(res, "CatÃ©gorie mise Ã  jour avec succÃ¨s.", null, null);
        } else {
          if (uploadedFilename) removeImageBestEffort(uploadedFilename);
          custom(res, 404, "CatÃ©gorie introuvable.", null, null);
        }
      })
      .catch((error) => {
        if (uploadedFilename) removeImageBestEffort(uploadedFilename);
        failed(res, "Erreur serveur.", error.message);
      });
  },
  reorderCategories: async (req, res) => {
    try {
      await mReorderCategories(req.shopid, req.body && req.body.ids);
      success(res, "Ordre des catÃ©gories mis Ã  jour.", null, null);
    } catch (error) {
      custom(res, 422, "Ordre des catÃ©gories invalide.", null, null);
    }
  },
  deleteCategory: async (req, res) => {
    try {
      const id = req.params.id;
      mDeleteCategory(id)
        .then((response) => {
          if (response.affectedRows) {
            success(res, "CatÃ©gorie supprimÃ©e avec succÃ¨s.", null, null);
          } else {
            custom(res, 404, "CatÃ©gorie introuvable.", null, null);
          }
        })
        .catch((error) => {
          failed(res, "Erreur serveur.", error.message);
        });
    } catch (error) {
      failed(res, "Erreur serveur.", error.message);
    }
  },
};
