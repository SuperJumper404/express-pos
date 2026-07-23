const mysql = require("mysql2");
const databaseOptions = require("./databaseOptions");

module.exports = mysql.createConnection(databaseOptions);
