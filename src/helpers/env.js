require('dotenv').config()

module.exports = {
  envPORT: process.env.PORT ,
  envHOST: process.env.DBHOST || 'localhost:3306',
  envUSER: process.env.DBUSER || 'root',
  envPASS: process.env.DBPASS ,
  envNAME: process.env.DBNAME || 'pointofsale',
  envJWTKEY: process.env.JWTKEY,
  envEMAIL: process.env.EMAIL,
  envAPIKEY: process.env.MAILAPIKEY,
  envSECRETKEY: process.env.MAILSECRETKEY
}
 console.log("Module Env",module.exports)