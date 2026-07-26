# Payment Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Stripe payment attempts, stock expiry, refunds, and cash-register batches converge safely without redesigning the POS.

**Architecture:** Keep the existing checkout and payment modules, but distinguish retryable Stripe states from terminal states. Add a dependency-injected maintenance coordinator that talks to Stripe before asking the transactional payment module to release or commit stock. Persist the refund lifecycle in dedicated payment columns and reconcile it through the existing signed webhook.

**Tech Stack:** Node.js, Express, Stripe Connect, MySQL/dbmate, Nuxt 2, Vue 2, Vuex, Node `assert` contract tests.

---

### Task 1: Keep Failed Attempts Retryable

**Files:**
- Modify: `test/stripe-payment.test.js`
- Modify: `src/modules/m_payments.js`
- Modify: `src/controllers/c_stripe.js`

- [ ] **Step 1: Write the failing payment-attempt contracts**

Extend the lifecycle harness assertions so a failed attempt keeps the reservation
and order open, then allows the same PaymentIntent to succeed:

```js
harness = makeStripeLifecycleHarness();
await harness.payments.markPaymentAttemptFailed({
  id: "pi_42",
  status: "requires_payment_method",
});
assert.strictEqual(harness.getState().products.get(10), 8);
assert.strictEqual(harness.getState().reservations[0].status, "reserved");
assert.strictEqual(harness.getState().orders[0].payment_status, "requires_payment");
assert.strictEqual(
  harness.getState().payments[0].status,
  "requires_payment_method",
);
await harness.payments.markPaymentSucceeded(succeededIntent);
assert.strictEqual(harness.getState().orders[0].payment_status, "paid");
assert.strictEqual(harness.getState().reservations[0].status, "committed");
```

Add a second assertion that `markPaymentProcessing("pi_42")` changes only the
payment record to `processing`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node test/stripe-payment.test.js
```

Expected: failure because `markPaymentAttemptFailed` and
`markPaymentProcessing` do not exist and the current failure path releases stock.

- [ ] **Step 3: Implement retryable status updates**

In `m_payments.js`, remove `"failed"` from `terminalPaymentStatuses`. Add a
transactional pending update that locks the payment/order, leaves the order and
reservation unchanged, and updates only the payment record:

```js
const markPaymentPending = (paymentIntentId, status) => runInTransaction(
  async (connection) => {
    const payment = await repository.findPaymentByIntent({
      paymentIntentId,
      connection,
    });
    if (!payment) return { missing: true };
    const order = await repository.lockOrder({
      orderId: payment.order_id,
      shopId: payment.shop_id,
      connection,
    });
    if (!order || order.payment_status !== "requires_payment") {
      return { ignored: true };
    }
    await repository.updatePaymentPending({
      paymentIntentId,
      status,
      timestamp: timestamp(),
      connection,
    });
    return { status };
  },
);

const markPaymentAttemptFailed = (paymentIntent) => (
  markPaymentPending(
    paymentIntent.id,
    paymentIntent.status || "requires_payment_method",
  )
);

const markPaymentProcessing = (paymentIntentId) => (
  markPaymentPending(paymentIntentId, "processing")
);
```

The repository update is:

```sql
UPDATE payments
SET status = ?, updated = ?
WHERE stripe_payment_intent_id = ?
  AND status NOT IN ('succeeded', 'canceled', 'refunded')
```

Change the webhook mappings to pass the full failed PaymentIntent and handle
`payment_intent.processing`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run `node test/stripe-payment.test.js`.

Expected: all Stripe payment contracts pass.

- [ ] **Step 5: Commit the isolated lifecycle correction**

```powershell
git add test/stripe-payment.test.js src/modules/m_payments.js src/controllers/c_stripe.js
git commit -m "fix: keep failed Stripe attempts retryable"
```

### Task 2: Cancel Stripe Before Expiring Stock

**Files:**
- Create: `src/services/stripePaymentMaintenance.js`
- Modify: `test/checkout-contract.test.js`
- Modify: `test/stripe-payment.test.js`
- Modify: `src/modules/m_checkout.js`
- Modify: `src/modules/m_payments.js`
- Modify: `index.js`

- [ ] **Step 1: Write the failing generic-expiry contract**

Update the checkout repository harness to expose `payment_provider` and
`payment_status`. Assert that generic expiry skips an active Stripe reservation:

```js
const expiredStripe = makeCheckoutHarness({
  expiredReservation: {
    id: 1,
    order_id: 42,
    product_id: 10,
    quantity: 2,
    status: "reserved",
    payment_provider: "stripe",
    payment_status: "requires_payment",
  },
});
assert.strictEqual(
  await expiredStripe.checkout.releaseExpiredReservations(),
  0,
);
assert.strictEqual(expiredStripe.state.reservations[0].status, "reserved");
```

- [ ] **Step 2: Verify the generic-expiry test fails**

Run `node test/checkout-contract.test.js`.

Expected: the existing release function returns `1` and releases the Stripe
reservation.

- [ ] **Step 3: Exclude active Stripe orders from generic expiry**

Change `lockExpiredReservations` to join `orders` and exclude only the active
Stripe lifecycle:

```sql
SELECT reservations.id,
       reservations.order_id,
       reservations.product_id,
       reservations.quantity,
       reservations.status,
       reservations.expires_at
FROM order_stock_reservations AS reservations
JOIN orders ON orders.id = reservations.order_id
WHERE reservations.status = 'reserved'
  AND reservations.expires_at IS NOT NULL
  AND reservations.expires_at <= ?
  AND NOT (
    orders.payment_provider = 'stripe'
    AND orders.payment_status = 'requires_payment'
  )
ORDER BY reservations.product_id, reservations.id
FOR UPDATE
```

Update the in-memory checkout harness with the same predicate.

- [ ] **Step 4: Verify the generic-expiry test passes**

Run `node test/checkout-contract.test.js`.

- [ ] **Step 5: Write failing maintenance coordinator contracts**

Create dependency-injected tests in `test/stripe-payment.test.js` for:

```js
const maintenance = buildStripePaymentMaintenance({
  findExpiredStripePayments: async () => [expiredPayment],
  getStripe: () => fakeStripe,
  markPaymentSucceeded,
  markPaymentCanceled,
  releaseExpiredReservations,
  logger: silentLogger,
});
```

Assert:

- `requires_payment_method` is canceled through Stripe before
  `markPaymentCanceled`;
- `succeeded` calls `markPaymentSucceeded` without cancellation;
- `processing` calls neither terminal transition;
- a Stripe retrieval/cancellation error releases no stock;
- generic non-Stripe expiry still runs after the Stripe scan.

- [ ] **Step 6: Verify the coordinator tests fail**

Run `node test/stripe-payment.test.js`.

Expected: module `stripePaymentMaintenance` is missing.

- [ ] **Step 7: Implement the maintenance coordinator**

Expose this read from `m_payments.js`:

```sql
SELECT DISTINCT orders.id AS order_id,
       orders.shopid AS shop_id,
       payments.stripe_payment_intent_id
FROM orders
JOIN payments ON payments.order_id = orders.id
JOIN order_stock_reservations AS reservations
  ON reservations.order_id = orders.id
WHERE orders.payment_provider = 'stripe'
  AND orders.payment_status = 'requires_payment'
  AND reservations.status = 'reserved'
  AND reservations.expires_at IS NOT NULL
  AND reservations.expires_at <= ?
ORDER BY orders.id
```

Implement `buildStripePaymentMaintenance()` with a sequential loop:

```js
if (intent.status === "succeeded") {
  const charge = intent.latest_charge
    ? await stripe.charges.retrieve(intent.latest_charge)
    : null;
  await markPaymentSucceeded(intent, charge);
} else if (intent.status === "processing") {
  logger.info("Expired Stripe reservation remains processing", context);
} else {
  const canceled = intent.status === "canceled"
    ? intent
    : await stripe.paymentIntents.cancel(intent.id);
  if (canceled.status !== "canceled") {
    throw new Error("Stripe PaymentIntent cancellation was not confirmed");
  }
  await markPaymentCanceled(intent.id);
}
```

Catch errors per order, log identifiers and status only, continue to the next
order, then invoke `releaseExpiredReservations()`.

- [ ] **Step 8: Wire the timer to the coordinator**

Replace the direct timer call in `index.js` with
`runStripePaymentMaintenance()`. Export a production instance from the service
using the existing Stripe client getter and payment module functions.

- [ ] **Step 9: Verify both focused suites**

Run:

```powershell
node test/checkout-contract.test.js
node test/stripe-payment.test.js
```

Expected: both exit successfully.

- [ ] **Step 10: Commit the expiry invariant**

```powershell
git add test/checkout-contract.test.js test/stripe-payment.test.js src/modules/m_checkout.js src/modules/m_payments.js src/services/stripePaymentMaintenance.js index.js
git commit -m "fix: cancel Stripe before releasing expired stock"
```

### Task 3: Persist and Reconcile Refunds

**Files:**
- Create: `db/migrations/20260726190000_payment_refund_lifecycle.sql`
- Modify: `test/stripe-payment.test.js`
- Modify: `src/modules/m_payments.js`
- Modify: `src/controllers/c_stripe.js`

- [ ] **Step 1: Write failing refund contracts**

Add controller/module contracts proving:

```js
assert.deepStrictEqual(refundCreateOptions, {
  idempotencyKey: "refund-order-7-42",
});
assert.deepStrictEqual(refundParams.metadata, {
  order_id: "42",
  shop_id: "7",
});
```

Assert a `pending` refund stores its ID/status while the order remains `paid`;
a later `succeeded` event marks it `refunded`; a `failed` event leaves/restores
the order as `paid` and records `failure_reason`; replaying the same succeeded
event makes no additional transition.

- [ ] **Step 2: Verify refund contracts fail**

Run `node test/stripe-payment.test.js`.

Expected: missing refund lifecycle methods and missing Stripe request options.

- [ ] **Step 3: Add the backward-compatible migration**

Create:

```sql
-- migrate:up

ALTER TABLE `payments`
  ADD COLUMN `stripe_refund_id` varchar(191) DEFAULT NULL AFTER `payment_method`,
  ADD COLUMN `refund_status` varchar(32) DEFAULT NULL AFTER `stripe_refund_id`,
  ADD COLUMN `refund_failure_reason` varchar(191) DEFAULT NULL AFTER `refund_status`,
  ADD UNIQUE KEY `stripe_refund_id` (`stripe_refund_id`);

-- migrate:down

ALTER TABLE `payments`
  DROP INDEX `stripe_refund_id`,
  DROP COLUMN `refund_failure_reason`,
  DROP COLUMN `refund_status`,
  DROP COLUMN `stripe_refund_id`;
```

- [ ] **Step 4: Implement transactional refund reconciliation**

Replace the current misuse of `stripe_charge_id` for refund IDs. Add repository
queries to locate a payment by refund ID, PaymentIntent ID, or charge ID.

Expose:

```js
recordRefundState({
  orderId,
  shopId,
  refundId,
  refundStatus,
  failureReason,
})

reconcileStripeRefund(refund)
```

State mapping:

- `succeeded`: payment `status = 'refunded'`, set `refunded_at`, order
  `payment_status = 'refunded'` and canceled;
- `pending`: preserve payment `status = 'succeeded'`, set
  `refund_status = 'pending'`, order stays paid;
- `failed` or `canceled`: preserve/restore payment `status = 'succeeded'`, set
  failure details, order stays paid.

All updates lock both payment and order and are idempotent.

- [ ] **Step 5: Make refund creation idempotent**

Use:

```js
const refund = await getStripe().refunds.create(
  {
    payment_intent: order.stripe_payment_intent_id,
    reverse_transfer: true,
    refund_application_fee: true,
    metadata: {
      order_id: String(order.id),
      shop_id: String(order.shopid),
    },
  },
  { idempotencyKey: `refund-order-${order.shopid}-${order.id}` },
);
```

Persist the returned status. Return “remboursement demandé” for pending and
“commande remboursée” only for succeeded.

- [ ] **Step 6: Handle refund webhooks**

Route `refund.created`, `refund.updated`, and `refund.failed` to
`reconcileStripeRefund(event.data.object)` in the signed webhook.

- [ ] **Step 7: Verify migration and refund contracts**

Run:

```powershell
node test/stripe-payment.test.js
npm run db:up:local
```

Expected: payment tests pass and dbmate applies the migration once.

- [ ] **Step 8: Commit refund stabilization**

```powershell
git add db/migrations/20260726190000_payment_refund_lifecycle.sql test/stripe-payment.test.js src/modules/m_payments.js src/controllers/c_stripe.js
git commit -m "fix: reconcile Stripe refund lifecycle"
```

### Task 4: Surface Cash-register Partial Failures

**Files:**
- Modify: `helpers/cashRegister.js`
- Modify: `test/cash-register.test.js`
- Modify: `store/orders.js`
- Modify: `pages/cashregister/payout/_id.vue`

- [ ] **Step 1: Write the failing batch-summary contract**

Add:

```js
const { summarizeArchiveResults } = require("../helpers/cashRegister");

assert.deepStrictEqual(
  summarizeArchiveResults([1, 2, 3], [true, false, true]),
  {
    successfulOrderIds: [1, 3],
    failedOrderIds: [2],
    allSucceeded: false,
  },
);
```

- [ ] **Step 2: Verify the frontend test fails**

Run `node test/cash-register.test.js`.

Expected: `summarizeArchiveResults` is not defined.

- [ ] **Step 3: Implement the pure summary helper**

```js
const summarizeArchiveResults = (orderIds, results) => {
  const summary = orderIds.reduce(
    (accumulator, orderId, index) => {
      const key = results[index] ? "successfulOrderIds" : "failedOrderIds";
      accumulator[key].push(Number(orderId));
      return accumulator;
    },
    { successfulOrderIds: [], failedOrderIds: [] },
  );
  return {
    ...summary,
    allSucceeded: summary.failedOrderIds.length === 0,
  };
};
```

- [ ] **Step 4: Use safe Axios error messages**

In `store/orders.js`, normalize archive errors with:

```js
const message =
  error.response?.data?.message ||
  error.message ||
  "Impossible d'archiver la commande.";
dispatch("set/message", message);
dispatch("notifications/error", message, { root: true });
return false;
```

- [ ] **Step 5: Keep the cashier on partial failure**

In `btnYes()`:

- await all boolean archive results;
- refresh orders;
- if any failed, keep the dialog/page active, clear loading, and dispatch:

```js
this.$store.dispatch(
  "notifications/error",
  `${failedOrderIds.length} commande(s) n'ont pas pu être archivées.`,
);
```

- navigate to `/cashregister` only when `allSucceeded` is true;
- remove the unconditional navigation from `finally`.

- [ ] **Step 6: Verify frontend tests and lint**

Run:

```powershell
npm test
npm run lint
```

Expected: all frontend tests pass and ESLint exits successfully.

- [ ] **Step 7: Commit the frontend correction**

```powershell
git add helpers/cashRegister.js test/cash-register.test.js store/orders.js pages/cashregister/payout/_id.vue
git commit -m "fix: surface partial cash register failures"
```

### Task 5: Full Verification

**Files:**
- Modify only if a verification exposes a concrete defect.

- [ ] **Step 1: Run all backend tests**

Run `npm test` in `express-pos`.

Expected: every listed Node contract suite passes.

- [ ] **Step 2: Verify the migration state**

Run:

```powershell
npm run db:up:local
npm run db:up:local
```

Expected: the first run applies the refund migration if necessary and the
second reports no pending migration.

- [ ] **Step 3: Run all frontend checks**

Run in `pos-app`:

```powershell
npm test
npm run lint
npm run build-local
```

Expected: tests, ESLint and Nuxt build all exit with code 0.

- [ ] **Step 4: Review the final diff**

Run in both repositories:

```powershell
git diff --check
git status --short
git log -5 --oneline
```

Confirm only payment-stability files, the migration, tests and the
cash-register correction changed. Confirm no `.env` file is staged.

## Self-Review

- Spec coverage: retryable failure, processing, Stripe-first expiry, refund
  idempotency/webhooks and partial batch errors each have an isolated task.
- Placeholder scan: no TODO, TBD, “similar to”, or deferred implementation is
  present.
- Type consistency: payment module names and refund fields remain identical
  across tests, controllers, repositories and migration.
- Scope: commission policy, CORS, legacy order refactors and UI redesign remain
  outside this stabilization.
