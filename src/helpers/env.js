const dotenv = require("dotenv");

const env = process.env.NODE_ENV || "local";
const envFile = process.env.ENV_FILE || `.env.${env}`;

dotenv.config({
  path: envFile,
});

const parseDatabaseUrl = (databaseUrl) => {
  if (!databaseUrl) {
    return {};
  }

  try {
    const url = new URL(databaseUrl);

    return {
      host: url.hostname,
      port: url.port,
      user: decodeURIComponent(url.username || ""),
      password: decodeURIComponent(url.password || ""),
      database: decodeURIComponent(url.pathname.replace(/^\/+/, "")),
    };
  } catch (error) {
    console.warn("Invalid DATABASE_URL:", error.message);
    return {};
  }
};

const hasEnv = (key) => process.env[key] !== undefined;
const database = parseDatabaseUrl(process.env.DATABASE_URL);
const parsePositiveIntegerEnv = (value, fallback) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

module.exports = {
  envPORT: process.env.PORT || process.env.APP_PORT || "5005",
  envHOST: process.env.DBHOST || database.host || "localhost",
  envDBPORT: Number(process.env.DBPORT || database.port || 3306),
  envUSER: process.env.DBUSER || database.user || "root",
  envPASS: hasEnv("DBPASS") ? process.env.DBPASS : database.password,
  envNAME: process.env.DBNAME || database.database || "pointofsale",
  envJWTKEY: process.env.JWTKEY,
  envEMAIL: process.env.EMAIL,
  envAPIKEY: process.env.MAILAPIKEY,
  envSECRETKEY: process.env.MAILSECRETKEY,
  envPUBLICIMAGEPATH: process.env.PUBLICIMAGEPATH,
  envSTRIPESECRETKEY: process.env.STRIPE_SECRET_KEY,
  envSTRIPEPUBLISHABLEKEY: process.env.STRIPE_PUBLISHABLE_KEY,
  envSTRIPEWEBHOOKSECRET: process.env.STRIPE_WEBHOOK_SECRET,
  envSTRIPERETURNURL: process.env.STRIPE_CONNECT_RETURN_URL,
  envSTRIPEREFRESHURL: process.env.STRIPE_CONNECT_REFRESH_URL,
  envSTRIPEPAYMENTMETHODCONFIGURATIONID:
    process.env.STRIPE_PAYMENT_METHOD_CONFIGURATION_ID,
  envSTRIPESTOCKRESERVATIONMINUTES: parsePositiveIntegerEnv(
    process.env.STRIPE_STOCK_RESERVATION_MINUTES,
    15,
  ),
  parsePositiveIntegerEnv,
  // Delivery config is read at the service boundary; disabled legacy boot needs no new secrets.
  getDeliveryConfig: () => ({
    googlePlacesApiKey: process.env.GOOGLE_PLACES_API_KEY,
    tokenSecret: process.env.DELIVERY_TOKEN_SECRET,
    geocodingBaseUrl: process.env.DELIVERY_GEOCODING_BASE_URL || "https://data.geopf.fr/geocodage",
  }),
  getCustomerAuthConfig: () => ({
    secret: process.env.CUSTOMER_AUTH_SECRET,
    jwtSecret: process.env.JWTKEY,
    email: process.env.EMAIL,
    mailApiKey: process.env.MAILAPIKEY,
    mailSecretKey: process.env.MAILSECRETKEY,
    whatsappAccessToken: process.env.CUSTOMER_WHATSAPP_ACCESS_TOKEN,
    whatsappPhoneNumberId: process.env.CUSTOMER_WHATSAPP_PHONE_NUMBER_ID,
    whatsappTemplateName: process.env.CUSTOMER_WHATSAPP_TEMPLATE_NAME,
    whatsappTemplateLanguage: process.env.CUSTOMER_WHATSAPP_TEMPLATE_LANGUAGE,
    whatsappGraphVersion: process.env.CUSTOMER_WHATSAPP_GRAPH_VERSION,
  }),
  getCustomerSmsConfig: () => ({
    mode: process.env.CUSTOMER_SMS_MODE || 'disabled',
    nodeEnv: process.env.NODE_ENV || 'local',
    accountSid: process.env.CUSTOMER_SMS_TWILIO_ACCOUNT_SID,
    authToken: process.env.CUSTOMER_SMS_TWILIO_AUTH_TOKEN,
    from: process.env.CUSTOMER_SMS_FROM,
  }),
  getCustomerSessionConfig: () => ({
    allowedOrigins: (process.env.CUSTOMER_ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(value => {
      try {
        const url = new URL(value);
        return url.origin === value && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
      } catch (_) { return false; }
    }),
    trustedProxies: (process.env.CUSTOMER_TRUSTED_PROXIES || "").split(",").map(value => value.trim()).filter(Boolean),
  }),
};

console.log("Loaded env file:", envFile);
