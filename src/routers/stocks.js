const stocks = require('../controllers/c_stocks')
const { authentication, authorizeStocks } = require('../helpers/middleware/auth')
const express = require('express')
const routers = express.Router()

routers
  .post('/stocks', authentication, authorizeStocks, stocks.addStock)
  .get('/stocks', authentication, authorizeStocks, stocks.allStock)
  .get('/stocks/:id', authentication, authorizeStocks, stocks.detailStocks)
  .get('/productstocks/:id', authentication, authorizeStocks, stocks.detailProductStocksId)

module.exports = routers
