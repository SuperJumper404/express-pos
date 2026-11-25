const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createImageCopy } = require("../src/helpers/catalogDuplication");
const catalog = require("../src/modules/m_customizations");
const { buildProductModule } = require("../src/modules/m_products");

test("a copied step gets new choice records and independent images", async () => {
  const inserts = [];
  const connection = {
    async query(sql, params) {
      if (sql.includes("SELECT step.id FROM customization_steps")) return [[{ id: 10 }]];
      if (sql.includes("SELECT name, description, active")) {
        return [[{ name: "Sauces", description: "Maison", active: 1 }]];
      }
      if (sql.includes("SELECT choice_type, name, image")) {
        return [[
          { choice_type: "simple", name: "BBQ", image: "bbq.png", linked_product_id: null, default_extra_price: "0.70", default_position: 2, active: 0 },
          { choice_type: "linked_product", name: null, image: null, linked_product_id: 23, default_extra_price: "1.20", default_position: 3, active: 1 },
        ]];
      }
      inserts.push([sql, params]);
      return [{ insertId: 100, affectedRows: 1 }];
    },
  };
  const result = await catalog.duplicateCustomizationStep({
    shopId: 7, stepId: 10, connection, copyImage: (image) => image ? "new-bbq.png" : null,
  });
  assert.equal(result.insertId, 100);
  assert.deepEqual(inserts[0][1], [7, "Sauces (copie)", "Maison", 1]);
  assert.deepEqual(inserts.slice(1).map(([, params]) => params), [
    [100, "simple", "BBQ", "new-bbq.png", null, "0.70", 2, 0],
    [100, "linked_product", null, null, 23, "1.20", 3, 1],
  ]);
  assert(inserts.every(([sql]) => !sql.includes("product_customization")));
});

test("bulk attachment appends only missing step links and keeps existing product configurations", async () => {
  const inserts = [];
  let nextStepId = 400;
  const connection = {
    async query(sql, params) {
      if (sql.includes("SELECT step.id FROM customization_steps")) return [[{ id: 10 }]];
      if (sql.includes("step.id AS step_id")) {
        return [[{ step_id: 10, step_active: 1, choice_id: 30, default_position: 4, default_extra_price: "2.00", choice_active: 1 }]];
      }
      if (sql.includes("SELECT id, archived FROM products")) {
        return [[{ id: 5, archived: 0 }, { id: 6, archived: 0 }, { id: 7, archived: 0 }]];
      }
      if (sql.includes("SELECT product_id, step_id, position")) {
        return [[{ product_id: 5, step_id: 20, position: 8 }, { product_id: 6, step_id: 10, position: 3 }]];
      }
      assert.match(sql, /INSERT INTO/);
      inserts.push(params);
      return [{ insertId: nextStepId++ }];
    },
  };
  const result = await catalog.attachCustomizationStepToProducts({
    shopId: 7, stepId: 10, productIds: [6, 5, 5, 7], connection,
  });
  assert.deepEqual(result, { added: 2 });
  assert.deepEqual(inserts, [
    [5, 10, 9, 1],
    [7, 10, 0, 1],
    [[[400, 30, "2.00", 4, 1], [401, 30, "2.00", 4, 1]]],
  ]);
});

test("discarding a failed duplication only removes the copied image", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-copy-"));
  const resolveImagePath = (name) => path.join(directory, name);
  const source = resolveImagePath("source.png");
  fs.writeFileSync(source, "fixture");
  const images = createImageCopy({
    fileSystem: fs,
    resolveImagePath,
    removeImage: (name) => fs.unlinkSync(resolveImagePath(name)),
  });
  try {
    const filename = images.copy("source.png");
    assert.notEqual(filename, "source.png");
    assert.equal(fs.readFileSync(resolveImagePath(filename), "utf8"), "fixture");
    images.discard();
    assert.equal(fs.existsSync(resolveImagePath(filename)), false);
    assert.equal(fs.readFileSync(source, "utf8"), "fixture");
  } finally {
    for (const filename of fs.readdirSync(directory)) fs.unlinkSync(resolveImagePath(filename));
    fs.rmdirSync(directory);
  }
});

test("bulk removal deletes only the selected products' links and their choices", async () => {
  const deletes = [];
  const connection = {
    async query(sql, params) {
      if (sql.includes("SELECT step.id FROM customization_steps")) {
        assert.deepEqual(params, [10, 7]);
        return [[{ id: 10 }]];
      }
      if (sql.includes("SELECT id, archived FROM products")) {
        assert.deepEqual(params, [7, [5, 6]]);
        return [[{ id: 5, archived: 0 }, { id: 6, archived: 1 }]];
      }
      if (sql.includes("DELETE product_choice")) {
        assert.match(sql, /ON product_step\.id = product_choice\.product_customization_step_id/);
        assert.match(sql, /WHERE product_step\.step_id = \? AND product_step\.product_id IN \(\?\)/);
      } else {
        assert.match(sql, /DELETE FROM product_customization_steps\s+WHERE step_id = \? AND product_id IN \(\?\)/);
      }
      deletes.push(params);
      return [{ affectedRows: deletes.length === 1 ? 4 : 2 }];
    },
  };
  const result = await catalog.removeCustomizationStepFromProducts({
    shopId: 7, stepId: 10, productIds: [5, 6, 5], connection,
  });
  assert.deepEqual(result, { removed: 2 });
  assert.deepEqual(deletes, [[10, [5, 6]], [10, [5, 6]]]);
});

test("bulk removal rejects products outside the shop before deleting any links", async () => {
  const connection = {
    async query(sql) {
      if (sql.includes("SELECT step.id FROM customization_steps")) return [[{ id: 10 }]];
      if (sql.includes("SELECT id, archived FROM products")) return [[{ id: 5 }]];
      throw new Error("No deletes expected");
    },
  };
  await assert.rejects(catalog.removeCustomizationStepFromProducts({
    shopId: 7, stepId: 10, productIds: [5, 6], connection,
  }), { code: "CUSTOMIZATION_PRODUCTS_NOT_OWNED" });
});

test("bulk attachment rejects a dangling linked product before writing any rows", async () => {
  const connection = {
    async query(sql, params) {
      if (sql.includes("SELECT step.id FROM customization_steps")) return [[{ id: 10 }]];
      if (sql.includes("step.id AS step_id")) {
        return [[{ step_id: 10, step_active: 1, choice_id: 30, choice_type: "linked_product", linked_product_id: 99 }]];
      }
      if (sql.includes("SELECT id, archived FROM products")) return [[{ id: 5, archived: 0 }]];
      if (sql.includes("SELECT product_id, step_id, position")) return [[]];
      if (sql.includes("SELECT id FROM products")) {
        assert.deepEqual(params, [7, [99]]);
        return [[]];
      }
      throw new Error("No writes expected");
    },
  };
  await assert.rejects(catalog.attachCustomizationStepToProducts({
    shopId: 7, stepId: 10, productIds: [5], connection,
  }), { code: "CUSTOMIZATION_LINKED_PRODUCT_NOT_OWNED" });
});

test("the product copy has zero stock and copies the raw step configuration to new IDs", async () => {
  const writes = [];
  const connection = {
    async query(sql, params) {
      if (sql.includes("SELECT p.name, p.description")) {
        assert.deepEqual(params, [5, 7]);
        return [[{
          name: "Burger", description: null, categoryid: 3, price: "7.00",
          image: "burger.jpg", track_stock: 1, stock_zero_behavior: "warn",
          vat_rate: "10.00", vat_rate_dine_in: "10.00", vat_rate_takeaway: "5.50",
          stock_unit: "piece", minimum_stock: 2, target_stock: 0,
        }]];
      }
      if (sql.includes("SELECT COALESCE(MAX(sort_order)")) return [[{ next_position: 80 }]];
      if (sql.includes("SELECT products.*")) return [[{ id: 12, shopid: 7, name: "Burger (copie)", stock: 0 }]];
      if (sql.includes("SELECT id, step_id, position")) {
        return [[{ id: 100, step_id: 50, position: 7, minimum_choices: 1, maximum_choices: 2, active: 0 }]];
      }
      writes.push([sql, params]);
      if (sql.includes("INSERT INTO products")) return [{ insertId: 12 }];
      if (sql.includes("INSERT INTO stock_items")) return [{ insertId: 30 }];
      return [{ insertId: 40 }];
    },
  };
  const products = buildProductModule({ withTransaction: (work) => work(connection) });
  const result = await products.mDuplicateProduct({
    shopId: 7, productId: 5, copyImage: (name) => "copy-" + name,
  });
  assert.equal(result.insertId, 12);
  assert.deepEqual(writes[0][1], {
    name: "Burger (copie)", description: null, categoryid: 3, price: "7.00",
    image: "copy-burger.jpg", track_stock: 1, stock_zero_behavior: "warn",
    vat_rate: "10.00", vat_rate_dine_in: "10.00", vat_rate_takeaway: "5.50",
    stock: 0, is_hidden: 1, shopid: 7, sort_order: 80,
  });
  assert.equal(writes[1][1].current_stock, 0);
  assert.equal(writes[1][1].target_stock, 2);
  assert.deepEqual(writes.at(-2)[1], [12, 50, 7, 1, 2, 0]);
  assert.deepEqual(writes.at(-1)[1], [40, 100]);
});
