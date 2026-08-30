const assert = require("assert");
const fs = require("fs");

const router = fs.readFileSync("src/routers/r_category.js", "utf8");
const controller = fs.readFileSync("src/controllers/c_category.js", "utf8");
const index = fs.readFileSync("index.js", "utf8");
const migration = fs.readFileSync(
  "db/migrations/20260816100000_category_images.sql",
  "utf8",
);

assert.ok(migration.includes("ADD COLUMN `image`"), "category image migration exists");
assert.ok(router.includes("singleUploadCategoryImg"), "category upload middleware is used");
assert.ok(controller.includes("uploadedFilename"), "category controller stores uploaded filename");
assert.ok(index.includes("imgcategories"), "category static image route exists");
