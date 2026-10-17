const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mysql = require("mysql2/promise");

const migrationDirectory = path.resolve(__dirname, "../../db/migrations");
const deliveryVersion = "20261016120000";

function connectionOptions() {
  if (!process.env.DELIVERY_TEST_DATABASE_URL) {
    throw new Error("DELIVERY_TEST_DATABASE_URL is required; application credentials are never used");
  }
  const url = new URL(process.env.DELIVERY_TEST_DATABASE_URL);
  if (url.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Delivery database tests require an explicit local disposable MySQL server");
  }
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    charset: "utf8mb4",
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: true,
  };
}

async function runMigration(pool, filename, direction) {
  const source = fs.readFileSync(path.join(migrationDirectory, filename), "utf8");
  const sections = source.split(/^-- migrate:(?:up|down)\s*$/m);
  if (sections.length !== 3) throw new Error(`Invalid migration boundaries: ${filename}`);
  if (direction === "up" && filename === "20260729161000_customization_choice_default_price.sql") {
    const [columns] = await pool.query("SHOW COLUMNS FROM customization_step_choices LIKE 'default_extra_price'");
    if (columns.length) {
      // Keep the historical data backfill, omitting only the duplicate first ALTER.
      await pool.query(sections[1].slice(sections[1].indexOf(";") + 1));
      return;
    }
  }
  await pool.query(sections[direction === "up" ? 1 : 2]);
}

async function withDeliveryDatabase(callback, { beforeDeliveryMigrations } = {}) {
  const options = connectionOptions();
  const database = `smarteat_delivery_test_${crypto.randomBytes(12).toString("hex")}`;
  const admin = await mysql.createConnection(options);
  let created = false;
  let pool;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    pool = mysql.createPool({ ...options, database, connectionLimit: 4 });
    const files = fs.readdirSync(migrationDirectory).filter((file) => /^\d+.*\.sql$/.test(file)).sort();
    const deliveryFiles = files.filter((file) => file.slice(0, 14) >= deliveryVersion);
    for (const file of files.filter((entry) => entry.slice(0, 14) < deliveryVersion)) {
      // The initial dump already contains this column. Skip only that known duplicate.
      if (file === "20260518120000_add_kitchen_closed_to_shop.sql") {
        const [columns] = await pool.query("SHOW COLUMNS FROM shop LIKE 'kitchen_closed'");
        if (columns.length) continue;
      }
      await runMigration(pool, file, "up");
    }

    const db = {
      pool,
      database,
      async readRows(sql, values = []) {
        const [rows] = await pool.query(sql, values);
        return rows;
      },
      async migrateDelivery(direction) {
        if (!["up", "down"].includes(direction)) throw new Error("Invalid migration direction");
        const ordered = direction === "up" ? deliveryFiles : [...deliveryFiles].reverse();
        for (const file of ordered) await runMigration(pool, file, direction);
      },
      async seedScenario({ legacy = false } = {}) {
        await pool.query(`INSERT INTO shop
          (id, shop_name, shop_mail, shop_phone, shop_description, shop_payment_methods,
           shop_adress, admin_user, admin_phone, admin_mail, admin_password,
           shop_profile_image, shop_printer_ip)
          VALUES (7, 'Delivery fixture 7', 'seven@example.test', '0700000007', 'Fixture', 'Cash',
            '7 rue Test', 10, '0700000010', 'cashier@example.test', 'not-a-login', '', ''),
          (8, 'Delivery fixture 8', 'eight@example.test', '0800000008', 'Fixture', 'Cash',
            '8 rue Test', 12, '0800000012', 'eight@example.test', 'not-a-login', '', '')`);
        await pool.query(`INSERT INTO users
          (id, shopid, username, email, password, phone, access, status, created, clearpass)
          VALUES (10, 7, 'Cashier', 'cashier@example.test', 'not-a-login', '0700000010', 1, 1, '2026-10-16 12:00:00', ''),
          (11, 7, 'Courier 11', 'courier11@example.test', 'not-a-login', '0700000011', ?, 1, '2026-10-16 12:00:00', ''),
          (12, 8, 'Courier 12', 'courier12@example.test', 'not-a-login', '0800000012', ?, 1, '2026-10-16 12:00:00', '')`,
        [legacy ? 1 : 6, legacy ? 1 : 6]);
        await pool.query(`INSERT INTO category (id, shopid, name, created)
          VALUES (20, 7, 'Fixture', '2026-10-16 12:00:00')`);
        await pool.query(`INSERT INTO products
          (id, shopid, name, categoryid, price, stock, image, created)
          VALUES (21, 7, 'Fixture product', 20, 12.50, 20, '', '2026-10-16 12:00:00')`);
        await pool.query(`INSERT INTO orders
          (id, shopid, ordernumber, customer, customerID, operator, subtotal, created, finished, is_takeaway)
          VALUES (31, 7, 'FIXTURE-31', 'Legacy guest', 10, 10, 12.50, '2026-10-16 12:00:00', '2026-10-16 12:00:00', 0),
          (33, 7, 'FIXTURE-33', 'Takeaway guest', 10, 10, 12.50, '2026-10-16 12:00:00', '2026-10-16 12:00:00', 1)`);
        await pool.query(`INSERT INTO archives
          (id, shopid, ordernumber, customer, customerID, operator, subtotal, created, finished, token, is_takeaway)
          VALUES (32, 7, 'FIXTURE-32', 'Archived guest', 10, 10, 12.50, '2026-10-16 12:00:00', '2026-10-16 12:00:00', 'fixture-archive', 1)`);
        if (!legacy) {
          await pool.query(`INSERT INTO customers (id, shopid, name, contact_phone)
            VALUES ('51', 7, 'Customer 51', '0700000051'), ('52', 8, 'Customer 52', '0800000052')`);
          await pool.query("INSERT IGNORE INTO shop_delivery_settings (shopid) VALUES (7), (8)");
          await pool.query(`INSERT INTO deliveries
            (id, shopid, origin_order_id, order_reference, address_snapshot, contact_snapshot,
             latitude, longitude, distance_meters, settings_revision,
             client_order_token, confirmation_secret_hash, tracking_token_hash, tracking_expires_at)
            VALUES ('41', 7, 31, 'FIXTURE-31', ?, ?, 48.8566, 2.3522, 1800, 1,
              'fixture-checkout', REPEAT('a', 64), REPEAT('b', 64), '2026-11-15 12:00:00')`,
          [JSON.stringify({ line1: "7 rue de l'\u00c9cole", apartment: "B", instructions: "Sonnette \u00c9t\u00e9 \ud83d\ude9a" }),
            JSON.stringify({ name: "\u00c9lodie", phone: "0700000000" })]);
          await pool.query("UPDATE orders SET delivery_id = '41', fulfillment_type = 'delivery' WHERE id = 31");
        }
        return { shopId: 7, otherShopId: 8, cashierId: 10, courierId: 11,
          otherCourierId: 12, productId: 21, orderId: 31, deliveryId: legacy ? null : "41",
          customerId: legacy ? null : "51", otherCustomerId: legacy ? null : "52" };
      },
    };
    if (beforeDeliveryMigrations) await beforeDeliveryMigrations(db);
    await db.migrateDelivery("up");
    return await callback(db);
  } finally {
    try {
      if (pool) await pool.end();
    } finally {
      try {
        if (created && /^smarteat_delivery_test_[a-f0-9]{24}$/.test(database)) {
          await admin.query(`DROP DATABASE \`${database}\``);
        }
      } finally {
        await admin.end();
      }
    }
  }
}

module.exports = { withDeliveryDatabase };
