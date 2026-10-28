const https = require("https");
const DomainError = require("../helpers/domainError");
const { normalizeCustomerDestination } = require("../helpers/customerIdentity");

const unavailable = () => new DomainError(503, "CUSTOMER_CODE_UNAVAILABLE", "Code provider unavailable");
const timeout = () => new DomainError(503, "CUSTOMER_CODE_TIMEOUT", "Code provider result uncertain");
const channelUnavailable = () => new DomainError(503, "CUSTOMER_CHANNEL_UNAVAILABLE", "Customer channel unavailable");
const present = value => typeof value === "string" && !!value.trim() && !/[\x00-\x1f\x7f]/.test(value);
const authSecretReady = config => present(config.secret) && Buffer.byteLength(config.secret) >= 32 && config.secret !== config.jwtSecret;
const configuredChannels = config => {
  let sender = false;
  try { sender = normalizeCustomerDestination({ channel: "email", value: config.email }) === config.email; } catch (_) { /* unavailable */ }
  const ready = authSecretReady(config);
  return {
    email: ready && sender && present(config.mailApiKey) && present(config.mailSecretKey),
    whatsapp: ready && present(config.whatsappAccessToken) && /^\d+$/.test(config.whatsappPhoneNumberId || "")
      && /^[a-z0-9_]+$/.test(config.whatsappTemplateName || "") && /^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(config.whatsappTemplateLanguage || "")
      && /^v\d+\.\d+$/.test(config.whatsappGraphVersion || ""),
  };
};

const postMeta = (config, payload) => new Promise((resolve, reject) => {
  // The installed Mailjet proxy dependency patches https.request's URL overload.
  const request = https.request({
    hostname: "graph.facebook.com", path: `/${config.whatsappGraphVersion}/${config.whatsappPhoneNumberId}/messages`,
    method: "POST", headers: { Authorization: `Bearer ${config.whatsappAccessToken}`, "Content-Type": "application/json" },
  }, response => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", chunk => {
      body += chunk;
      if (body.length > 65536) request.destroy(unavailable());
    });
    response.on("error", () => reject(timeout()));
    response.on("end", () => {
      if (response.statusCode < 200 || response.statusCode >= 300) return reject(response.statusCode >= 500 ? timeout() : unavailable());
      try { resolve(JSON.parse(body)); } catch (_) { reject(unavailable()); }
    });
  });
  const timer = setTimeout(() => request.destroy(timeout()), 5000);
  request.on("error", error => reject(error instanceof DomainError ? error : timeout()));
  request.on("close", () => clearTimeout(timer));
  request.end(JSON.stringify(payload));
});

const buildCustomerCodeTransports = ({ getConfig = () => require("../helpers/env").getCustomerAuthConfig(),
  sms = require('./customerSms').buildSmsTransport() } = {}) => ({
  channels: () => ({ ...configuredChannels(getConfig()), sms: authSecretReady(getConfig()) && sms.available(), smsDevelopment: sms.development() }),
  async sendCode({ channel, destination, code, expiresInMinutes, locale }) {
    const config = getConfig();
    if (!(channel === 'sms' ? authSecretReady(config) && sms.available() : configuredChannels(config)[channel])) throw channelUnavailable();
    if (typeof code !== "string" || !/^\d{6}$/.test(code) || expiresInMinutes !== 10
      || (locale !== undefined && (typeof locale !== "string" || !/^[a-z]{2,3}(?:[-_][A-Za-z]{2})?$/.test(locale)))) throw unavailable();
    destination = normalizeCustomerDestination({ channel, value: destination });
    if (channel === 'sms') return sms.send({ destination, code });
    try {
      if (channel === "email") {
        const french = !locale || locale.startsWith("fr");
        const text = french ? `Votre code de connexion Smart Eat est ${code}. Il expire dans ${expiresInMinutes} minutes.`
          : `Your Smart Eat sign-in code is ${code}. It expires in ${expiresInMinutes} minutes.`;
        const client = require("node-mailjet").connect(config.mailApiKey, config.mailSecretKey, { timeout: { response: 5000, deadline: 5000 } });
        const result = await client.post("send", { version: "v3.1" }).request({ Messages: [{
          From: { Email: config.email, Name: "Smart Eat" }, To: [{ Email: destination }],
          Subject: french ? "Code de connexion Smart Eat" : "Smart Eat sign-in code", TextPart: text,
        }] });
        const messages = result && result.body && result.body.Messages;
        const recipient = Array.isArray(messages) && messages.length === 1 && messages[0].Status === "success"
          && Array.isArray(messages[0].To) && messages[0].To.length === 1 && messages[0].To[0];
        if (!recipient || !present(recipient.MessageUUID)) throw unavailable();
        return { accepted: true, providerMessageId: recipient.MessageUUID };
      }
      const result = await postMeta(config, {
        messaging_product: "whatsapp", recipient_type: "individual", to: destination.slice(1), type: "template",
        template: { name: config.whatsappTemplateName, language: { code: config.whatsappTemplateLanguage }, components: [
          { type: "body", parameters: [{ type: "text", text: code }] },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
        ] },
      });
      if (!result || !Array.isArray(result.messages) || result.messages.length !== 1 || !present(result.messages[0].id)) throw unavailable();
      return { accepted: true, providerMessageId: result.messages[0].id };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (error && (error.timeout || error.code === "ECONNABORTED" || !error.statusCode || error.statusCode >= 500)) throw timeout();
      throw unavailable();
    }
  },
});

module.exports = { buildCustomerCodeTransports, authSecretReady };
