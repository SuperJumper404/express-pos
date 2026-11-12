// Simulation is the default. Uses the backend's explicitly selected environment.
const args = process.argv.slice(2);
const position = args.indexOf('--shop-id');
const shopId = Number(args[position + 1]);
if (position < 0 || !Number.isInteger(shopId) || shopId < 1 || args.some((arg, index) => !['--shop-id', '--apply'].includes(arg) && index !== position + 1)) {
  process.stderr.write('Usage: node scripts/reconcile-client-directory.js --shop-id N [--apply]\n');
  process.exitCode = 1;
} else {
  require('dotenv').config({ path: process.env.ENV_FILE || '.env' });
  const pool = require('../src/config/dbPool');
  require('../src/modules/m_clientDirectory').buildClientDirectoryService().reconcile({ shopId, dryRun: !args.includes('--apply') })
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; })
    .finally(() => pool.end());
}
