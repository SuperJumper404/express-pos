const adjustProductStock = async ({
  query,
  shopId,
  productId,
  delta,
  allowShortage = false,
}) => {
  const shopClause = shopId == null ? "" : " AND shopid = ?";
  const shortageClause = delta < 0 && !allowShortage ? " AND stock >= ?" : "";
  const params = [delta, productId];
  if (shopId != null) params.push(shopId);
  if (shortageClause) params.push(-delta);
  const result = await query(
    `UPDATE products
     SET stock = stock + ?
     WHERE id = ?${shopClause}${shortageClause}`,
    params,
  );
  if (!result.affectedRows) return result;

  const syncParams = [productId];
  const syncShopClause = shopId == null ? "" : " AND p.shopid = ?";
  if (shopId != null) syncParams.push(shopId);
  await query(
    `UPDATE stock_items si
     JOIN products p ON p.stock_item_id = si.id
     SET si.current_stock = p.stock
     WHERE p.id = ?${syncShopClause}`,
    syncParams,
  );
  return result;
};

module.exports = { adjustProductStock };
