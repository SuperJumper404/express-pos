const crypto = require("crypto");
const pool = require("../config/dbPool");
const DomainError = require("../helpers/domainError");
const { parseMoney } = require("../helpers/money");
const { custom } = require("../helpers/response");
const { withTransaction } = require("../helpers/withTransaction");
const { validateConfiguredItem } = require("../helpers/customizationRules");
const { buildStockRequirements } = require("../helpers/stockRequirements");
const { nextReservationStatus } = require("../helpers/reservationLifecycle");
const { envSTRIPESTOCKRESERVATIONMINUTES } = require("../helpers/env");
const {
  getResolvedProductConfigurations,
} = require("./m_customizations");
const { buildOrderQuoteModule } = require("./m_orderQuote");

const RESERVATION_TTL_MS = envSTRIPESTOCKRESERVATIONMINUTES * 60 * 1000;

const formatDate = (value) => value.toISOString().slice(0, 19).replace("T", " ");
const cents = (value) => Math.round(Number(value) * 100);
const isPositiveId = (value) => {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0;
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return false;
  const number = Number(value.trim());
  return Number.isSafeInteger(number) && number > 0;
};
const uniqueSortedIds = (values) => [...new Set(values.map(Number))].sort((a, b) => a - b);

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((result, key) => {
      if (value[key] !== undefined) result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value;
};

const canonicalPayload = (input) => {
  const items = (input.items || []).map((item) => ({
    product_id: Number(item.productId),
    quantity: Number(item.quantity),
    selected_choice_ids: (item.selectedChoiceIds || []).map(Number).sort((a, b) => a - b),
  })).sort((left, right) => (
    left.product_id - right.product_id
    || left.quantity - right.quantity
    || JSON.stringify(left.selected_choice_ids).localeCompare(JSON.stringify(right.selected_choice_ids))
  ));
  const customer = input.customer || {};
  return stableValue({
    customer: {
      id: Number(customer.id),
      name: typeof customer.name === "string" ? customer.name.trim() : customer.name,
      phone: customer.phone == null ? null : String(customer.phone).trim(),
      remark: customer.remark == null ? null : String(customer.remark).trim(),
    },
    expected_total: parseMoney(input.expectedTotal),
    is_takeaway: input.isTakeaway === true,
    items,
    payment_mode: typeof input.paymentMode === "string"
      ? input.paymentMode.trim().toLowerCase()
      : input.paymentMode,
  });
};

const canonicalPayloadHash = (input) => crypto
  .createHash("sha256")
  .update(JSON.stringify(canonicalPayload(input)))
  .digest("hex");

const invalidRequest = (field) => new DomainError(
  400,
  "CHECKOUT_REQUEST_INVALID",
  "Invalid checkout request",
  { field },
);

const normalizeBoolean = (value, field, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  if ([true, 1, "1"].includes(value)) return true;
  if ([false, 0, "0"].includes(value)) return false;
  throw invalidRequest(field);
};

const comparableChoiceIds = (values) => {
  if (!Array.isArray(values)) return values;
  return values.map((value) => {
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      return Number(value.trim());
    }
    return value;
  }).sort((left, right) => String(left).localeCompare(String(right)));
};

const normalizeCheckoutRequestBody = (body = {}, { paymentModeOverride } = {}) => {
  const customer = body.customer && typeof body.customer === "object"
    ? {
      id: body.customer.id,
      name: body.customer.name,
      phone: body.customer.phone,
      remark: body.customer.remark,
    }
    : {
      id: body.customerID,
      name: body.customer,
      phone: body.phone,
      remark: body.remark,
    };
  const items = Array.isArray(body.items) ? body.items.map((item, itemIndex) => {
    const publicChoiceIds = item && item.selected_product_step_choice_ids;
    const compatibilityChoiceIds = item && item.selected_choice_ids;
    if (publicChoiceIds !== undefined && compatibilityChoiceIds !== undefined
      && JSON.stringify(comparableChoiceIds(publicChoiceIds))
        !== JSON.stringify(comparableChoiceIds(compatibilityChoiceIds))) {
      throw invalidRequest(`items.${itemIndex}.selected_product_step_choice_ids`);
    }
    return {
      productId: item && item.product_id,
      quantity: item && item.quantity,
      selectedChoiceIds: publicChoiceIds !== undefined
        ? publicChoiceIds
        : compatibilityChoiceIds,
    };
  }) : body.items;

  return {
    customer,
    items,
    expectedTotal: body.expected_total,
    isTakeaway: normalizeBoolean(body.is_takeaway, "is_takeaway"),
    clientOrderToken: body.client_order_token,
    paymentMode: paymentModeOverride !== undefined
      ? paymentModeOverride
      : body.payment_mode !== undefined ? body.payment_mode : body.payment,
  };
};

const validateCheckoutInput = (input = {}) => {
  if (!isPositiveId(input.shopId)) throw invalidRequest("shop_id");
  if (!isPositiveId(input.actorId)) throw invalidRequest("actor_id");
  if (!input.customer || typeof input.customer !== "object") throw invalidRequest("customer");
  if (!isPositiveId(input.customer.id)) throw invalidRequest("customer.id");
  if (typeof input.customer.name !== "string" || !input.customer.name.trim()) {
    throw invalidRequest("customer.name");
  }
  if (!Array.isArray(input.items) || input.items.length === 0) throw invalidRequest("items");

  const items = input.items.map((item, itemIndex) => {
    if (!item || !isPositiveId(item.productId)) throw invalidRequest(`items.${itemIndex}.product_id`);
    if (!isPositiveId(item.quantity)) throw invalidRequest(`items.${itemIndex}.quantity`);
    const choiceIds = item.selectedChoiceIds == null ? [] : item.selectedChoiceIds;
    if (!Array.isArray(choiceIds) || choiceIds.some((choiceId) => !isPositiveId(choiceId))) {
      throw invalidRequest(`items.${itemIndex}.selected_choice_ids`);
    }
    return {
      productId: Number(item.productId),
      quantity: Number(item.quantity),
      selectedChoiceIds: choiceIds.map(Number),
    };
  });

  const expectedTotal = parseMoney(input.expectedTotal);
  if (expectedTotal === null || expectedTotal < 0) throw invalidRequest("expected_total");
  if (typeof input.clientOrderToken !== "string"
    || !input.clientOrderToken.trim()
    || input.clientOrderToken.trim().length > 64) {
    throw invalidRequest("client_order_token");
  }
  if (typeof input.paymentMode !== "string" || !input.paymentMode.trim()) {
    throw invalidRequest("payment_mode");
  }
  const isTakeaway = normalizeBoolean(input.isTakeaway, "is_takeaway");

  return {
    shopId: Number(input.shopId),
    actorId: Number(input.actorId),
    customer: {
      id: Number(input.customer.id),
      name: input.customer.name.trim(),
      phone: input.customer.phone == null ? null : String(input.customer.phone).trim(),
      remark: input.customer.remark == null ? null : String(input.customer.remark).trim(),
    },
    items,
    expectedTotal,
    isTakeaway,
    clientOrderToken: input.clientOrderToken.trim(),
    paymentMode: input.paymentMode.trim().toLowerCase(),
  };
};

const queryResult = async (connection, sql, params = []) => {
  const [result] = await (connection || pool).query(sql, params);
  return result;
};

const sqlRepository = {
  findOrderByToken: ({ shopId, token, connection }) => queryResult(
    connection,
    `SELECT id, shopid, subtotal, payment_status, client_order_payload_hash
     FROM orders
     WHERE shopid = ? AND client_order_token = ?
     LIMIT 1`,
    [shopId, token],
  ).then((rows) => rows[0] || null),

  getProducts: ({ shopId, productIds, connection }) => queryResult(
    connection,
    `SELECT id, shopid, name, price, stock, archived, is_hidden
     FROM products
     WHERE shopid = ? AND id IN (?)
     ORDER BY id`,
    [shopId, productIds],
  ),

  lockExpiredReservations: ({ now, connection }) => queryResult(
    connection,
    `SELECT reservations.id, reservations.order_id, reservations.product_id,
            reservations.quantity, reservations.status, reservations.expires_at
     FROM order_stock_reservations reservations
     JOIN orders ON orders.id = reservations.order_id
     WHERE reservations.status = 'reserved'
       AND reservations.expires_at IS NOT NULL
       AND reservations.expires_at <= ?
       AND NOT (
         COALESCE(orders.payment_provider, '') = 'stripe'
         AND COALESCE(orders.payment_status, '') = 'requires_payment'
       )
     ORDER BY reservations.product_id, reservations.id
     FOR UPDATE`,
    [now],
  ),

  lockReservationsByOrder: ({ orderId, connection }) => queryResult(
    connection,
    `SELECT id, order_id, product_id, quantity, status, expires_at
     FROM order_stock_reservations
     WHERE order_id = ?
     ORDER BY product_id, id
     FOR UPDATE`,
    [orderId],
  ),

  lockOrderForReservationBackfill: ({ orderId, connection }) => queryResult(
    connection,
    `SELECT id, shopid, operator, customerID, client_order_token
     FROM orders
     WHERE id = ?
     LIMIT 1
     FOR UPDATE`,
    [orderId],
  ).then((rows) => rows[0] || null),

  getLegacyOrderDetails: ({ orderId, connection }) => queryResult(
    connection,
    `SELECT productid, SUM(qty) AS quantity
     FROM orderdetail
     WHERE orderid = ?
     GROUP BY productid
     ORDER BY productid`,
    [orderId],
  ),

  lockProducts: ({ shopId, productIds, connection }) => {
    const shopClause = shopId == null ? "" : " AND shopid = ?";
    const params = shopId == null ? [productIds] : [productIds, shopId];
    return queryResult(
      connection,
      `SELECT id, shopid, stock
       FROM products
       WHERE id IN (?)${shopClause}
       ORDER BY id
       FOR UPDATE`,
      params,
    );
  },

  adjustStock: ({ shopId, productId, delta, connection }) => {
    const shopClause = shopId == null ? "" : " AND shopid = ?";
    const shortageClause = delta < 0 ? " AND stock >= ?" : "";
    const params = [delta, productId];
    if (shopId != null) params.push(shopId);
    if (delta < 0) params.push(-delta);
    return queryResult(
      connection,
      `UPDATE products
       SET stock = stock + ?
       WHERE id = ?${shopClause}${shortageClause}`,
      params,
    );
  },

  insertOrder: ({ order, connection }) => queryResult(
    connection,
    "INSERT INTO orders SET ?",
    [order],
  ),

  insertOrderDetail: ({ detail, connection }) => queryResult(
    connection,
    "INSERT INTO orderdetail SET ?",
    [detail],
  ),

  insertSnapshot: ({ snapshot, connection }) => queryResult(
    connection,
    "INSERT INTO orderdetail_customization_snapshots SET ?",
    [snapshot],
  ),

  insertReservation: ({ reservation, connection }) => queryResult(
    connection,
    "INSERT INTO order_stock_reservations SET ?",
    [reservation],
  ),

  updateReservationStatus: ({
    reservationId, fromStatus, toStatus, now, connection,
  }) => queryResult(
    connection,
    `UPDATE order_stock_reservations
     SET status = ?, updated = ?
     WHERE id = ? AND status = ?`,
    [toStatus, now, reservationId, fromStatus],
  ),

  insertMovement: ({ movement, connection }) => queryResult(
    connection,
    "INSERT INTO stocks SET ?",
    [movement],
  ),
};

const findById = (rows, id) => rows.find((row) => String(row.id) === String(id));
const replayResult = (order) => ({
  orderId: order.id,
  total: parseMoney(order.subtotal),
  idempotent_replay: true,
  payment_status: order.payment_status,
});
const isDuplicateKeyError = (error) => error && (
  error.code === "ER_DUP_ENTRY" || error.errno === 1062
);

const buildCheckoutController = ({ checkout, logger = console }) => async (req, res) => {
  const body = req.body || {};

  try {
    const normalized = normalizeCheckoutRequestBody(body);
    const result = await checkout.createCheckout({
      shopId: req.shopid,
      actorId: req.id,
      ...normalized,
    });
    return custom(
      res,
      result.idempotent_replay ? 200 : 201,
      result.idempotent_replay ? "Commande existante récupérée." : "Commande créée avec succès.",
      null,
      result,
    );
  } catch (error) {
    if (error instanceof DomainError) {
      const data = { code: error.code };
      for (const key of Object.keys(error)) {
        if (!["status", "code"].includes(key)) data[key] = error[key];
      }
      return custom(res, error.status, error.message, null, data);
    }
    logger.error("Transactional checkout failed", error);
    return custom(res, 500, "Erreur serveur.", null, { code: "INTERNAL_ERROR" });
  }
};

const buildCheckoutModule = ({
  repository = sqlRepository,
  withTransaction: runInTransaction = withTransaction,
  getResolvedProductConfigurations: loadConfigurations = getResolvedProductConfigurations,
  validateConfiguredItem: validateItem = validateConfiguredItem,
  buildStockRequirements: stockRequirements = buildStockRequirements,
  now = () => new Date(),
  reservationTtlMs = RESERVATION_TTL_MS,
} = {}) => {
  const runWithConnection = (connection, work) => (
    connection ? work(connection) : runInTransaction(work)
  );
  const { quoteOrderItems } = buildOrderQuoteModule({
    repository,
    getResolvedProductConfigurations: loadConfigurations,
    validateConfiguredItem: validateItem,
    buildStockRequirements: stockRequirements,
  });

  const releaseExpiredReservations = (options = {}) => runWithConnection(
    options.connection,
    async (connection) => {
      const timestamp = formatDate(now());
      const reservations = await repository.lockExpiredReservations({
        now: timestamp,
        connection,
      });
      const releasable = reservations.filter((row) => row.status === "reserved");
      const productIds = uniqueSortedIds(releasable.map((row) => row.product_id));
      if (productIds.length) await repository.lockProducts({ productIds, connection });

      let released = 0;
      for (const reservation of releasable) {
        const update = await repository.updateReservationStatus({
          reservationId: reservation.id,
          fromStatus: "reserved",
          toStatus: "released",
          now: timestamp,
          connection,
        });
        if (!update.affectedRows) continue;
        await repository.adjustStock({
          productId: reservation.product_id,
          delta: Number(reservation.quantity),
          connection,
        });
        released += 1;
      }
      return released;
    },
  );

  const finalizeReservations = ({
    orderId, status, operator, connection: suppliedConnection,
  } = {}) => {
    if (!isPositiveId(orderId)) return Promise.reject(invalidRequest("order_id"));
    const action = status === "committed" ? "commit" : status === "released" ? "release" : status;
    if (!Object.prototype.hasOwnProperty.call({ commit: true, release: true }, action)) {
      return Promise.reject(invalidRequest("status"));
    }
    if (action === "commit" && !isPositiveId(operator)) {
      return Promise.reject(invalidRequest("operator"));
    }

    return runWithConnection(suppliedConnection, async (connection) => {
      const reservations = await repository.lockReservationsByOrder({
        orderId: Number(orderId),
        connection,
      });
      if (action === "commit" && reservations.length === 0) {
        const order = await repository.lockOrderForReservationBackfill({
          orderId: Number(orderId),
          connection,
        });
        if (!order || order.client_order_token !== null) {
          throw new DomainError(
            409,
            "RESERVATION_INTEGRITY_ERROR",
            "Checkout stock reservations are missing",
            { order_id: Number(orderId) },
          );
        }

        const details = await repository.getLegacyOrderDetails({
          orderId: Number(orderId),
          connection,
        });
        const requirements = details.map((detail) => ({
          productId: Number(detail.productid),
          quantity: Number(detail.quantity),
        })).filter((detail) => (
          Number.isSafeInteger(detail.productId)
          && detail.productId > 0
          && Number.isSafeInteger(detail.quantity)
          && detail.quantity > 0
        ));
        if (requirements.length === 0 || requirements.length !== details.length) {
          throw new DomainError(
            409,
            "RESERVATION_INTEGRITY_ERROR",
            "Legacy order stock requirements cannot be reconstructed",
            { order_id: Number(orderId) },
          );
        }

        const productIds = uniqueSortedIds(requirements.map((detail) => detail.productId));
        const products = await repository.lockProducts({
          shopId: order.shopid,
          productIds,
          connection,
        });
        const shortages = requirements.reduce((result, requirement) => {
          const product = findById(products, requirement.productId);
          const available = product ? Number(product.stock) : 0;
          if (!product || available < requirement.quantity) {
            result.push({
              product_id: requirement.productId,
              requested: requirement.quantity,
              available,
            });
          }
          return result;
        }, []);
        if (shortages.length) {
          throw new DomainError(409, "INSUFFICIENT_STOCK", "Insufficient stock", {
            shortages,
          });
        }

        const timestamp = formatDate(now());
        for (const requirement of requirements) {
          const stockUpdate = await repository.adjustStock({
            shopId: order.shopid,
            productId: requirement.productId,
            delta: -requirement.quantity,
            connection,
          });
          if (!stockUpdate.affectedRows) {
            throw new DomainError(409, "INSUFFICIENT_STOCK", "Insufficient stock", {
              shortages: [{
                product_id: requirement.productId,
                requested: requirement.quantity,
                available: 0,
              }],
            });
          }
          await repository.insertReservation({
            reservation: {
              order_id: Number(orderId),
              product_id: requirement.productId,
              quantity: requirement.quantity,
              status: "committed",
              expires_at: null,
              created: timestamp,
              updated: timestamp,
            },
            connection,
          });
          await repository.insertMovement({
            movement: {
              productid: requirement.productId,
              category: "1",
              qty: requirement.quantity,
              operator: Number(operator),
              remark: "Legacy checkout reservation committed",
              created: timestamp,
              updated: timestamp,
            },
            connection,
          });
        }
        return {
          orderId: Number(orderId),
          status: action,
          changed: requirements.length,
          compatibility_backfill: true,
        };
      }
      const transitions = reservations.map((reservation) => ({
        reservation,
        nextStatus: nextReservationStatus(reservation.status, action),
      })).filter(({ reservation, nextStatus }) => reservation.status !== nextStatus);

      if (action === "release" && transitions.length) {
        await repository.lockProducts({
          productIds: uniqueSortedIds(transitions.map(({ reservation }) => reservation.product_id)),
          connection,
        });
      }

      const timestamp = formatDate(now());
      let changed = 0;
      for (const { reservation, nextStatus } of transitions) {
        const update = await repository.updateReservationStatus({
          reservationId: reservation.id,
          fromStatus: reservation.status,
          toStatus: nextStatus,
          now: timestamp,
          connection,
        });
        if (!update.affectedRows) continue;
        if (action === "release") {
          await repository.adjustStock({
            productId: reservation.product_id,
            delta: Number(reservation.quantity),
            connection,
          });
        } else {
          await repository.insertMovement({
            movement: {
              productid: reservation.product_id,
              category: "1",
              qty: reservation.quantity,
              operator: Number(operator),
              remark: "Checkout reservation committed",
              created: timestamp,
              updated: timestamp,
            },
            connection,
          });
        }
        changed += 1;
      }
      return { orderId: Number(orderId), status: action, changed };
    });
  };

  const createCheckout = async (input) => {
    const checkout = validateCheckoutInput(input);
    const payloadHash = canonicalPayloadHash(checkout);
    const transactionWork = async (connection) => {
      const existing = await repository.findOrderByToken({
        shopId: checkout.shopId,
        token: checkout.clientOrderToken,
        connection,
      });
      if (existing) {
        if (String(existing.client_order_payload_hash) !== payloadHash) {
          throw new DomainError(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "The client order token was already used for another payload",
          );
        }
        return replayResult(existing);
      }

      const {
        resolvedItems,
        total,
        serverQuote,
        requirements,
      } = await quoteOrderItems({
        shopId: checkout.shopId,
        items: checkout.items,
        connection,
      });
      if (cents(total) !== cents(checkout.expectedTotal)) {
        throw new DomainError(
          409,
          "ORDER_REPRICE_REQUIRED",
          "The order price changed",
          { server_quote: serverQuote },
        );
      }

      const timestampDate = now();
      const timestamp = formatDate(timestampDate);
      const stripe = checkout.paymentMode === "stripe";
      const paymentStatus = stripe ? "requires_payment" : "unpaid";
      const orderResult = await repository.insertOrder({
        order: {
          shopid: checkout.shopId,
          ordernumber: String(timestampDate.valueOf()).slice(-4).padStart(4, "0"),
          customer: checkout.customer.name,
          phone: checkout.customer.phone,
          customerID: checkout.customer.id,
          operator: checkout.actorId,
          subtotal: total,
          payment: checkout.paymentMode,
          payment_status: paymentStatus,
          payment_provider: stripe ? "stripe" : null,
          status: 1,
          created: timestamp,
          finished: timestamp,
          remark: checkout.customer.remark,
          is_takeaway: checkout.isTakeaway ? 1 : 0,
          client_order_token: checkout.clientOrderToken,
          client_order_payload_hash: payloadHash,
        },
        connection,
      });
      const orderId = orderResult.insertId;

      await releaseExpiredReservations({ connection });

      const stockProductIds = uniqueSortedIds([...requirements.keys()]);
      const lockedProducts = await repository.lockProducts({
        shopId: checkout.shopId,
        productIds: stockProductIds,
        connection,
      });
      const shortages = stockProductIds.reduce((result, productId) => {
        const row = findById(lockedProducts, productId);
        const requested = requirements.get(productId);
        const available = row ? Number(row.stock) : 0;
        if (!row || available < requested) {
          result.push({ product_id: productId, requested, available });
        }
        return result;
      }, []);
      if (shortages.length) {
        throw new DomainError(409, "INSUFFICIENT_STOCK", "Insufficient stock", { shortages });
      }

      for (const productId of stockProductIds) {
        const quantity = requirements.get(productId);
        const result = await repository.adjustStock({
          shopId: checkout.shopId,
          productId,
          delta: -quantity,
          connection,
        });
        if (!result.affectedRows) {
          throw new DomainError(409, "INSUFFICIENT_STOCK", "Insufficient stock", {
            shortages: [{ product_id: productId, requested: quantity, available: 0 }],
          });
        }
      }

      for (const item of resolvedItems) {
        const detailResult = await repository.insertOrderDetail({
          detail: {
            orderid: orderId,
            productid: item.productId,
            price: item.unitPrice,
            qty: item.quantity,
            total: item.lineTotal,
            vat_rate: item.vatRate,
            unit_price_ht: item.unitPriceHt,
            unit_vat: item.unitVat,
            total_ht: item.totalHt,
            total_vat: item.totalVat,
          },
          connection,
        });
        for (const selectedChoice of item.selectedChoices) {
          const step = item.steps.find(
            (candidate) => candidate.product_step_id === selectedChoice.step_id,
          );
          const choice = step && step.choices.find(
            (candidate) => candidate.product_step_choice_id
              === selectedChoice.product_step_choice_id,
          );
          await repository.insertSnapshot({
            snapshot: {
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
            },
            connection,
          });
        }
      }

      const expiresAt = stripe
        ? formatDate(new Date(timestampDate.valueOf() + reservationTtlMs))
        : null;
      for (const productId of stockProductIds) {
        await repository.insertReservation({
          reservation: {
            order_id: orderId,
            product_id: productId,
            quantity: requirements.get(productId),
            status: "reserved",
            expires_at: expiresAt,
            created: timestamp,
            updated: null,
          },
          connection,
        });
      }

      if (!stripe) {
        await finalizeReservations({
          orderId,
          status: "commit",
          operator: checkout.actorId,
          connection,
        });
      }

      return {
        orderId,
        total,
        idempotent_replay: false,
        payment_status: paymentStatus,
      };
    };

    try {
      return await runInTransaction(transactionWork);
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const winner = await repository.findOrderByToken({
        shopId: checkout.shopId,
        token: checkout.clientOrderToken,
      });
      if (!winner || String(winner.client_order_payload_hash) !== payloadHash) {
        throw new DomainError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "The client order token was already used for another payload",
        );
      }
      return replayResult(winner);
    }
  };

  return {
    createCheckout,
    finalizeReservations,
    releaseExpiredReservations,
  };
};

const checkoutModule = buildCheckoutModule();

module.exports = {
  buildCheckoutController,
  buildCheckoutModule,
  canonicalPayloadHash,
  createCheckout: checkoutModule.createCheckout,
  finalizeReservations: checkoutModule.finalizeReservations,
  normalizeCheckoutRequestBody,
  releaseExpiredReservations: checkoutModule.releaseExpiredReservations,
};
