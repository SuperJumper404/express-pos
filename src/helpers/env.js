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
};

console.log("Loaded env file:", envFile);
