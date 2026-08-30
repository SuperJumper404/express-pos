const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const migration = fs.readFileSync(
  path.join(root, 'db', 'migrations', '20260813100000_receipt_shop_settings.sql'),
  'utf8'
)
const controller = fs.readFileSync(
  path.join(root, 'src', 'controllers', 'c_shop.js'),
  'utf8'
)
const moduleSource = fs.readFileSync(
  path.join(root, 'src', 'modules', 'm_shop.js'),
  'utf8'
)
for (const field of [
  'shop_naf',
  'shop_vat_number',
  'receipt_review_qr_url',
  'receipt_review_qr_label',
  'cash_register_number',
]) {
  assert.ok(migration.includes(field), `Migration manquante: ${field}`)
  assert.ok(controller.includes(field), `Contrôleur manquant: ${field}`)
  assert.ok(moduleSource.includes(field), `Module manquant: ${field}`)
}
for (const forbidden of [
  'receipt_display_settings',
  'receipt_footer_message',
  'shop_postal_code',
  'shop_city',
]) {
  assert.ok(!migration.includes(forbidden), `Champ interdit: ${forbidden}`)
}
console.log('receipt shop settings tests passed')
