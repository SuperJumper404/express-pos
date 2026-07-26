# Payment Stability Design

## Objective

Stabilize the existing Stripe Connect and cash-register payment flows without
changing the product experience or replacing the current architecture.

The work addresses four confirmed weaknesses:

- an expired local stock reservation can be released while its Stripe
  PaymentIntent remains payable;
- `payment_intent.payment_failed` is treated as terminal even though the same
  PaymentIntent can normally be retried;
- refunds are created without an idempotency key and are marked as completed
  locally without webhook reconciliation;
- a cash-register batch can partially fail while the frontend still navigates
  away without a clear aggregate result.

## Scope

### Stripe payment attempts

`payment_intent.payment_failed` represents a failed attempt, not a canceled
order. The local payment record returns to `requires_payment_method`, the order
stays `requires_payment`, and its stock reservation remains active until it
expires or Stripe confirms a terminal outcome.

`payment_intent.processing` is persisted as a pending state. It never commits
or releases stock. A later `succeeded`, `payment_failed`, or `canceled` event
continues the lifecycle.

### Reservation expiry

The generic reservation release function must no longer release an expired
reservation belonging to an active Stripe order.

A dedicated Stripe expiry coordinator will:

1. find expired reservations for orders still awaiting Stripe payment;
2. retrieve the corresponding PaymentIntent;
3. if Stripe reports `succeeded`, settle the payment normally;
4. if Stripe reports `processing`, leave the reservation and order pending;
5. otherwise cancel the PaymentIntent when it is cancelable;
6. release stock only after Stripe is confirmed canceled;
7. leave the order untouched and report the error if Stripe cannot be reached.

This preserves the invariant:

> Stock is never released while the associated Stripe PaymentIntent can still
> succeed.

The existing one-minute maintenance timer invokes the coordinator. Checkout
transactions may still release expired non-Stripe or already-terminal
reservations, but they must not make network calls to Stripe.

### Refunds

Refund creation uses a deterministic idempotency key based on shop and order.
The refund includes order and shop metadata.

The local payment record stores the refund identifier and a refund lifecycle
status. The initial Stripe API response can produce `pending`, `succeeded`, or
`failed`; the order is considered fully refunded only after Stripe reports a
successful refund.

The webhook handles:

- `refund.created`;
- `refund.updated`;
- `refund.failed`.

Webhook processing is idempotent and scoped by the Stripe refund or
PaymentIntent already associated with the order. A failed refund restores the
local payment/order view to its paid state and records the failure for an
operator to inspect.

The existing Connect behavior remains unchanged:

- `reverse_transfer: true`;
- `refund_application_fee: true`.

Only full-order refunds remain supported.

### Cash-register batches

The frontend waits for every selected archive request and separates successful
and failed order IDs. It navigates away only when all requests succeed.

On partial failure, it keeps the user on the page, refreshes the remaining
orders, and displays a message identifying how many archives failed. Orders
already archived are not retried blindly.

Network errors use a safe fallback message instead of directly dereferencing
`error.response.data`.

## Data and migration

Prefer reusing existing payment fields when they can express the lifecycle
without ambiguity. If the current schema cannot distinguish a requested,
pending, successful, and failed refund, add narrowly scoped nullable payment
columns through one backward-compatible migration.

The migration must be idempotent under the repository's existing migration
runner and must not rewrite historical orders.

## Error handling and observability

- Stripe API failures during expiry do not release stock.
- Webhook handlers return a non-2xx response only when retrying the event is
  useful.
- Maintenance logs include the order ID, PaymentIntent ID, Stripe status and
  chosen action without logging secrets or client secrets.
- State transitions remain transactional and row-locked.
- No Stripe network call is performed while a database transaction is holding
  reservation or product locks.

## Compatibility

- Existing paid orders and archives remain readable.
- Existing QR checkout payloads and API response shapes remain compatible.
- Stripe Connect destination charges and platform commission are unchanged.
- Pay-at-counter behavior is unchanged.
- Order editing continues to replace PaymentIntents through its current
  idempotent mechanism.

## Testing

Regression tests must prove:

- a failed payment attempt can later succeed on the same PaymentIntent;
- a failed attempt does not release stock;
- generic expiry does not release an active Stripe reservation;
- the expiry coordinator cancels Stripe before releasing stock;
- a late Stripe success is settled instead of producing an unpaid charged
  order;
- a processing payment remains pending;
- refund retries reuse the same Stripe idempotency key;
- pending and failed refunds are reconciled through webhooks;
- cash-register partial failures remain visible and do not trigger navigation.

Run the focused payment and checkout contracts first, then the complete backend
and frontend test/lint/build commands required by each repository.

## Non-goals

- no global payment-state-machine rewrite;
- no new payment provider;
- no partial refunds;
- no visual redesign;
- no change to commission policy;
- no general refactor of legacy order modules.
