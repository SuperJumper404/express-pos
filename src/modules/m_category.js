const conn = require("../config/db");

const normalizeOrderedIds = (ids) => {
  if (!Array.isArray(ids)) throw new Error("Invalid category order");
  const normalized = ids.map((id) => Number(id));
  const unique = new Set(normalized);
  if (
    normalized.length === 0
    || unique.size !== normalized.length
    || normalized.some((id) => !Number.isInteger(id) || id <= 0)
  ) {
    throw new Error("Invalid category order");
  }
  return normalized;
};

const query = (connection, sql, values) =>
  new Promise((resolve, reject) => {
    connection.query(sql, values, (err, result) => {
      if (!err) resolve(result);
      else reject(new Error(err));
    });
  });

const buildCategoryModule = ({ connection = conn } = {}) => ({
  mAddCategory: (data) => {
    return query(connection, "INSERT INTO category SET ?", data);
  },
  mAllCategory: (shopid) => {
    let sql = "SELECT * FROM category ORDER BY sort_order ASC, created ASC, id ASC";
    let values = [];
    if (shopid) {
      sql = "SELECT * FROM category WHERE shopid = ? ORDER BY sort_order ASC, created ASC, id ASC";
      values = [shopid];
    }
    return query(connection, sql, values);
  },
  mTotalCategory: () => {
    return query(connection, "SELECT COUNT (*) as total FROM category");
  },
  mDetailCategory: (id) => {
    return query(connection, "SELECT * FROM category WHERE id = ?", [id]);
  },
  mUpdateCategory: (data, id) => {
    return query(connection, "UPDATE category SET ? WHERE id = ?", [data, id]);
  },
  mReorderCategories: async (shopid, ids) => {
    const orderedIds = normalizeOrderedIds(ids);
    const categories = await query(
      connection,
      "SELECT id FROM category WHERE shopid = ? AND id IN (?)",
      [shopid, orderedIds],
    );
    if (categories.length !== orderedIds.length) throw new Error("Invalid category order");

    for (let index = 0; index < orderedIds.length; index += 1) {
      await query(
        connection,
        "UPDATE category SET sort_order = ?, updated = NOW() WHERE id = ? AND shopid = ?",
        [(index + 1) * 10, orderedIds[index], shopid],
      );
    }
    return { affectedRows: orderedIds.length };
  },
  mDeleteCategory: (id) => {
    return query(connection, "DELETE FROM category WHERE id = ?", [id]);
  },
});

module.exports = {
  ...buildCategoryModule(),
  buildCategoryModule,
};
