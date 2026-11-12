const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PNG } = require('pngjs');
const { buildWalletPayload } = require('../src/services/loyaltyWallet');
let renderWalletProgress;
try { ({ renderWalletProgress } = require('../src/services/loyaltyWalletProgress')); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

const dessert = { id: 'dessert', name: 'Dessert offert', points: 30 };
const menu = { id: 'menu', name: 'Menu offert', points: 80 };
const input = { shopId: 7, shopName: 'Le Bistrot', offersUrl: 'https://example.test/offres',
  member: { id: 'member', balance: 20, qr: 'a'.repeat(64) },
  program: { enabled: true, name: 'Club', rewards: [menu, dessert] } };

test('Apple progress follows available points toward the next active reward without changing redemption data', () => {
  const cases = [
    [0, 0, 0, 30, 0, 'Dessert offert'],
    [20, 0, 20, 30, 2 / 3, 'Dessert offert'],
    [35, 10, 25, 30, 5 / 6, 'Dessert offert'],
    [30, 0, 30, 80, 0.375, 'Menu offert'],
    [35, 0, 35, 80, 0.4375, 'Menu offert'],
    [90, 0, 80, 80, 1, 'Menu offert'],
  ];
  for (const [balance, reserved, value, max, ratio, rewardName] of cases) {
    const payload = buildWalletPayload({ ...input, member: { ...input.member, balance, reserved } });
    assert.deepEqual(payload.appleProgress, { value, max, ratio, rewardName });
    assert.equal(payload.balance, balance);
    assert.equal(payload.available, balance - reserved);
  }
  const payload = buildWalletPayload({ ...input, member: { ...input.member, balance: 35 } });
  assert.match(payload.offer, /Dessert offert/, 'the already redeemable offer remains available to other consumers');
  assert.equal(payload.hasAvailableReward, true);
  assert.equal(buildWalletPayload(input).hasAvailableReward, false);
  assert.match(payload.next, /Menu offert/);
  assert.deepEqual(input.program.rewards, [menu, dessert], 'do not reorder the programme');
});

test('expired, empty and invalid reward thresholds never create misleading Apple progress', () => {
  const expired = { ...dessert, expiresAt: '2000-01-01T00:00:00Z' };
  for (const rewards of [[], [expired], [{ ...dessert, points: 0 }], [{ ...dessert, points: 1.5 }], [{ ...dessert, points: Infinity }]]) {
    assert.equal(buildWalletPayload({ ...input, program: { ...input.program, rewards } }).appleProgress, null);
  }
  assert.deepEqual(buildWalletPayload({ ...input, program: { ...input.program, rewards: [expired, menu] } }).appleProgress,
    { value: 20, max: 80, ratio: 0.25, rewardName: 'Menu offert' });
});

function png(width, height, rgba, colorType = 6) {
  const data = Buffer.alloc(width * height * 4);
  for (let index = 0; index < data.length; index += 4) data.set(rgba, index);
  return PNG.sync.write({ width, height, data }, { colorType, inputColorType: 6 });
}
const pixel = (image, x, y) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];

test('the signed strip preserves restaurant pixels and source files at all three scales', () => {
  assert.equal(typeof renderWalletProgress, 'function');
  const images = {};
  for (const scale of [1, 2, 3]) images[`strip${scale === 1 ? '' : `@${scale}x`}.png`] = png(375 * scale, 144 * scale, [180, 30 * scale, 40, 128]);
  const originals = Object.fromEntries(Object.entries(images).map(([name, bytes]) => [name, Buffer.from(bytes)]));
  const result = renderWalletProgress({ images, progress: { ratio: 0.5 }, backgroundColor: '#123456' });
  for (const scale of [1, 2, 3]) {
    const name = `strip${scale === 1 ? '' : `@${scale}x`}.png`;
    const image = PNG.sync.read(result[name]);
    assert.equal(image.width, 375 * scale); assert.equal(image.height, 144 * scale);
    assert.deepEqual(pixel(image, 100 * scale, 80 * scale), [180, 30 * scale, 40, 128]);
    assert.deepEqual(pixel(image, 32 * scale, 129 * scale), [255, 255, 255, 255]);
    assert.notDeepEqual(pixel(image, 340 * scale, 129 * scale), [255, 255, 255, 255]);
    assert.deepEqual(images[name], originals[name]);
  }
});

test('empty, partial and completed bars represent their actual proportions over a configured fallback background', () => {
  assert.equal(typeof renderWalletProgress, 'function');
  for (const [ratio, leftFilled, rightFilled] of [[0, false, false], [0.5, true, false], [1, true, true]]) {
    const result = renderWalletProgress({ images: {}, progress: { ratio }, backgroundColor: '#123456' });
    const image = PNG.sync.read(result['strip.png']);
    assert.deepEqual(pixel(image, 0, 0), [18, 52, 86, 255]);
    assert.equal(pixel(image, 32, 129).every(value => value === 255), leftFilled);
    assert.equal(pixel(image, 340, 129).every(value => value === 255), rightFilled);
  }
  assert.deepEqual(renderWalletProgress({ images: {}, progress: null, backgroundColor: '#123456' }), {});
});

test('RGB artwork is supported while corrupt, oversized and invalid progress inputs are rejected before composition', () => {
  assert.equal(typeof renderWalletProgress, 'function');
  const source = png(375, 144, [10, 20, 30, 255], 2);
  const good = renderWalletProgress({ images: { 'strip.png': source }, progress: { ratio: 1 }, backgroundColor: '#123456' });
  assert.deepEqual(pixel(PNG.sync.read(good['strip@3x.png']), 0, 0), [10, 20, 30, 255]);
  const corrupt = Buffer.from(source); corrupt[corrupt.length - 1] ^= 1;
  for (const bytes of [corrupt, png(1126, 432, [1, 2, 3, 255]), Buffer.from('not PNG')]) {
    assert.throws(() => renderWalletProgress({ images: { 'strip.png': bytes }, progress: { ratio: 0.5 }, backgroundColor: '#123456' }));
  }
  for (const ratio of [NaN, Infinity, -0.1, 1.1]) {
    assert.throws(() => renderWalletProgress({ images: {}, progress: { ratio }, backgroundColor: '#123456' }));
  }
});

test('the filled bar remains distinguishable on white or transparent artwork over a white card', () => {
  for (const color of [[255, 255, 255, 255], [255, 255, 255, 0]]) {
    const images = renderWalletProgress({ images: { 'strip.png': png(375, 144, color) }, progress: { ratio: 0.5 }, backgroundColor: '#FFFFFF' });
    const image = PNG.sync.read(images['strip.png']);
    assert.deepEqual(pixel(image, 32, 129), [255, 255, 255, 255]);
    const rail = pixel(image, 340, 129); const alpha = rail[3] / 255;
    // White against sRGB 148 or darker is at least 3:1, including alpha over the brightest background.
    assert(rail.slice(0, 3).every(channel => channel * alpha + 255 * (1 - alpha) <= 148));
  }
});
