const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = (filePath) => fs.readFileSync(path.join(root, filePath), 'utf8')

const migration = read('db/migrations/20260830090000_add_shop_theme_to_shop.sql')
assert.match(migration, /ADD COLUMN `shop_theme` TEXT NULL/)
assert.match(migration, /UPDATE `shop`/)
assert.match(migration, /DROP COLUMN `shop_theme`/)

const controller = read('src/controllers/c_shop.js')
assert.match(controller, /normalizeShopTheme/)
assert.match(controller, /DEFAULT_SHOP_THEME/)
assert.match(controller, /shop_theme:\s*normalizeShopTheme/)
assert.match(controller, /shop_theme:\s*response\?\.\[0\]\?\.shop_theme/)

const moduleSource = read('src/modules/m_shop.js')
assert.match(moduleSource, /shop_theme:\s*JSON\.stringify\(normalizeShopTheme/)
assert.match(moduleSource, /shop_theme = \?/)
assert.match(moduleSource, /JSON\.stringify\(normalizeShopTheme\(data\.shop_theme\)\)/)

console.log('shop theme backend contract tests passed')
