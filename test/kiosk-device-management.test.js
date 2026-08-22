const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const servicePointModule = fs.readFileSync(
  path.join(root, "src", "modules", "m_servicePoints.js"),
  "utf8",
);
const servicePointController = fs.readFileSync(
  path.join(root, "src", "controllers", "c_servicePoints.js"),
  "utf8",
);
const servicePointRouter = fs.readFileSync(
  path.join(root, "src", "routers", "r_servicePoints.js"),
  "utf8",
);
const usersController = fs.readFileSync(
  path.join(root, "src", "controllers", "c_users.js"),
  "utf8",
);
const migration = fs.readFileSync(
  path.join(root, "db", "migrations", "20260818100000_kiosk_credentials.sql"),
  "utf8",
);

assert.match(migration, /`kiosk_login_id` VARCHAR\(6\) NULL/);
assert.match(migration, /`kiosk_pin` VARCHAR\(4\) NULL/);
assert.match(migration, /`kiosk_pin_hash` VARCHAR\(255\) NULL/);
assert.match(migration, /UNIQUE INDEX `uq_service_points_kiosk_login_id`/);

assert.match(servicePointModule, /kiosk_login_id/);
assert.match(servicePointModule, /kiosk_pin_hash/);
assert.match(servicePointModule, /findKioskByLoginId/);
assert.match(servicePointModule, /updateKioskCredentials/);

assert.match(servicePointController, /createKioskLoginId/);
assert.match(servicePointController, /createKioskPin/);
assert.match(servicePointController, /kiosk_pin/);
assert.match(servicePointController, /regenerateKioskCredentials/);
assert.doesNotMatch(servicePointController, /deleteKiosk:/);

assert.match(servicePointRouter, /patch\("\/service-points\/kiosks\/:id\/credentials"/);
assert.doesNotMatch(servicePointRouter, /delete\("\/service-points\/kiosks\/:id"/);

assert.match(usersController, /loginWithKioskCredentials/);
assert.match(usersController, /session_subject:\s*"service_point"/);
assert.match(usersController, /source:\s*"borne"/);

console.log("kiosk device management tests passed");
