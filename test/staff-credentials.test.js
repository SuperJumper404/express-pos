const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const helperPath = path.join(root, 'src', 'helpers', 'staffCredentials.js')
const migrationPath = path.join(
  root,
  'db',
  'migrations',
  '20260811130000_staff_login_credentials.sql'
)

assert.strictEqual(
  fs.existsSync(helperPath),
  true,
  'staff credential helper must exist'
)
assert.strictEqual(
  fs.existsSync(migrationPath),
  true,
  'staff credential migration must exist'
)

const {
  createStaffLoginId,
  normalizeStaffLoginId,
  isValidStaffPin,
} = require(helperPath)

assert.match(
  createStaffLoginId(),
  /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/,
  'staff login IDs must contain six unambiguous uppercase characters'
)
assert.strictEqual(
  normalizeStaffLoginId(' ab-cd2 '),
  'ABCD2',
  'staff login IDs must normalize input before lookup'
)
assert.strictEqual(isValidStaffPin('1234'), true)
assert.strictEqual(isValidStaffPin('123'), false)
assert.strictEqual(isValidStaffPin('12a4'), false)

const migration = fs.readFileSync(migrationPath, 'utf8')
assert.match(migration, /staff_login_id VARCHAR\(6\) NULL/)
assert.match(migration, /staff_pin_hash VARCHAR\(255\) NULL/)
assert.match(migration, /UNIQUE INDEX users_staff_login_id_unique/)

console.log('staff credential tests passed')
