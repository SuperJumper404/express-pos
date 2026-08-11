const conn = require("../config/db");

const SERVICE_POINT_TYPES = Object.freeze({
  COUNTER: "counter",
  CLICK_COLLECT: "click_collect",
  TABLE: "table",
});

const query = (sql, values) =>
  new Promise((resolve, reject) => {
    conn.query(sql, values, (error, result) => {
      if (error) return reject(error);
      resolve(result);
    });
  });

const listServicePoints = async ({ shopId, activeOnly = true, tablesOnly = false }) => {
  const clauses = ["`shopid` = ?"];
  const values = [shopId];

  if (activeOnly) clauses.push("`is_active` = 1");
  if (tablesOnly) clauses.push("`type` = 'table'");

  return query(
    `SELECT \`id\`, \`shopid\`, \`name\`, \`type\`, \`system_key\`, \`is_system\`, \`is_active\`, \`sort_order\`, \`public_access_version\`, \`created\`, \`updated\`
     FROM \`service_points\`
     WHERE ${clauses.join(" AND ")}
     ORDER BY \`sort_order\` ASC, \`name\` ASC`,
    values,
  );
};

const findServicePoint = ({ servicePointId, shopId }) =>
  query(
    "SELECT `id`, `shopid`, `name`, `type`, `system_key`, `is_system`, `is_active`, `sort_order`, `public_access_version` FROM `service_points` WHERE `id` = ? AND `shopid` = ? LIMIT 1",
    [servicePointId, shopId],
  ).then((rows) => rows[0] || null);

const findSystemPoint = ({ shopId, systemKey }) =>
  query(
    "SELECT `id`, `shopid`, `name`, `type`, `system_key`, `is_system`, `is_active`, `sort_order`, `public_access_version` FROM `service_points` WHERE `shopid` = ? AND `system_key` = ? LIMIT 1",
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

module.exports = {
  SERVICE_POINT_TYPES,
  listServicePoints,
  findServicePoint,
  findSystemPoint,
  createTablePoint,
  updateTablePoint,
  deleteTablePoint,
};
