const crypto = require("crypto");
const pool = require("../config/dbPool");
const DomainError = require("../helpers/domainError");
const { parseMoney } = require("../helpers/money");
const { withTransaction } = require("../helpers/withTransaction");
const { envSTRIPESTOCKRESERVATIONMINUTES } = require("../helpers/env");
const {
  getResolvedProductConfigurations,
} = require("./m_customizations");
const { quoteOrderItems } = require("./m_orderQuote");

const EDITABLE_PAYMENT_STATUSES = new Set(["unpaid", "requires_payment"]);
const isEditableOrder = (order = {}) => (
  Number(order.status) === 1
  && EDITABLE_PAYMENT_STATUSES.has(String(order.payment_status))
);

const canonicalContent = ({ order, details, snapshots }) => ({
  subtotal: parseMoney(order.subtotal),
  items: [...details]
    .sort((left, right) => Number(left.id) - Number(right.id))
    .map((detail) => ({
      product_id: Number(detail.productid),
      quantity: Number(detail.qty),
      unit_price: parseMoney(detail.price),
      total: parseMoney(detail.total),
      choices: snapshots
        .filter((row) => Number(row.orderdetail_id) === Number(detail.id))
        .sort((left, right) => (
          Number(left.step_position) - Number(right.step_position)
          || Number(left.choice_position) - Number(right.choice_position)
          || Number(left.id || 0) - Number(right.id || 0)
        ))
        .map((row) => ({
          contextual_id: row.product_customization_step_choice_id == null
            ? null
            : Number(row.product_customization_step_choice_id),
          step_name: row.step_name,
          choice_name: row.choice_name,
          extra_price: parseMoney(row.unit_extra_price),
          linked_product_id: row.linked_product_id == null
            ? null
            : Number(row.linked_product_id),
        })),
    })),
});

const buildContentRevision = (content) => crypto
  .createHash("sha256")
  .update(JSON.stringify(canonicalContent(content)))
  .digest("hex");

const notEditable = (order) => new DomainError(
  409,
  "ORDER_NOT_EDITABLE",
  "Cette commande ne peut plus être modifiée.",
  {
    order_status: order && order.status,
    payment_status: order && order.payment_status,
  },
);

const queryResult = async (connection, sql, params = []) => {
  const [result] = await (connection || pool).query(sql, params);
  return result;
};

const sqlRepository = {
  findOrder: ({ orderId, shopId, connection }) => queryResult(
    connection,
    `SELECT * FROM orders
     WHERE id = ? AND shopid = ?
     LIMIT 1`,
    [orderId, shopId],
  ).then((rows) => rows[0] || null),
  findDetails: ({ orderId, connection }) => queryResult(
    connection,
    `SELECT orderdetail.*, products.name, products.image
     FROM orderdetail
     JOIN products ON products.id = orderdetail.productid
     WHERE orderdetail.orderid = ?
     ORDER BY orderdetail.id`,
    [orderId],
  ),
  findSnapshots: ({ detailIds, connection }) => (
    detailIds.length === 0
      ? Promise.resolve([])
      : queryResult(
        connection,
        `SELECT * FROM orderdetail_customization_snapshots
         WHERE orderdetail_id IN (?)
         ORDER BY orderdetail_id, step_position, choice_position, id`,
        [detailIds],
      )
  ),
  lockOrder: ({ orderId, shopId, connection }) => queryResult(
    connection,
    `SELECT * FROM orders
     WHERE id = ? AND shopid = ?
     LIMIT 1 FOR UPDATE`,
    [orderId, shopId],
  ).then((rows) => rows[0] || null),
  lockDetails: ({ orderId, connection }) => queryResult(
    connection,
    `SELECT * FROM orderdetail
     WHERE orderid = ? ORDER BY id FOR UPDATE`,
    [orderId],
  ),
  lockSnapshots: ({ detailIds, connection }) => (
    detailIds.length === 0
      ? Promise.resolve([])
      : queryResult(
        connection,
        `SELECT * FROM orderdetail_customization_snapshots
         WHERE orderdetail_id IN (?)
         ORDER BY orderdetail_id, step_position, choice_position, id
         FOR UPDATE`,
        [detailIds],
      )
  ),
  lockReservations: ({ orderId, connection }) => queryResult(
    connection,
    `SELECT * FROM order_stock_reservations
     WHERE order_id = ? ORDER BY product_id FOR UPDATE`,
    [orderId],
  ),
  lockProducts: ({ shopId, productIds, connection }) => queryResult(
    connection,
    `SELECT id, shopid, stock FROM products
     WHERE shopid = ? AND id IN (?)
     ORDER BY id FOR UPDATE`,
    [shopId, productIds],
  ),
  adjustStock: ({ shopId, productId, delta, connection }) => {
    const shortage = delta < 0 ? " AND stock >= ?" : "";
    const params = [delta, productId, shopId];
    if (delta < 0) params.push(-delta);
    return queryResult(
      connection,
      `UPDATE products SET stock = stock + ?
       WHERE id = ? AND shopid = ?${shortage}`,
      params,
    );
  },
  deleteSnapshots: ({ detailIds, connection }) => (
    detailIds.length === 0
      ? Promise.resolve({ affectedRows: 0 })
      : queryResult(
        connection,
        "DELETE FROM orderdetail_customization_snapshots WHERE orderdetail_id IN (?)",
        [detailIds],
      )
  ),
  deleteDetails: ({ orderId, connection }) => queryResult(
    connection,
    "DELETE FROM orderdetail WHERE orderid = ?",
    [orderId],
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
  updateOrderTotal: ({ orderId, shopId, total, finished, connection }) => queryResult(
    connection,
    `UPDATE orders SET subtotal = ?, finished = ?
     WHERE id = ? AND shopid = ?`,
    [total, finished, orderId, shopId],
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

const normalizeEditItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw new DomainError(400, "ORDER_ITEMS_REQUIRED", "La commande doit contenir un produit.");
  }
  return items.map((item, index) => {
    const productId = Number(item && (item.productId || item.product_id));
    const quantity = Number(item && item.quantity);
    const selectedChoiceIds = item && item.selectedChoiceIds !== undefined
      ? item.selectedChoiceIds
      : item && item.selected_product_step_choice_ids !== undefined
        ? item.selected_product_step_choice_ids
        : [];
    if (!Number.isSafeInteger(productId) || productId <= 0) {
      throw new DomainError(400, "CHECKOUT_REQUEST_INVALID", "Produit invalide.", {
        field: `items.${index}.product_id`,
      });
    }
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new DomainError(400, "CHECKOUT_REQUEST_INVALID", "Quantité invalide.", {
        field: `items.${index}.quantity`,
      });
    }
    if (!Array.isArray(selectedChoiceIds)) {
      throw new DomainError(400, "CHECKOUT_REQUEST_INVALID", "Suppléments invalides.", {
        field: `items.${index}.selected_product_step_choice_ids`,
      });
    }
    const normalizedChoices = selectedChoiceIds.map(Number);
    if (normalizedChoices.some((id) => !Number.isSafeInteger(id) || id <= 0)
      || new Set(normalizedChoices).size !== normalizedChoices.length) {
      throw new DomainError(400, "CHECKOUT_REQUEST_INVALID", "Suppléments invalides.", {
        field: `items.${index}.selected_product_step_choice_ids`,
      });
    }
    return { productId, quantity, selectedChoiceIds: normalizedChoices };
  });
};

const storedRequirements = (details, snapshots) => {
  const requirements = new Map();
  const add = (productId, quantity) => requirements.set(
    Number(productId),
    (requirements.get(Number(productId)) || 0) + Number(quantity),
  );
  for (const detail of details) {
    add(detail.productid, detail.qty);
    for (const snapshot of snapshots.filter(
      (row) => Number(row.orderdetail_id) === Number(detail.id),
    )) {
      if (snapshot.choice_type === "linked_product" && snapshot.linked_product_id) {
        add(snapshot.linked_product_id, detail.qty);
      }
    }
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

const disabled = (value) => [false, 0, "0"].includes(value);
const configurationFor = (configurations, productId) => (
  configurations.get(Number(productId))
  || configurations.get(String(productId))
  || []
);

const snapshotRequiresReconfiguration = (snapshot, steps) => {
  const contextualId = snapshot.product_customization_step_choice_id;
  if (contextualId == null) return true;

  for (const step of steps) {
    const choice = (step.choices || []).find(
      (candidate) => Number(candidate.product_step_choice_id) === Number(contextualId),
    );
    if (!choice) continue;
    return disabled(step.active)
      || disabled(step.available)
      || disabled(choice.active)
      || disabled(choice.available);
  }
  return true;
};

const mapSnapshot = (snapshot) => ({
  product_customization_step_id: snapshot.product_customization_step_id == null
    ? null
    : Number(snapshot.product_customization_step_id),
  product_customization_step_choice_id:
    snapshot.product_customization_step_choice_id == null
      ? null
      : Number(snapshot.product_customization_step_choice_id),
  step_name: snapshot.step_name,
  step_position: Number(snapshot.step_position),
  choice_type: snapshot.choice_type,
  choice_name: snapshot.choice_name,
  choice_position: Number(snapshot.choice_position),
  unit_extra_price: parseMoney(snapshot.unit_extra_price),
  linked_product_id: snapshot.linked_product_id == null
    ? null
    : Number(snapshot.linked_product_id),
});

const formatDate = (value) => value.toISOString().slice(0, 19).replace("T", " ");

const buildOrderEditingModule = ({
  repository = sqlRepository,
  withTransaction: runInTransaction = withTransaction,
  quoteOrderItems: quoteItems = quoteOrderItems,
  getResolvedProductConfigurations: loadConfigurations = (
    getResolvedProductConfigurations
  ),
  now = () => new Date(),
  reservationTtlMinutes = envSTRIPESTOCKRESERVATIONMINUTES,
} = {}) => {
  const getEditableOrder = async ({ orderId, shopId, connection }) => {
    const order = await repository.findOrder({ orderId, shopId, connection });
    if (!order) {
      throw new DomainError(404, "ORDER_NOT_FOUND", "Commande introuvable.");
    }
    if (!isEditableOrder(order)) throw notEditable(order);

    const details = await repository.findDetails({ orderId: order.id, connection });
    const detailIds = details.map((detail) => Number(detail.id));
    const snapshots = await repository.findSnapshots({ detailIds, connection });
    const productIds = [...new Set(details.map((detail) => Number(detail.productid)))]
      .sort((left, right) => left - right);
    const configurations = productIds.length
      ? await loadConfigurations({ shopId, productIds, connection })
      : new Map();

    const items = details.map((detail) => {
      const itemSnapshots = snapshots.filter(
        (snapshot) => Number(snapshot.orderdetail_id) === Number(detail.id),
      );
      const steps = configurationFor(configurations, detail.productid);
      return {
        order_detail_id: Number(detail.id),
        product_id: Number(detail.productid),
        name: detail.name,
        image: detail.image,
        quantity: Number(detail.qty),
        unit_price: parseMoney(detail.price),
        line_total: parseMoney(detail.total),
        selected_product_step_choice_ids: itemSnapshots
          .map((snapshot) => snapshot.product_customization_step_choice_id)
          .filter((id) => id != null)
          .map(Number),
        customization_snapshots: itemSnapshots.map(mapSnapshot),
        requires_reconfiguration: itemSnapshots.some(
          (snapshot) => snapshotRequiresReconfiguration(snapshot, steps),
        ),
      };
    });

    return {
      order_id: Number(order.id),
      order_number: order.ordernumber,
      status: Number(order.status),
      payment_status: order.payment_status,
      payment_provider: order.payment_provider,
      total: parseMoney(order.subtotal),
      content_revision: buildContentRevision({ order, details, snapshots }),
      items,
    };
  };

  const previewOrderEdit = async ({ shopId, items, connection }) => {
    const normalizedItems = normalizeEditItems(items);
    const quote = await quoteItems({
      shopId,
      items: normalizedItems,
      connection,
    });
    return quote.serverQuote;
  };

  const prepareOrderPaymentRegeneration = ({ orderId, shopId }) => (
    runInTransaction(async (connection) => {
      const order = await repository.lockOrder({ orderId, shopId, connection });
      if (!order) {
        throw new DomainError(404, "ORDER_NOT_FOUND", "Commande introuvable.");
      }
      if (Number(order.status) !== 1
        || order.payment_status !== "unpaid"
        || order.payment_provider !== "stripe"
        || order.stripe_payment_intent_id != null) {
        throw new DomainError(
          409,
          "ORDER_NOT_EDITABLE",
          "Le paiement de cette commande ne peut pas être régénéré.",
          {
            order_status: order.status,
            payment_status: order.payment_status,
          },
        );
      }

      const details = await repository.lockDetails({ orderId: order.id, connection });
      const detailIds = details.map((detail) => Number(detail.id));
      const snapshots = await repository.lockSnapshots({ detailIds, connection });
      const reservations = await repository.lockReservations({
        orderId: order.id,
        connection,
      });
      const requirements = storedRequirements(details, snapshots);
      const reservationByProduct = new Map(reservations.map(
        (reservation) => [Number(reservation.product_id), reservation],
      ));
      const deltas = new Map([...requirements.entries()].map(([productId, quantity]) => {
        const reservation = reservationByProduct.get(productId);
        const covered = reservation
          && ["reserved", "committed"].includes(reservation.status)
          ? Number(reservation.quantity)
          : 0;
        return [productId, quantity - covered];
      }));
      const productIds = [...requirements.keys()].sort((left, right) => left - right);
      const products = await repository.lockProducts({ shopId, productIds, connection });
      const shortages = [];
      for (const [productId, delta] of deltas) {
        const product = products.find((row) => Number(row.id) === productId);
        if (delta > 0 && (!product || Number(product.stock) < delta)) {
          shortages.push({
            product_id: productId,
            requested: delta,
            available: product ? Number(product.stock) : 0,
          });
        }
      }
      if (shortages.length) {
        throw new DomainError(409, "INSUFFICIENT_STOCK", "Stock insuffisant.", {
          shortages,
        });
      }

      for (const [productId, delta] of deltas) {
        if (delta === 0) continue;
        const adjustment = await repository.adjustStock({
          shopId,
          productId,
          delta: -delta,
          connection,
        });
        if (!adjustment.affectedRows) {
          throw new DomainError(409, "INSUFFICIENT_STOCK", "Stock insuffisant.", {
            shortages: [{ product_id: productId, requested: delta, available: 0 }],
          });
        }
      }

      const currentDate = now();
      const timestamp = formatDate(currentDate);
      const expiresAt = formatDate(new Date(
        currentDate.valueOf() + reservationTtlMinutes * 60 * 1000,
      ));
      for (const productId of productIds) {
        const current = reservationByProduct.get(productId);
        const committed = current && current.status === "committed";
        await repository.upsertReservation({
          reservation: {
            order_id: order.id,
            product_id: productId,
            quantity: requirements.get(productId),
            status: committed ? "committed" : "reserved",
            expires_at: committed ? null : expiresAt,
            created: current && current.created ? current.created : timestamp,
            updated: timestamp,
          },
          connection,
        });
      }

      return {
        order,
        contentRevision: buildContentRevision({ order, details, snapshots }),
      };
    })
  );

  const updateOrderItems = (input) => {
    const items = normalizeEditItems(input.items);
    return runInTransaction(async (connection) => {
      const order = await repository.lockOrder({
        orderId: input.orderId,
        shopId: input.shopId,
        connection,
      });
      if (!order) {
        throw new DomainError(404, "ORDER_NOT_FOUND", "Commande introuvable.");
      }
      if (!isEditableOrder(order)) throw notEditable(order);

      const details = await repository.lockDetails({
        orderId: order.id,
        connection,
      });
      const detailIds = details.map((detail) => Number(detail.id));
      const snapshots = await repository.lockSnapshots({ detailIds, connection });
      await repository.lockReservations({ orderId: order.id, connection });

      const currentRevision = buildContentRevision({ order, details, snapshots });
      if (currentRevision !== input.contentRevision) {
        throw new DomainError(
          409,
          "ORDER_EDIT_CONFLICT",
          "La commande a été modifiée depuis son chargement.",
          { content_revision: currentRevision },
        );
      }

      const quote = await quoteItems({
        shopId: input.shopId,
        items,
        connection,
      });
      if (parseMoney(input.expectedTotal) !== quote.total) {
        throw new DomainError(
          409,
          "ORDER_REPRICE_REQUIRED",
          "Le prix de la commande a changé.",
          { server_quote: quote.serverQuote },
        );
      }

      const before = storedRequirements(details, snapshots);
      const deltas = requirementDeltas(before, quote.requirements);
      const productIds = [...deltas.keys()].sort((left, right) => left - right);
      const products = await repository.lockProducts({
        shopId: input.shopId,
        productIds,
        connection,
      });
      const shortages = [];
      for (const [productId, delta] of deltas) {
        const product = products.find((row) => Number(row.id) === productId);
        if (delta > 0 && (!product || Number(product.stock) < delta)) {
          shortages.push({
            product_id: productId,
            requested: delta,
            available: product ? Number(product.stock) : 0,
          });
        }
      }
      if (shortages.length) {
        throw new DomainError(409, "INSUFFICIENT_STOCK", "Stock insuffisant.", {
          shortages,
        });
      }

      if (order.payment_status === "requires_payment") {
        if (typeof input.settlePendingPayment !== "function") {
          throw new DomainError(
            409,
            "STRIPE_PAYMENT_REFRESH_REQUIRED",
            "Le paiement Stripe doit être synchronisé avant la modification.",
          );
        }
        await input.settlePendingPayment({ order, connection });
      }

      for (const [productId, delta] of deltas) {
        if (delta === 0) continue;
        const adjustment = await repository.adjustStock({
          shopId: input.shopId,
          productId,
          delta: -delta,
          connection,
        });
        if (!adjustment.affectedRows) {
          throw new DomainError(409, "INSUFFICIENT_STOCK", "Stock insuffisant.", {
            shortages: [{
              product_id: productId,
              requested: delta,
              available: 0,
            }],
          });
        }
      }

      const currentDate = now();
      const timestamp = formatDate(currentDate);
      const expiresAt = formatDate(new Date(
        currentDate.valueOf() + reservationTtlMinutes * 60 * 1000,
      ));

      await repository.deleteSnapshots({ detailIds, connection });
      await repository.deleteDetails({ orderId: order.id, connection });
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
            (candidate) => Number(candidate.product_step_id)
              === Number(selectedChoice.step_id),
          );
          const choice = step && (step.choices || []).find(
            (candidate) => Number(candidate.product_step_choice_id)
              === Number(selectedChoice.product_step_choice_id),
          );
          const snapshot = {
            orderdetail_id: detailResult.insertId,
            product_customization_step_id: selectedChoice.step_id,
            product_customization_step_choice_id:
              selectedChoice.product_step_choice_id,
            step_name: selectedChoice.step_name,
            step_position: step ? step.position : 0,
            choice_type: selectedChoice.choice_type,
            choice_name: selectedChoice.choice_name,
            choice_position: choice ? choice.position : 0,
            unit_extra_price: selectedChoice.extra_price,
            linked_product_id: selectedChoice.linked_product_id,
            created: timestamp,
          };
          const snapshotResult = await repository.insertSnapshot({
            snapshot,
            connection,
          });
          insertedSnapshots.push({ id: snapshotResult.insertId, ...snapshot });
        }
      }

      await repository.updateOrderTotal({
        orderId: order.id,
        shopId: input.shopId,
        total: quote.total,
        finished: timestamp,
        connection,
      });
      const reservationStatus = order.payment_provider === "stripe"
        ? "reserved"
        : "committed";
      for (const productId of productIds) {
        await repository.upsertReservation({
          reservation: {
            order_id: order.id,
            product_id: productId,
            quantity: quote.requirements.get(productId) || 0,
            status: reservationStatus,
            expires_at: reservationStatus === "reserved" ? expiresAt : null,
            created: timestamp,
            updated: timestamp,
          },
          connection,
        });
        const delta = deltas.get(productId);
        if (reservationStatus === "committed" && delta !== 0) {
          await repository.insertMovement({
            movement: {
              productid: productId,
              category: delta > 0 ? "1" : "2",
              qty: Math.abs(delta),
              operator: input.actorId,
              remark: `Modification commande #${order.ordernumber}`,
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
        content_revision: buildContentRevision({
          order: { ...order, subtotal: quote.total },
          details: insertedDetails,
          snapshots: insertedSnapshots,
        }),
        payment_status: order.payment_status,
        payment_provider: order.payment_provider,
        payment_refresh: "not_required",
      };
    });
  };

  return {
    getEditableOrder,
    prepareOrderPaymentRegeneration,
    previewOrderEdit,
    updateOrderItems,
  };
};

const orderEditingModule = buildOrderEditingModule();

module.exports = {
  buildContentRevision,
  buildOrderEditingModule,
  getEditableOrder: orderEditingModule.getEditableOrder,
  isEditableOrder,
  normalizeEditItems,
  notEditable,
  prepareOrderPaymentRegeneration: orderEditingModule.prepareOrderPaymentRegeneration,
  previewOrderEdit: orderEditingModule.previewOrderEdit,
  requirementDeltas,
  storedRequirements,
  updateOrderItems: orderEditingModule.updateOrderItems,
};
