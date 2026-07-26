const crypto = require("crypto");
const pool = require("../config/dbPool");
const DomainError = require("../helpers/domainError");
const { parseMoney } = require("../helpers/money");
const { withTransaction } = require("../helpers/withTransaction");
const { envSTRIPESTOCKRESERVATIONMINUTES } = require("../helpers/env");
const { quoteOrderItems } = require("./m_orderQuote");

const EDITABLE_PAYMENT_STATUSES = new Set(["unpaid", "requires_payment"]);
const isOrderEditable = (order = {}) =>
  Number(order.status) === 1
  && EDITABLE_PAYMENT_STATUSES.has(String(order.payment_status));

const queryResult = async (connection, sql, params = []) => {
  const [result] = await (connection || pool).query(sql, params);
  return result;
};

const sqlRepository = {
  findOrder: ({ orderId, shopId, connection }) => queryResult(
    connection,
    "SELECT * FROM orders WHERE id = ? AND shopid = ? LIMIT 1",
    [orderId, shopId],
  ).then((rows) => rows[0] || null),

  findOrderDetails: ({ orderId, shopId, connection }) => queryResult(
    connection,
    `SELECT orderdetail.id, orderdetail.orderid, orderdetail.productid,
            orderdetail.qty, orderdetail.price, orderdetail.total
     FROM orderdetail
     JOIN orders ON orders.id = orderdetail.orderid
     WHERE orderdetail.orderid = ? AND orders.shopid = ?
     ORDER BY orderdetail.id`,
    [orderId, shopId],
  ),

  findSnapshots: ({ detailIds, shopId, connection }) => (
    detailIds.length === 0 ? Promise.resolve([]) : queryResult(
      connection,
      `SELECT snapshots.*
       FROM orderdetail_customization_snapshots snapshots
       JOIN orderdetail ON orderdetail.id = snapshots.orderdetail_id
       JOIN orders ON orders.id = orderdetail.orderid
       WHERE snapshots.orderdetail_id IN (?) AND orders.shopid = ?
       ORDER BY snapshots.orderdetail_id, snapshots.step_position,
                snapshots.choice_position, snapshots.id`,
      [detailIds, shopId],
    )
  ),

  findLegacyCustomizations: ({ detailIds, shopId, connection }) => (
    detailIds.length === 0 ? Promise.resolve([]) : queryResult(
      connection,
      `SELECT orders_customization.order_details_id,
              orders_customization.product_choice_id,
              product_choice.name,
              product_choice.price
       FROM orders_customization
       JOIN orderdetail ON orderdetail.id = orders_customization.order_details_id
       JOIN orders ON orders.id = orderdetail.orderid
       LEFT JOIN product_choice
         ON product_choice.id = orders_customization.product_choice_id
       WHERE orders_customization.order_details_id IN (?) AND orders.shopid = ?
       ORDER BY orders_customization.order_details_id, orders_customization.id`,
      [detailIds, shopId],
    )
  ),

  lockOrder: ({ orderId, shopId, connection }) => queryResult(
    connection,
    `SELECT * FROM orders
     WHERE id = ? AND shopid = ?
     LIMIT 1 FOR UPDATE`,
    [orderId, shopId],
  ).then((rows) => rows[0] || null),

  lockDetails: ({ orderId, shopId, connection }) => queryResult(
    connection,
    `SELECT orderdetail.*
     FROM orderdetail
     JOIN orders ON orders.id = orderdetail.orderid
     WHERE orderdetail.orderid = ? AND orders.shopid = ?
     ORDER BY orderdetail.id
     FOR UPDATE`,
    [orderId, shopId],
  ),

  lockSnapshots: ({ detailIds, shopId, connection }) => (
    detailIds.length === 0 ? Promise.resolve([]) : queryResult(
      connection,
      `SELECT snapshots.*
       FROM orderdetail_customization_snapshots snapshots
       JOIN orderdetail ON orderdetail.id = snapshots.orderdetail_id
       JOIN orders ON orders.id = orderdetail.orderid
       WHERE snapshots.orderdetail_id IN (?) AND orders.shopid = ?
       ORDER BY snapshots.orderdetail_id, snapshots.step_position,
                snapshots.choice_position, snapshots.id
       FOR UPDATE`,
      [detailIds, shopId],
    )
  ),

  lockLegacyCustomizations: ({ detailIds, shopId, connection }) => (
    detailIds.length === 0 ? Promise.resolve([]) : queryResult(
      connection,
      `SELECT orders_customization.order_details_id,
              orders_customization.product_choice_id,
              product_choice.name,
              product_choice.price
       FROM orders_customization
       JOIN orderdetail ON orderdetail.id = orders_customization.order_details_id
       JOIN orders ON orders.id = orderdetail.orderid
       LEFT JOIN product_choice
         ON product_choice.id = orders_customization.product_choice_id
       WHERE orders_customization.order_details_id IN (?) AND orders.shopid = ?
       ORDER BY orders_customization.order_details_id, orders_customization.id
       FOR UPDATE`,
      [detailIds, shopId],
    )
  ),

  lockReservations: ({ orderId, shopId, connection }) => queryResult(
    connection,
    `SELECT reservations.*
     FROM order_stock_reservations reservations
     JOIN orders ON orders.id = reservations.order_id
     WHERE reservations.order_id = ? AND orders.shopid = ?
     ORDER BY reservations.product_id, reservations.id
     FOR UPDATE`,
    [orderId, shopId],
  ),

  lockProducts: ({ shopId, productIds, connection }) => (
    productIds.length === 0 ? Promise.resolve([]) : queryResult(
      connection,
      `SELECT id, shopid, stock
       FROM products
       WHERE shopid = ? AND id IN (?)
       ORDER BY id
       FOR UPDATE`,
      [shopId, productIds],
    )
  ),

  adjustStock: ({ shopId, productId, delta, connection }) => {
    const shortageClause = delta < 0 ? " AND stock >= ?" : "";
    const params = [delta, productId, shopId];
    if (delta < 0) params.push(-delta);
    return queryResult(
      connection,
      `UPDATE products
       SET stock = stock + ?
       WHERE id = ? AND shopid = ?${shortageClause}`,
      params,
    );
  },

  deleteSnapshots: ({ detailIds, connection }) => (
    detailIds.length === 0 ? Promise.resolve({ affectedRows: 0 }) : queryResult(
      connection,
      "DELETE FROM orderdetail_customization_snapshots WHERE orderdetail_id IN (?)",
      [detailIds],
    )
  ),

  deleteLegacyCustomizations: ({ orderId, shopId, connection }) => queryResult(
    connection,
    `DELETE orders_customization
     FROM orders_customization
     JOIN orders ON orders.id = orders_customization.order_id
     WHERE orders_customization.order_id = ? AND orders.shopid = ?`,
    [orderId, shopId],
  ),

  deleteDetails: ({ orderId, shopId, connection }) => queryResult(
    connection,
    `DELETE orderdetail
     FROM orderdetail
     JOIN orders ON orders.id = orderdetail.orderid
     WHERE orderdetail.orderid = ? AND orders.shopid = ?`,
    [orderId, shopId],
  ),

  insertDetail: ({ detail, connection }) => queryResult(
    connection,
    "INSERT INTO orderdetail SET ?",
    [detail],
  ),

  insertSnapshot: ({ snapshot, connection }) => queryResult(
    connection,
    "INSERT INTO orderdetail_customization_snapshots SET ?",
    [snapshot],
  ),

  updateOrder: ({ orderId, shopId, changes, connection }) => queryResult(
    connection,
    "UPDATE orders SET ? WHERE id = ? AND shopid = ?",
    [changes, orderId, shopId],
  ),

  upsertReservation: ({ reservation, connection }) => queryResult(
    connection,
    `INSERT INTO order_stock_reservations SET ?
     ON DUPLICATE KEY UPDATE
       quantity = VALUES(quantity),
       status = VALUES(status),
       expires_at = VALUES(expires_at),
       updated = VALUES(updated)`,
    [reservation],
  ),

  insertMovement: ({ movement, connection }) => queryResult(
    connection,
    "INSERT INTO stocks SET ?",
    [movement],
  ),
};

const groupBy = (rows, key) => rows.reduce((groups, row) => {
  const value = row[key];
  if (!groups.has(value)) groups.set(value, []);
  groups.get(value).push(row);
  return groups;
}, new Map());

const valueForRevision = (value) => (value == null ? null : String(value));
const sortedChoiceIds = (item) => (item.selections || [])
  .map((selection) => selection.product_customization_step_choice_id)
  .map(valueForRevision)
  .sort((left, right) => String(left).localeCompare(String(right)));

const buildContentRevision = (order = {}, items = []) => {
  const canonicalContent = {
    order_id: valueForRevision(order.id),
    is_takeaway: [true, 1, "1"].includes(order.is_takeaway),
    items: [...items]
      .sort((left, right) => Number(left.orderdetail_id || left.id)
        - Number(right.orderdetail_id || right.id))
      .map((item) => ({
        orderdetail_id: valueForRevision(item.orderdetail_id || item.id),
        product_id: valueForRevision(item.product_id || item.productid),
        quantity: valueForRevision(item.quantity == null ? item.qty : item.quantity),
        product_customization_step_choice_ids: sortedChoiceIds(item),
      })),
  };
  return crypto.createHash("sha256")
    .update(JSON.stringify(canonicalContent))
    .digest("hex");
};

const snapshotSelection = (snapshot) => ({
  product_customization_step_id: snapshot.product_customization_step_id,
  product_customization_step_choice_id: snapshot.product_customization_step_choice_id,
  step_name: snapshot.step_name,
  step_position: snapshot.step_position,
  choice_type: snapshot.choice_type,
  choice_name: snapshot.choice_name,
  choice_position: snapshot.choice_position,
  unit_extra_price: parseMoney(snapshot.unit_extra_price),
  linked_product_id: snapshot.linked_product_id,
});

const legacySelection = (selection) => ({
  product_customization_step_id: null,
  product_customization_step_choice_id: null,
  product_choice_id: selection.product_choice_id,
  name: selection.name,
  price: parseMoney(selection.price),
});

const formatDate = (value) => value.toISOString().slice(0, 19).replace("T", " ");
const cents = (value) => Math.round(Number(value) * 100);
const isPositiveId = (value) => {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0;
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return false;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0;
};
const invalidEditRequest = (field) => new DomainError(
  400,
  "ORDER_EDIT_REQUEST_INVALID",
  "Requete de modification invalide.",
  { field },
);

const normalizeOptionalBoolean = (value, field) => {
  if (value === undefined) return undefined;
  if ([true, 1, "1"].includes(value)) return true;
  if ([false, 0, "0"].includes(value)) return false;
  throw invalidEditRequest(field);
};

const normalizeEditItems = (items) => {
  if (!Array.isArray(items)) throw invalidEditRequest("items");
  return items.map((item, index) => {
    if (!item || !isPositiveId(item.productId)) {
      throw invalidEditRequest(`items.${index}.product_id`);
    }
    if (!isPositiveId(item.quantity)) throw invalidEditRequest(`items.${index}.quantity`);
    const choiceIds = item.selectedChoiceIds == null ? [] : item.selectedChoiceIds;
    if (!Array.isArray(choiceIds)
      || choiceIds.some((choiceId) => !isPositiveId(choiceId))) {
      throw invalidEditRequest(`items.${index}.selected_product_step_choice_ids`);
    }
    const normalizedChoiceIds = choiceIds.map(Number);
    if (new Set(normalizedChoiceIds).size !== normalizedChoiceIds.length) {
      throw invalidEditRequest(`items.${index}.selected_product_step_choice_ids`);
    }
    return {
      productId: Number(item.productId),
      quantity: Number(item.quantity),
      selectedChoiceIds: normalizedChoiceIds,
    };
  });
};

const validateAmendInput = (input = {}) => {
  if (!isPositiveId(input.orderId)) throw invalidEditRequest("order_id");
  if (!isPositiveId(input.shopId)) throw invalidEditRequest("shop_id");
  if (!isPositiveId(input.operatorId)) throw invalidEditRequest("operator_id");
  if (typeof input.contentRevision !== "string" || !input.contentRevision.trim()) {
    throw invalidEditRequest("content_revision");
  }
  const expectedTotal = parseMoney(input.expectedTotal);
  if (expectedTotal == null || expectedTotal < 0) throw invalidEditRequest("expected_total");
  return {
    orderId: Number(input.orderId),
    shopId: Number(input.shopId),
    operatorId: Number(input.operatorId),
    contentRevision: input.contentRevision.trim(),
    expectedTotal,
    isTakeaway: normalizeOptionalBoolean(input.isTakeaway, "is_takeaway"),
    items: normalizeEditItems(input.items),
  };
};

const storedRequirements = (details, snapshots) => {
  const requirements = new Map();
  const add = (productId, quantity) => {
    const id = Number(productId);
    requirements.set(id, (requirements.get(id) || 0) + Number(quantity));
  };
  for (const detail of details) {
    add(detail.productid, detail.qty);
    for (const snapshot of snapshots) {
      if (Number(snapshot.orderdetail_id) !== Number(detail.id)) continue;
      if (snapshot.choice_type === "linked_product" && snapshot.linked_product_id != null) {
        add(snapshot.linked_product_id, detail.qty);
      }
    }
  }
  return requirements;
};

const activeReservationRequirements = (reservations) => {
  const requirements = new Map();
  for (const reservation of reservations) {
    if (reservation.status === "released") continue;
    const productId = Number(reservation.product_id);
    const quantity = Number(reservation.quantity);
    requirements.set(productId, (requirements.get(productId) || 0) + quantity);
  }
  return requirements;
};

const requirementDeltas = (before, after) => new Map(
  [...new Set([...before.keys(), ...after.keys()])]
    .sort((left, right) => left - right)
    .map((productId) => [
      productId,
      (after.get(productId) || 0) - (before.get(productId) || 0),
    ]),
);

const revisionItems = (details, snapshots, legacyCustomizations = []) => {
  const snapshotDetailIds = new Set(
    snapshots.map((snapshot) => Number(snapshot.orderdetail_id)),
  );
  return details.map((detail) => ({
    ...detail,
    selections: snapshotDetailIds.has(Number(detail.id))
      ? snapshots
        .filter((snapshot) => Number(snapshot.orderdetail_id) === Number(detail.id))
        .map((snapshot) => ({
          product_customization_step_choice_id:
            snapshot.product_customization_step_choice_id,
        }))
      : legacyCustomizations
        .filter((selection) => Number(selection.order_details_id) === Number(detail.id))
        .map(() => ({ product_customization_step_choice_id: null })),
  }));
};

const RECONFIGURATION_ERROR_CODES = new Set([
  "CUSTOMIZATION_CHOICE_NOT_ALLOWED",
  "CUSTOMIZATION_STEP_UNAVAILABLE",
  "CUSTOMIZATION_MIN_NOT_MET",
  "CUSTOMIZATION_MAX_EXCEEDED",
]);

const reconfigurationError = (error) => new DomainError(
  422,
  "ORDER_RECONFIGURATION_REQUIRED",
  "La personnalisation de la commande doit etre reconfiguree.",
  Object.keys(error).reduce((context, key) => {
    if (!["status", "code"].includes(key)) context[key] = error[key];
    return context;
  }, {}),
);

const buildOrderEditingModule = ({
  repository = sqlRepository,
  withTransaction: runInTransaction = withTransaction,
  quoteOrderItems: quoteItems = quoteOrderItems,
  now = () => new Date(),
  reservationTtlMinutes = envSTRIPESTOCKRESERVATIONMINUTES,
} = {}) => {
  const getEditableOrder = async ({ orderId, shopId, connection }) => {
    const order = await repository.findOrder({ orderId, shopId, connection });
    if (!order) return null;
    if (!isOrderEditable(order)) {
      throw new DomainError(
        422,
        "ORDER_NOT_EDITABLE",
        "Cette commande ne peut pas etre modifiee.",
      );
    }

    const details = await repository.findOrderDetails({ orderId, shopId, connection });
    const detailIds = details.map((detail) => detail.id);
    const snapshots = await repository.findSnapshots({ detailIds, shopId, connection });
    const snapshotsByDetail = groupBy(snapshots, "orderdetail_id");
    const legacyDetailIds = detailIds.filter((detailId) => !snapshotsByDetail.has(detailId));
    const legacyCustomizations = await repository.findLegacyCustomizations({
      detailIds: legacyDetailIds,
      shopId,
      connection,
    });
    const legacyByDetail = groupBy(legacyCustomizations, "order_details_id");
    const items = details.map((detail) => {
      const historicalCustomizations = snapshotsByDetail.has(detail.id)
        ? snapshotsByDetail.get(detail.id).map(snapshotSelection)
        : (legacyByDetail.get(detail.id) || []).map(legacySelection);
      return {
        orderdetail_id: detail.id,
        product_id: detail.productid,
        quantity: Number(detail.qty),
        unit_price: parseMoney(detail.price),
        total: parseMoney(detail.total),
        selections: historicalCustomizations.map((selection) => ({
          product_customization_step_choice_id:
            selection.product_customization_step_choice_id,
        })),
        historical_customizations: historicalCustomizations,
        requires_reconfiguration: historicalCustomizations.some(
          (selection) => selection.product_customization_step_choice_id == null,
        ),
      };
    });

    return {
      order: {
        ...order,
        is_takeaway: [true, 1, "1"].includes(order.is_takeaway),
      },
      items,
      content_revision: buildContentRevision(order, items),
    };
  };

  const amendOrder = (input) => {
    const amendment = validateAmendInput(input);
    return runInTransaction(async (connection) => {
      const order = await repository.lockOrder({
        orderId: amendment.orderId,
        shopId: amendment.shopId,
        connection,
      });
      if (!order) {
        throw new DomainError(404, "ORDER_NOT_FOUND", "Commande introuvable.");
      }
      if (!isOrderEditable(order)) {
        throw new DomainError(
          422,
          "ORDER_NOT_EDITABLE",
          "Cette commande ne peut pas etre modifiee.",
          { order_status: order.status, payment_status: order.payment_status },
        );
      }

      const details = await repository.lockDetails({
        orderId: order.id,
        shopId: amendment.shopId,
        connection,
      });
      const detailIds = details.map((detail) => Number(detail.id));
      const reservations = await repository.lockReservations({
        orderId: order.id,
        shopId: amendment.shopId,
        connection,
      });
      const snapshots = await repository.lockSnapshots({
        detailIds,
        shopId: amendment.shopId,
        connection,
      });
      const snapshotDetailIds = new Set(
        snapshots.map((snapshot) => Number(snapshot.orderdetail_id)),
      );
      const legacyCustomizations = await repository.lockLegacyCustomizations({
        detailIds: detailIds.filter((detailId) => !snapshotDetailIds.has(detailId)),
        shopId: amendment.shopId,
        connection,
      });

      const currentRevision = buildContentRevision(
        order,
        revisionItems(details, snapshots, legacyCustomizations),
      );
      if (currentRevision !== amendment.contentRevision) {
        throw new DomainError(
          409,
          "ORDER_EDIT_CONFLICT",
          "La commande a ete modifiee depuis son chargement.",
          { content_revision: currentRevision },
        );
      }

      let quote = {
        resolvedItems: [],
        total: 0,
        serverQuote: { total: 0, items: [] },
        requirements: new Map(),
      };
      if (amendment.items.length) {
        try {
          quote = await quoteItems({
            shopId: amendment.shopId,
            items: amendment.items,
            connection,
          });
        } catch (error) {
          if (error instanceof DomainError && RECONFIGURATION_ERROR_CODES.has(error.code)) {
            throw reconfigurationError(error);
          }
          throw error;
        }
      }
      if (cents(quote.total) !== cents(amendment.expectedTotal)) {
        throw new DomainError(
          409,
          "ORDER_REPRICE_REQUIRED",
          "Le prix de la commande a change.",
          { server_quote: quote.serverQuote },
        );
      }

      const before = reservations.length
        ? activeReservationRequirements(reservations)
        : storedRequirements(details, snapshots);
      const deltas = requirementDeltas(before, quote.requirements);
      const productIds = [...new Set([
        ...deltas.keys(),
        ...reservations.map((reservation) => Number(reservation.product_id)),
      ])].sort((left, right) => left - right);
      const products = await repository.lockProducts({
        shopId: amendment.shopId,
        productIds,
        connection,
      });
      const shortages = [];
      for (const [productId, delta] of deltas) {
        const product = products.find((row) => Number(row.id) === productId);
        const available = product ? Number(product.stock) : 0;
        if (!product || (delta > 0 && available < delta)) {
          shortages.push({
            product_id: productId,
            requested: Math.max(delta, 0),
            available,
          });
        }
      }
      if (shortages.length) {
        throw new DomainError(409, "INSUFFICIENT_STOCK", "Stock insuffisant.", { shortages });
      }

      if (input.prepareStripeReplacement && order.payment_provider === "stripe") {
        await input.prepareStripeReplacement({ order, connection });
      }

      for (const [productId, delta] of deltas) {
        if (delta === 0) continue;
        const result = await repository.adjustStock({
          shopId: amendment.shopId,
          productId,
          delta: -delta,
          connection,
        });
        if (!result.affectedRows) {
          const product = products.find((row) => Number(row.id) === productId);
          throw new DomainError(409, "INSUFFICIENT_STOCK", "Stock insuffisant.", {
            shortages: [{
              product_id: productId,
              requested: Math.max(delta, 0),
              available: product ? Number(product.stock) : 0,
            }],
          });
        }
      }

      const timestampDate = now();
      const timestamp = formatDate(timestampDate);
      await repository.deleteSnapshots({ detailIds, connection });
      await repository.deleteLegacyCustomizations({
        orderId: order.id,
        shopId: amendment.shopId,
        connection,
      });
      await repository.deleteDetails({
        orderId: order.id,
        shopId: amendment.shopId,
        connection,
      });

      const insertedDetails = [];
      const insertedSnapshots = [];
      for (const item of quote.resolvedItems) {
        const detail = {
          orderid: order.id,
          productid: item.productId,
          price: item.unitPrice,
          qty: item.quantity,
          total: item.lineTotal,
        };
        const detailResult = await repository.insertDetail({ detail, connection });
        insertedDetails.push({ id: detailResult.insertId, ...detail });
        for (const selectedChoice of item.selectedChoices) {
          const step = item.steps.find(
            (candidate) => Number(candidate.product_step_id) === Number(selectedChoice.step_id),
          );
          const choice = step && (step.choices || []).find(
            (candidate) => Number(candidate.product_step_choice_id)
              === Number(selectedChoice.product_step_choice_id),
          );
          const snapshot = {
            orderdetail_id: detailResult.insertId,
            product_customization_step_id: selectedChoice.step_id,
            product_customization_step_choice_id: selectedChoice.product_step_choice_id,
            step_name: selectedChoice.step_name,
            step_position: step ? step.position : 0,
            choice_type: selectedChoice.choice_type,
            choice_name: selectedChoice.choice_name,
            choice_position: choice ? choice.position : 0,
            unit_extra_price: selectedChoice.extra_price,
            linked_product_id: selectedChoice.linked_product_id,
            created: timestamp,
          };
          const snapshotResult = await repository.insertSnapshot({ snapshot, connection });
          insertedSnapshots.push({ id: snapshotResult.insertId, ...snapshot });
        }
      }

      const canceled = amendment.items.length === 0;
      const nextIsTakeaway = amendment.isTakeaway === undefined
        ? [true, 1, "1"].includes(order.is_takeaway)
        : amendment.isTakeaway;
      const orderChanges = {
        subtotal: quote.total,
        finished: timestamp,
        is_takeaway: nextIsTakeaway ? 1 : 0,
        ...(canceled && { status: 4 }),
      };
      const orderUpdate = await repository.updateOrder({
        orderId: order.id,
        shopId: amendment.shopId,
        changes: orderChanges,
        connection,
      });
      if (!orderUpdate.affectedRows) {
        throw new DomainError(409, "ORDER_EDIT_CONFLICT", "La commande a change.");
      }

      const reservationStatus = canceled
        ? "released"
        : order.payment_provider === "stripe" ? "reserved" : "committed";
      const expiresAt = reservationStatus === "reserved"
        ? formatDate(new Date(timestampDate.valueOf() + reservationTtlMinutes * 60 * 1000))
        : null;
      for (const productId of productIds) {
        await repository.upsertReservation({
          reservation: {
            order_id: order.id,
            product_id: productId,
            quantity: quote.requirements.get(productId) || 0,
            status: reservationStatus,
            expires_at: expiresAt,
            created: timestamp,
            updated: timestamp,
          },
          connection,
        });
        const delta = deltas.get(productId) || 0;
        if (order.payment_provider !== "stripe" && delta !== 0) {
          await repository.insertMovement({
            movement: {
              productid: productId,
              category: delta > 0 ? "1" : "2",
              qty: Math.abs(delta),
              operator: amendment.operatorId,
              remark: `${canceled ? "Annulation" : "Modification"} commande #${order.ordernumber}`,
              created: timestamp,
              updated: timestamp,
            },
            connection,
          });
        }
      }

      return {
        order_id: Number(order.id),
        total: quote.total,
        canceled,
        content_revision: buildContentRevision(
          { ...order, ...orderChanges },
          revisionItems(insertedDetails, insertedSnapshots),
        ),
      };
    });
  };

  return { amendOrder, getEditableOrder };
};

const orderEditingModule = buildOrderEditingModule();

module.exports = {
  buildContentRevision,
  buildOrderEditingModule,
  amendOrder: orderEditingModule.amendOrder,
  getEditableOrder: orderEditingModule.getEditableOrder,
  isOrderEditable,
  activeReservationRequirements,
  normalizeEditItems,
  requirementDeltas,
  storedRequirements,
};
