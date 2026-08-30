const conn = require("../config/db");

const SERVICE_POINT_TYPES = Object.freeze({
  COUNTER: "counter",
  CLICK_COLLECT: "click_collect",
  TABLE: "table",
  KIOSK: "kiosk",
});

const createQuery = (connection) => (sql, values) =>
  new Promise((resolve, reject) => {
    connection.query(sql, values, (error, result) => {
      if (error) return reject(error);
      resolve(result);
    });
  });

const normalizeOrderedIds = (ids) => {
  if (!Array.isArray(ids)) throw new Error("Invalid table order");
  const normalized = ids.map((id) => Number(id));
  const unique = new Set(normalized);
  if (
    normalized.length === 0
    || unique.size !== normalized.length
    || normalized.some((id) => !Number.isInteger(id) || id <= 0)
  ) {
    throw new Error("Invalid table order");
  }
  return normalized;
};

const buildServicePointModule = ({ connection = conn } = {}) => {
const query = createQuery(connection);

const listServicePoints = async ({
    shopId,
    activeOnly = true,
    tablesOnly = false,
    kiosksOnly = false,
  }) => {
  const clauses = ["`shopid` = ?"];
  const values = [shopId];

  if (activeOnly) clauses.push("`is_active` = 1");
  if (tablesOnly) clauses.push("`type` = 'table'");
  if (kiosksOnly) clauses.push("`type` = 'kiosk'");

  return query(
    `SELECT \`id\`, \`shopid\`, \`name\`, \`type\`, \`system_key\`, \`is_system\`, \`is_active\`, \`sort_order\`, \`public_access_version\`, \`kiosk_login_id\`, \`kiosk_pin\`, \`created\`, \`updated\`
     FROM \`service_points\`
     WHERE ${clauses.join(" AND ")}
     ORDER BY \`sort_order\` ASC, \`name\` ASC`,
    values,
  );
};

const findServicePoint = ({ servicePointId, shopId }) =>
  query(
    "SELECT `id`, `shopid`, `name`, `type`, `system_key`, `is_system`, `is_active`, `sort_order`, `public_access_version`, `kiosk_login_id`, `kiosk_pin_hash` FROM `service_points` WHERE `id` = ? AND `shopid` = ? LIMIT 1",
    [servicePointId, shopId],
  ).then((rows) => rows[0] || null);

const findSystemPoint = ({ shopId, systemKey }) =>
  query(
    "SELECT `id`, `shopid`, `name`, `type`, `system_key`, `is_system`, `is_active`, `sort_order`, `public_access_version`, `kiosk_login_id`, `kiosk_pin_hash` FROM `service_points` WHERE `shopid` = ? AND `system_key` = ? LIMIT 1",
    [shopId, systemKey],
  ).then((rows) => rows[0] || null);

const createTablePoint = ({ shopId, name }) =>
  query(
    "INSERT INTO `service_points` SET ?",
    [{
      shopid: shopId,
      name,
      type: SERVICE_POINT_TYPES.TABLE,
      is_system: 0,
      is_active: 1,
      sort_order: 1000,
      public_access_version: 1,
      created: new Date(),
    }],
  );

const findKioskByLoginId = ({ kioskLoginId }) =>
  query(
    "SELECT `id`, `shopid`, `name`, `type`, `is_active`, `kiosk_login_id`, `kiosk_pin_hash`, `public_access_version` FROM `service_points` WHERE `kiosk_login_id` = ? AND `type` = 'kiosk' LIMIT 1",
    [kioskLoginId],
  ).then((rows) => rows[0] || null);

const createKioskPoint = ({ shopId, name, kioskLoginId, kioskPin, kioskPinHash }) =>
  query(
    "INSERT INTO `service_points` SET ?",
    [{
      shopid: shopId,
      name,
      type: SERVICE_POINT_TYPES.KIOSK,
      is_system: 0,
      is_active: 1,
      sort_order: 900,
      public_access_version: 1,
      kiosk_login_id: kioskLoginId,
      kiosk_pin: kioskPin,
      kiosk_pin_hash: kioskPinHash,
      created: new Date(),
    }],
  );

const updateTablePoint = ({ servicePointId, shopId, name, isActive }) => {
  const updates = { updated: new Date() };
  if (name !== undefined) updates.name = name;
  if (isActive !== undefined) updates.is_active = isActive;

  return query(
    "UPDATE `service_points` SET ? WHERE `id` = ? AND `shopid` = ? AND `type` = 'table' AND `is_system` = 0",
    [updates, servicePointId, shopId],
  );
};

const deleteTablePoint = ({ servicePointId, shopId }) =>
  query(
    "DELETE FROM `service_points` WHERE `id` = ? AND `shopid` = ? AND `type` = 'table' AND `is_system` = 0",
    [servicePointId, shopId],
  );

const updateKioskPoint = ({ servicePointId, shopId, name, isActive }) => {
  const updates = { updated: new Date() };
  if (name !== undefined) updates.name = name;
  if (isActive !== undefined) updates.is_active = isActive;

  return query(
    "UPDATE `service_points` SET ? WHERE `id` = ? AND `shopid` = ? AND `type` = 'kiosk' AND `is_system` = 0",
    [updates, servicePointId, shopId],
  );
};

const updateKioskCredentials = ({ servicePointId, shopId, kioskLoginId, kioskPin, kioskPinHash }) =>
  query(
    "UPDATE `service_points` SET `kiosk_login_id` = ?, `kiosk_pin` = ?, `kiosk_pin_hash` = ?, `updated` = NOW() WHERE `id` = ? AND `shopid` = ? AND `type` = 'kiosk' AND `is_system` = 0",
    [kioskLoginId, kioskPin, kioskPinHash, servicePointId, shopId],
  );

const reorderTablePoints = async ({ shopId, ids }) => {
  const orderedIds = normalizeOrderedIds(ids);
  const points = await query(
    "SELECT `id` FROM `service_points` WHERE `shopid` = ? AND `type` = 'table' AND `id` IN (?)",
    [shopId, orderedIds],
  );
  if (points.length !== orderedIds.length) throw new Error("Invalid table order");

  for (let index = 0; index < orderedIds.length; index += 1) {
    await query(
      "UPDATE `service_points` SET `sort_order` = ?, `updated` = NOW() WHERE `id` = ? AND `shopid` = ? AND `type` = 'table'",
      [(index + 1) * 10, orderedIds[index], shopId],
    );
  }
  return { affectedRows: orderedIds.length };
};

return {
  SERVICE_POINT_TYPES,
  listServicePoints,
  findServicePoint,
  findSystemPoint,
  findKioskByLoginId,
  createTablePoint,
  createKioskPoint,
  updateTablePoint,
  updateKioskPoint,
  updateKioskCredentials,
  deleteTablePoint,
  reorderTablePoints,
};
};

module.exports = {
  ...buildServicePointModule(),
  buildServicePointModule,
};
