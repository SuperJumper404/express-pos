const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCashClosures } = require('../src/modules/m_cashClosures');

function fixture() {
  let state = { payments: [{ id: 81, amount_cents: 1250, confirmed_at: '2026-11-10 12:00:00', cash_closure_id: null }], closures: [] };
  const connection = { query: async (sql, args = []) => {
    if (/MAX\(closure_number\)/.test(sql)) return [[{ next_number: state.closures.length + 1 }]];
    if (/SELECT cash_closures/.test(sql)) return [[...state.closures].reverse().slice(0, 1)];
    if (/FROM stripe_terminal_payments p WHERE/.test(sql)) return [state.payments.filter(row => row.cash_closure_id === null && row.confirmed_at <= args[1])];
    if (/INSERT INTO cash_closures/.test(sql)) {
      const [shopid, closure_number, opened_at, closed_at, closed_by_user_id, orders_count, total_revenue,
        payments_summary, vat_summary, courier_cash, standalone_terminal_summary, reconciliation] = args;
      const id = state.closures.length + 1;
      state.closures.push({ id, shopid, closure_number, opened_at, closed_at, closed_by_user_id, orders_count,
        total_revenue, payments_summary, vat_summary, courier_cash, standalone_terminal_summary, reconciliation });
      return [{ insertId: id }];
    }
    if (/UPDATE stripe_terminal_payments SET cash_closure_id/.test(sql)) {
      let affectedRows = 0;
      for (const row of state.payments) if (args[2].includes(row.id) && row.cash_closure_id === null) {
        row.cash_closure_id = args[0]; affectedRows++;
      }
      return [{ affectedRows }];
    }
    if (/SELECT \* FROM cash_closures/.test(sql)) return [state.closures.filter(row => row.id === args[0])];
    return [[]];
  } };
  const service = buildCashClosures({ clock: () => '2026-11-10 13:00:00.000000',
    runInTransaction: async work => {
      const before = JSON.stringify(state);
      try { return await work(connection); } catch (error) { state = JSON.parse(before); throw error; }
    } });
  return { service, state: () => state };
}

test('preview is read-only and autonomous-only Z claims receipts once and persists declarations', async () => {
  const f = fixture();
  const current = await f.service.mGetCurrentCashClosure(7);
  assert.equal(current.orders_count, 0);
  assert.equal(current.total_revenue, 12.5);
  assert.equal(current.last_closure_id, null);
  assert.equal(f.state().payments[0].cash_closure_id, null);
  const closed = await f.service.mCloseCurrentCashClosure({ shopId: 7, userId: 10, expectedLastClosureId: null,
    declaration: { declared_cash_cents: 0, declared_card_cents: 1300 } });
  assert.equal(closed.standalone_terminal_summary.count, 1);
  assert.equal(closed.reconciliation.declared_cash_cents, 0);
  assert.equal(closed.reconciliation.declared_card_cents, 1300);
  assert.equal(closed.reconciliation.card_difference_cents, 50);
  assert.equal(f.state().payments[0].cash_closure_id, closed.id);
  const after = await f.service.mGetCurrentCashClosure(7);
  assert.equal(after.total_revenue, 0);
  assert.equal(after.standalone_terminal_summary.count, 0);
  await assert.rejects(() => f.service.mCloseCurrentCashClosure({ shopId: 7, userId: 10 }), error => error.statusCode === 400);
  assert.equal(f.state().closures.length, 1);
});

test('late confirmations remain reportable and stale double submissions cannot close the next period', async () => {
  const f = fixture();
  await f.service.mCloseCurrentCashClosure({ shopId: 7, userId: 10 });
  f.state().payments.push({ id: 82, amount_cents: 2000, confirmed_at: '2026-11-10 12:30:00', cash_closure_id: null });
  const current = await f.service.mGetCurrentCashClosure(7);
  assert.equal(current.total_revenue, 20);
  await assert.rejects(() => f.service.mCloseCurrentCashClosure({ shopId: 7, userId: 10, expectedLastClosureId: null }), error => error.statusCode === 409);
  assert.equal(f.state().payments[1].cash_closure_id, null);
  const second = await f.service.mCloseCurrentCashClosure({ shopId: 7, userId: 10, expectedLastClosureId: 1 });
  assert.equal(second.total_revenue, 20);
  assert.equal(f.state().closures[0].total_revenue, 12.5);
});
