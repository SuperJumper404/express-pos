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
    const body = req.body;
    if (!body.name) {
      custom(res, 400, "Bad request!", {}, null);
    } else {
      mAddCategory(body)
        .then(() => {
          custom(res, 201, "Create category success!", {}, null);
        })
        .catch((error) => {
          failed(res, "Internal server error!", error.message);
        });
    }
  },
  allCategory: async (req, res) => {
    mAllCategory()
      .then((response) => {
        success(res, "Get all category!", response);
      })
      .catch((error) => {
        failed(res, "Internal server error!", error.message);
      });
  },
  detailCategory: (req, res) => {
    const id = req.params.id;
    mDetailCategory(id)
      .then((response) => {
        if (response.length > 0) {
          success(res, "Detail category", null, response);
        } else {
          custom(res, 404, "Id category not found!", null, null);
        }
      })
      .catch((error) => {
        failed(res, "Internal server error!", error.message);
      });
  },
  updateCategory: async (req, res) => {
    const body = req.body;
    body.updated = new Date();
    const id = req.params.id;
    mUpdateCategory(body, id)
      .then((response) => {
        if (response.affectedRows) {
          success(res, "Update category success!", null, null);
        } else {
          custom(res, 404, "Id category not found!", null, null);
        }
      })
      .catch((error) => {
        failed(res, "Internal server error!", error.message);
      });
  },
  deleteCategory: async (req, res) => {
    try {
      const id = req.params.id;
      mDeleteCategory(id)
        .then((response) => {
          if (response.affectedRows) {
            success(res, "Delete category success!", null, null);
          } else {
            custom(res, 404, "Id category not found!", null, null);
          }
        })
        .catch((error) => {
          failed(res, "Internal server error!", error.message);
        });
    } catch (error) {
      failed(res, "Internal server error!", error.message);
    }
  },
};
