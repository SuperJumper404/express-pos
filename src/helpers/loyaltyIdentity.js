const { randomInt } = require('crypto');
const { normalizeCustomerDestination } = require('./customerIdentity');
const { invalid } = require('./loyalty');

const generateCardNumber = () => Array.from({ length: 16 }, () => randomInt(10)).join('');
const normalizeLoyaltyLookup = (input = {}) => {
  if (input.qr !== undefined) {
    if (input.kind !== undefined || input.value !== undefined || input.countryCode !== undefined) throw invalid();
    input = { kind: 'qr', value: input.qr };
  }
  const { kind, value, countryCode = 'FR' } = input;
  if (typeof value !== 'string' || value.length > 100 || /[\x00-\x1f\x7f]/.test(value)) throw invalid();
  if (kind === 'phone') return { kind, value: normalizeCustomerDestination({ channel: 'sms', value, countryCode }) };
  const normalized = kind === 'card' ? value.replace(/[ -]/g, '') : value.trim();
  if (!(kind === 'card' && /^\d{16}$/.test(normalized)) && !(kind === 'qr' && /^[a-f0-9]{64}$/.test(normalized))) throw invalid();
  return { kind, value: normalized };
};
module.exports = { generateCardNumber, normalizeLoyaltyLookup };
