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
const usersModule = fs.readFileSync(
  path.join(root, "src", "modules", "m_users.js"),
  "utf8",
);
const usersController = fs.readFileSync(
  path.join(root, "src", "controllers", "c_users.js"),
  "utf8",
);

assert.match(servicePointModule, /KIOSK:\s*"kiosk"/);
assert.match(servicePointModule, /createKioskPoint/);
assert.match(servicePointModule, /updateKioskPoint/);
assert.match(servicePointModule, /deleteKioskPoint/);
assert.match(servicePointController, /createKiosk/);
assert.match(servicePointController, /updateKiosk/);
assert.match(servicePointController, /deleteKiosk/);
assert.match(servicePointRouter, /\/service-points\/kiosks/);
assert.match(usersModule, /users\.service_point_id/);
assert.match(usersModule, /assigned_point\.id AS service_point_id/);
assert.match(usersModule, /assigned_point\.type AS service_point_type/);
assert.doesNotMatch(usersModule, /counter\.id AS service_point_id/);
assert.match(usersController, /service_point_id/);
assert.match(usersController, /validateStaffServicePoint/);

console.log("kiosk service point contract tests passed");
