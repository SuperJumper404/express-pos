const mysql = require("mysql2/promise");
const databaseOptions = require("./databaseOptions");

module.exports = mysql.createPool({
  ...databaseOptions,
  connectionLimit: 10,
});
