const { envHOST, envDBPORT, envUSER, envPASS, envNAME } = require("../helpers/env");

module.exports = {
  host: envHOST,
  port: envDBPORT,
  user: envUSER,
  password: envPASS,
  database: envNAME,
};
