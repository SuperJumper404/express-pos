# Standalone Terminal backend implementation

The approved API contract is unchanged. Payment history rows additionally expose
`taken_by_name` (cashier name) and `readerLabel`, using same-shop joins. The nested
standalone payment DTO remains separate from the strict order-payment DTO.

Standalone payments use the existing payment table, Connect fee calculation,
reader reservation and named creation/action locks. The stable Stripe key is
scoped to shop, cashier and standalone type. Retrying a completed or canceled
attempt returns that attempt; changing its amount is rejected. Creating attempts
resume only through POST with their original attemptKey. GET reconciles known
Stripe intents. Order/kiosk recovery cannot cancel standalone attempts, and the
stale-creating cleanup explicitly excludes them. An unknown Stripe creation older
than the safe 23-hour replay window stays reserved and requires verification.

The standalone finalizer locks and updates only its payment, preserves the first
confirmation date and stores the existing safe card receipt. It never loads or
updates allocations, orders, archives, loyalty or stock. Existing financial order
finalization keeps its lock sequence and strict allocation requirements.

History paginates and searches the SQL union before hydrating page details.
Historical order projections and delivery financial decoration are preserved.
Attachment operations use a separate table, snapshot server-owned reference and
amount, require confirmed standalone payments and history permission, and never
compare attachment totals to the payment. Hidden/deleted archives retain their
snapshot with available=false. Repeating add/remove is idempotent; the same archive
can be attached to different payments.

Verification includes the new standalone payment regression script, 13 history
tests, existing Terminal order/kiosk/webhook/locking/refund tests and npm test.
All transactions in tests use controlled database/Stripe boundaries. The SQL
migration is prepared but has not been applied to a real database, and no real
Stripe transaction was performed. The migration must precede application use of
the new columns and attachment table.
