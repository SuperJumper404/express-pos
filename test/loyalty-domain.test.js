const assert = require('assert');
const { normalizeProgram, earnedPoints, rewardDiscount, refundRestitution, allocateDiscount } = require('../src/helpers/loyalty');
const program = normalizeProgram({ enabled: true, name: 'Fidélité', pointsPerEuro: 2.5, rewards: [
  { id: 'coffee', name: 'Café', type: 'fixed', points: 30, value: 250 },
] });
assert.strictEqual(earnedPoints({ program, paidCents: 1099 }), 27);
assert.strictEqual(earnedPoints({ program, paidCents: 1099, tipCents: 100, excludedCents: 200 }), 19);
assert.strictEqual(earnedPoints({ program: { ...program, rounding: 'nearest' }, paidCents: 1100 }), 28);
assert.strictEqual(earnedPoints({ program: { ...program, enabled: false }, paidCents: 1000 }), 0);
assert.strictEqual(rewardDiscount({ reward: program.rewards[0], subtotalCents: 100 }), 100);
assert.strictEqual(rewardDiscount({ reward: { type: 'percent', value: 15 }, subtotalCents: 1099 }), 164);
assert.strictEqual(rewardDiscount({ reward: { type: 'product', productId: 8 }, subtotalCents: 900, lines: [
  { productId: 8, unitCents: 250, quantity: 2 }, { productId: 9, unitCents: 400, quantity: 1 },
] }), 250);
assert.strictEqual(refundRestitution({ pointsCost: 31, paidCents: 1000, refundedCents: 333, restoredPoints: 0 }), 10);
assert.strictEqual(refundRestitution({ pointsCost: 31, paidCents: 1000, refundedCents: 1000, restoredPoints: 10 }), 21);
assert.throws(() => normalizeProgram({ pointsPerEuro: -1 }), /Invalid/);
assert.throws(() => normalizeProgram({ rewards: [{ id: 'bad', type: 'percent', name: 'Bad', points: 1, value: 101 }] }), /Invalid/);
assert.throws(() => normalizeProgram({ rewards: [{ id: 'a', name: 'A', type: 'fixed', points: 1, value: 100 }, { id: 'a', name: 'B', type: 'fixed', points: 2, value: 100 }] }), /Invalid/);
assert.throws(() => earnedPoints({ program, paidCents: Number.MAX_SAFE_INTEGER }), /Invalid/);
const allocated = allocateDiscount([{ id: 1, total: 0.01, qty: 1, vat_rate: 10 }, { id: 2, total: 0.01, qty: 1, vat_rate: 10 }, { id: 3, total: 0.01, qty: 1, vat_rate: 10 }], 2);
assert.strictEqual(allocated.reduce((sum, row) => sum + Math.round(row.total * 100), 0), 1);
assert(allocated.every(row => row.total >= 0 && Math.round((row.total_ht + row.total_vat) * 100) === Math.round(row.total * 100)));
console.log('loyalty domain tests passed');
