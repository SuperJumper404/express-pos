const https = require('https');
const DomainError = require('../helpers/domainError');

const failure = () => new DomainError(503, 'CUSTOMER_CODE_UNAVAILABLE', 'SMS provider unavailable');
const development = config => config.mode === 'development' && ['local', 'development', 'test'].includes(config.nodeEnv);
const configured = config => development(config) || (config.mode === 'twilio' && /^AC[a-f0-9]{32}$/i.test(config.accountSid || '')
  && typeof config.authToken === 'string' && !!config.authToken && /^\+[1-9]\d{7,14}$/.test(config.from || ''));
const post = input => new Promise((resolve, reject) => {
  const req = https.request({ hostname: input.hostname, path: input.path, method: 'POST', headers: input.headers }, res => {
    let raw = '';
    res.on('data', chunk => { raw += chunk; if (raw.length > 65536) req.destroy(failure()); });
    res.on('error', () => reject(failure()));
    res.on('end', () => { try { resolve({ statusCode: res.statusCode, body: JSON.parse(raw) }); } catch (_) { reject(failure()); } });
  });
  const timer = setTimeout(() => req.destroy(failure()), 5000);
  req.on('close', () => clearTimeout(timer));
  req.on('error', () => reject(failure()));
  req.end(input.body);
});
const buildSmsTransport = ({ getConfig = () => require('../helpers/env').getCustomerSmsConfig(), request = post } = {}) => ({
  available: () => configured(getConfig()),
  development: () => development(getConfig()),
  async send({ destination, code }) {
    const config = getConfig();
    if (!configured(config) || !/^\+[1-9]\d{7,14}$/.test(destination || '') || !/^\d{6}$/.test(code || '')) throw failure();
    if (development(config)) return { accepted: true, development: true };
    const body = new URLSearchParams({ To: destination, From: config.from, Body: `Votre code SmartEat est ${code}. Il expire dans 10 minutes.` }).toString();
    try {
      const response = await request({ hostname: 'api.twilio.com', path: `/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
        headers: { Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }, body });
      if (response.statusCode !== 201 || !/^SM[a-f0-9]{32}$/i.test(response.body.sid || '')
        || !['accepted', 'queued', 'sending', 'sent', 'delivered'].includes(response.body.status)) throw failure();
      return { accepted: true, providerMessageId: response.body.sid };
    } catch (_) { throw failure(); }
  },
});
module.exports = { buildSmsTransport };
