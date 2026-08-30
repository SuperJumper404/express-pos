const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(
  path.join(__dirname, "../src/modules/m_shop.js"),
  "utf8",
);

assert.match(source, /username: data\.admin_username \|\| "Administrateur"/);
assert.match(source, /position: "Administrateur"/);
assert.match(source, /INSERT INTO `service_points` SET \?/);
assert.match(source, /system_key: "counter"/);
assert.match(source, /system_key: "click_collect"/);
assert.doesNotMatch(source, /access: 3/);

console.log("shop service point initialization contract passed");
