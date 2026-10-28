const DomainError = require('./domainError');
const invalid = () => new DomainError(422, 'LOYALTY_INVALID', 'Invalid loyalty request');
const integer = (value, min = 0, max = 1000000000) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid();
  return value;
};
const string = (value, max = 120) => {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw invalid();
  return value.trim();
};
const httpsUrl = value => {
  if (!value) return '';
  const input = string(value, 2000);
  let url;
  try { url = new URL(input); } catch (_) { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password) throw invalid();
  return input;
};
const normalizeProgram = (input = {}) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const enabled = input.enabled === undefined ? false : input.enabled;
  const pointsPerEuro = input.pointsPerEuro === undefined ? 1 : input.pointsPerEuro;
  const rounding = input.rounding || 'floor';
  const includeTips = input.includeTips === undefined ? false : input.includeTips;
  if (typeof enabled !== 'boolean' || typeof includeTips !== 'boolean' || !Number.isFinite(pointsPerEuro)
    || pointsPerEuro < 0 || pointsPerEuro > 10000 || Math.round(pointsPerEuro * 1000) / 1000 !== pointsPerEuro
    || !['floor', 'nearest', 'ceil'].includes(rounding)) throw invalid();
  const excludedProductIds = input.excludedProductIds || [];
  if (!Array.isArray(excludedProductIds) || excludedProductIds.length > 500) throw invalid();
  excludedProductIds.forEach(id => integer(id, 1, 2147483647));
  const rewards = input.rewards || [];
  if (!Array.isArray(rewards) || rewards.length > 100) throw invalid();
  const normalized = rewards.map(reward => {
    if (!reward || typeof reward !== 'object' || !['product', 'fixed', 'percent'].includes(reward.type)) throw invalid();
    const id = string(reward.id, 64);
    const name = string(reward.name);
    if (!/^[A-Za-z0-9_-]+$/.test(id) || !name) throw invalid();
    const points = integer(reward.points, 1);
    const value = reward.type === 'product' ? 0 : integer(reward.value, 1, reward.type === 'percent' ? 100 : 1000000000);
    const productId = reward.type === 'product' ? integer(reward.productId, 1, 2147483647) : null;
    const expiresAt = reward.expiresAt || null;
    if (expiresAt && (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)))) throw invalid();
    const stackable = reward.stackable === undefined ? false : reward.stackable;
    if (typeof stackable !== 'boolean') throw invalid();
    return { id, name, type: reward.type, points, value, productId, expiresAt, stackable,
      minPaidCents: integer(reward.minPaidCents || 0), conditions: string(reward.conditions || '', 1000) };
  });
  if (new Set(normalized.map(row => row.id)).size !== normalized.length) throw invalid();
  const name = string(input.name === undefined ? 'Fidélité' : input.name);
  if (!name) throw invalid();
  const color = (value, fallback) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(value)) throw invalid();
    return value;
  };
  return { enabled, name, pointsPerEuro, rounding, includeTips, excludedProductIds: [...new Set(excludedProductIds)],
    rewards: normalized, logoUrl: httpsUrl(input.logoUrl), backgroundColor: color(input.backgroundColor, '#1B5E20'),
    foregroundColor: color(input.foregroundColor, '#FFFFFF') };
};
const earnedPoints = ({ program, paidCents, tipCents = 0, excludedCents = 0 }) => {
  integer(paidCents); integer(tipCents); integer(excludedCents);
  if (!program.enabled) return 0;
  const eligible = Math.max(0, paidCents - excludedCents - (program.includeTips ? 0 : tipCents));
  // Thousandths of a point/euro avoid binary floating point around integer boundaries.
  const numerator = eligible * Math.round(program.pointsPerEuro * 1000);
  if (!Number.isSafeInteger(numerator)) throw invalid();
  const points = numerator / 100000;
  return integer(({ floor: Math.floor, nearest: Math.round, ceil: Math.ceil })[program.rounding](points));
};
const rewardDiscount = ({ reward, subtotalCents, lines = [] }) => {
  integer(subtotalCents);
  if (reward.type === 'fixed') return Math.min(subtotalCents, integer(reward.value));
  if (reward.type === 'percent') return Math.floor(subtotalCents * integer(reward.value, 1, 100) / 100);
  if (reward.type === 'product') {
    const match = lines.filter(line => String(line.productId) === String(reward.productId) && line.quantity > 0);
    return Math.min(subtotalCents, match.length ? Math.min(...match.map(line => integer(line.unitCents))) : 0);
  }
  throw invalid();
};
const refundRestitution = ({ pointsCost, paidCents, refundedCents, restoredPoints }) => {
  [pointsCost, paidCents, refundedCents, restoredPoints].forEach(value => integer(value));
  if (refundedCents > paidCents || restoredPoints > pointsCost) throw invalid();
  const target = refundedCents >= paidCents ? pointsCost : Math.floor(pointsCost * refundedCents / paidCents);
  return Math.max(0, target - restoredPoints);
};
const allocateDiscount = (lines, discountCents) => {
  integer(discountCents);
  const cents = lines.map(line => integer(Math.round(Number(line.total) * 100)));
  const gross = cents.reduce((sum, value) => sum + value, 0);
  integer(gross);
  if (discountCents > gross) throw invalid();
  let cumulative = 0n; let allocated = 0n;
  return lines.map((line, index) => {
    cumulative += BigInt(cents[index]);
    const target = gross ? (BigInt(discountCents) * cumulative + BigInt(Math.floor(gross / 2))) / BigInt(gross) : 0n;
    const net = cents[index] - Number(target - allocated); allocated = target;
    const quantity = integer(Number(line.qty), 1);
    const rate = require('./vat').normalizeVatRate(line.vat_rate);
    const ht = Math.round(net * 10000 / (10000 + Math.round(rate * 100)));
    return { ...line, total: net / 100, total_ht: ht / 100, total_vat: (net - ht) / 100,
      unit_price_ht: Number((ht / 100 / quantity).toFixed(2)), unit_vat: Number(((net - ht) / 100 / quantity).toFixed(2)) };
  });
};
module.exports = { normalizeProgram, earnedPoints, rewardDiscount, refundRestitution, allocateDiscount, integer, invalid };
