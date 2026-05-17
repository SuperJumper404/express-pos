const {
  mAddCategory,
  mAllCategory,
  mDetailCategory,
  mUpdateCategory,
  mDeleteCategory,
} = require("../modules/m_category");
const { custom, success, failed } = require("../helpers/response");
module.exports = {
  addCategory: (req, res) => {
    let body = req.body;
    body.shopid = req.shopid;
    body.created = new Date();
    if (!body.name) {
      custom(res, 400, "Requête invalide.", {}, null);
    } else {
      mAddCategory(body)
        .then(() => {
          custom(res, 201, "Catégorie créée avec succès.", {}, null);
        })
        .catch((error) => {
          failed(res, "Erreur serveur.", error.message);
        });
    }
  },
  allCategory: async (req, res) => {
    const filterByShopid = req.shopid;
    mAllCategory(filterByShopid)
      .then((response) => {
        success(res, "Catégories récupérées.", null, response);
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
          success(res, "Détail de la catégorie récupéré.", null, response);
        } else {
          custom(res, 404, "Catégorie introuvable.", null, null);
        }
      })
      .catch((error) => {
        failed(res, "Erreur serveur.", error.message);
      });
  },
  updateCategory: async (req, res) => {
    const body = req.body;
    body.updated = new Date();
    const id = req.params.id;
    mUpdateCategory(body, id)
      .then((response) => {
        if (response.affectedRows) {
          success(res, "Catégorie mise à jour avec succès.", null, null);
        } else {
          custom(res, 404, "Catégorie introuvable.", null, null);
        }
      })
      .catch((error) => {
        failed(res, "Erreur serveur.", error.message);
      });
  },
  deleteCategory: async (req, res) => {
    try {
      const id = req.params.id;
      mDeleteCategory(id)
        .then((response) => {
          if (response.affectedRows) {
            success(res, "Catégorie supprimée avec succès.", null, null);
          } else {
            custom(res, 404, "Catégorie introuvable.", null, null);
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
