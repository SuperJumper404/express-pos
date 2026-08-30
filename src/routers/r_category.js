const {
  addCategory,
  allCategory,
  detailCategory,
  updateCategory,
  reorderCategories,
  deleteCategory
} = require('../controllers/c_category')
const { authentication, authAdmin } = require('../helpers/middleware/auth')
const singleUploadCategoryImg = require('../helpers/middleware/categories')
const express = require('express')
const routers = express.Router()

routers
  .post('/category', authentication, authAdmin, singleUploadCategoryImg, addCategory)
  .get('/categories', authentication, authAdmin, allCategory)
  .patch('/categories/order', authentication, authAdmin, reorderCategories)
  .get('/category/:id', authentication, authAdmin, detailCategory)
  .patch('/category/:id', authentication, authAdmin, singleUploadCategoryImg, updateCategory)
  .delete('/category/:id', authentication, authAdmin, deleteCategory)

module.exports = routers
