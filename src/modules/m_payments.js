const conn = require("../config/db");
const { resolveStripePaymentMethod } = require("../helpers/stripePaymentMethod");

const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

const query = (sql, values = []) =>
  new Promise((resolve, reject) => {
    conn.query(sql, values, (err, result) => {
      if (err) {
        reject(new Error(err.message));
      } else {
        resolve(result);
      }
    });
  });

const insertOrderCustomization = (orderId, orderDetailId, productId, choices) => {
  if (!Array.isArray(choices) || choices.length === 0) {
    return Promise.resolve();
  }

  return query("INSERT INTO orders_customization SET ?", [
    {
      order_id: orderId,
      order_details_id: orderDetailId,
      product_id: productId,
      product_choice_id: choices[0].id || choices[0].product_choice_id,
    },
  ]).then(() => {
    const remaining = choices.slice(1);
    return remaining.reduce(
      (promise, choice) =>
        promise.then(() =>
          query("INSERT INTO orders_customization SET ?", [
            {
              order_id: orderId,
              order_details_id: orderDetailId,
              product_id: productId,
              product_choice_id: choice.id || choice.product_choice_id,
            },
          ]),
        ),
      Promise.resolve(),
    );
  });
};

const createPendingStripeOrder = ({ order, details }) =>
  new Promise((resolve, reject) => {
    conn.beginTransaction((transactionError) => {
      if (transactionError) {
        return reject(new Error(transactionError.message));
      }

      conn.query("INSERT INTO orders SET ?", order, async (orderError, result) => {
        if (orderError) {
          return conn.rollback(() => reject(new Error(orderError.message)));
        }

        const orderId = result.insertId;

        try {
          for (const item of details) {
            const detailData = {
              orderid: orderId,
              productid: item.productid,
              price: item.price,
              qty: item.qty,
              total: item.total,
            };
            const detailResult = await query("INSERT INTO orderdetail SET ?", [
              detailData,
            ]);
            await insertOrderCustomization(
              orderId,
              detailResult.insertId,
              item.productid,
              item.customizationList,
            );
          }

          conn.commit((commitError) => {
            if (commitError) {
              return conn.rollback(() => reject(new Error(commitError.message)));
            }
            resolve({ insertId: orderId });
          });
        } catch (error) {
          conn.rollback(() => reject(error));
        }
      });
    });
  });

const createPaymentRecord = (data) =>
  query("INSERT INTO payments SET ?", [
    {
      order_id: data.order_id,
      shop_id: data.shop_id,
      stripe_payment_intent_id: data.stripe_payment_intent_id,
      amount: data.amount,
      amount_cents: data.amount_cents,
      application_fee_amount: data.application_fee_amount,
      currency: data.currency || "eur",
      status: data.status,
      created: now(),
    },
  ]);

const attachPaymentIntentToOrder = (orderId, paymentIntentId) =>
  query(
    `UPDATE orders
     SET stripe_payment_intent_id = ?,
         payment_provider = 'stripe',
         payment_status = 'requires_payment'
     WHERE id = ?`,
    [paymentIntentId, orderId],
  );

const findPaymentByIntent = (paymentIntentId) =>
  query("SELECT * FROM payments WHERE stripe_payment_intent_id = ? LIMIT 1", [
    paymentIntentId,
  ]);

const getPaidOrderForRefund = (orderId, shopId) =>
  query(
    `SELECT orders.*, payments.stripe_payment_intent_id, payments.status AS payment_record_status
     FROM orders
     JOIN payments ON payments.order_id = orders.id
     WHERE orders.id = ?
       AND orders.shopid = ?
       AND orders.payment_status = 'paid'
     LIMIT 1`,
    [orderId, shopId],
  );

const markPaymentSucceeded = (paymentIntent, charge = null) =>
  new Promise((resolve, reject) => {
    const paymentIntentId = paymentIntent.id;
    const paymentMethod = resolveStripePaymentMethod({ paymentIntent, charge });

    conn.beginTransaction(async (transactionError) => {
      if (transactionError) {
        return reject(new Error(transactionError.message));
      }

      try {
        const paymentRows = await findPaymentByIntent(paymentIntentId);
        if (!paymentRows.length) {
          throw new Error("Paiement introuvable");
        }

        const payment = paymentRows[0];
        const orderRows = await query("SELECT * FROM orders WHERE id = ? LIMIT 1", [
          payment.order_id,
        ]);
        if (!orderRows.length) {
          throw new Error("Commande introuvable");
        }

        if (orderRows[0].payment_status === "paid") {
          return conn.commit((commitError) => {
            if (commitError) {
              return conn.rollback(() => reject(new Error(commitError.message)));
            }
            resolve({ alreadyPaid: true });
          });
        }

        await query(
          `UPDATE payments
           SET status = 'succeeded',
               stripe_charge_id = ?,
               payment_method = ?,
               updated = ?
           WHERE stripe_payment_intent_id = ?`,
          [
            paymentIntent.latest_charge || null,
            paymentMethod,
            now(),
            paymentIntentId,
          ],
        );

        await query(
          `UPDATE orders
           SET status = 1,
               payment_status = 'paid',
               payment = ?,
               finished = ?
           WHERE id = ?`,
          [paymentMethod, now(), payment.order_id],
        );

        const details = await query(
          "SELECT * FROM orderdetail WHERE orderid = ?",
          [payment.order_id],
        );

        for (const detail of details) {
          await query("UPDATE products SET stock = stock - ? WHERE id = ?", [
            detail.qty,
            detail.productid,
          ]);
          await query("INSERT INTO stocks SET ?", [
            {
              productid: detail.productid,
              category: "1",
              qty: detail.qty,
              operator: orderRows[0].customerID,
              remark: "Paiement Stripe",
              created: now(),
              updated: now(),
            },
          ]);
        }

        conn.commit((commitError) => {
          if (commitError) {
            return conn.rollback(() => reject(new Error(commitError.message)));
          }
          resolve({ paid: true });
        });
      } catch (error) {
        conn.rollback(() => reject(error));
      }
    });
  });

const markPaymentFailed = (paymentIntentId) =>
  query(
    `UPDATE payments
     SET status = 'failed',
         updated = ?
     WHERE stripe_payment_intent_id = ?`,
    [now(), paymentIntentId],
  ).then(() =>
    query(
      `UPDATE orders
       SET payment_status = 'failed',
           status = 0
       WHERE stripe_payment_intent_id = ?`,
      [paymentIntentId],
    ),
  );

const markPaymentRefunded = (orderId, refundId) =>
  query(
    `UPDATE payments
     SET status = 'refunded',
         refunded_at = ?,
         updated = ?,
         stripe_charge_id = COALESCE(stripe_charge_id, ?)
     WHERE order_id = ?`,
    [now(), now(), refundId, orderId],
  ).then(() =>
    query(
      `UPDATE orders
       SET payment_status = 'refunded',
           status = 4
       WHERE id = ?`,
      [orderId],
    ),
  );

module.exports = {
  attachPaymentIntentToOrder,
  createPaymentRecord,
  createPendingStripeOrder,
  getPaidOrderForRefund,
  markPaymentFailed,
  markPaymentRefunded,
  markPaymentSucceeded,
};
