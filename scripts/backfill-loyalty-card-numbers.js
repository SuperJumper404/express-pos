const { buildLoyalty, buildSqlLoyaltyRepository } = require('../src/modules/m_loyalty');
const { createTransactionRunner } = require('../src/helpers/withTransaction');

async function backfillCardNumbers({ pool, batchSize = 100 }) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('Invalid batch size');
  const transact = createTransactionRunner(pool);
  const service = buildLoyalty({ repository: buildSqlLoyaltyRepository({ pool }), runInTransaction: transact });
  let updated = 0;
  while (true) {
    const [rows] = await pool.query(`SELECT id,shopid FROM loyalty_members WHERE card_number IS NULL ORDER BY shopid,id LIMIT ${batchSize}`);
    if (!rows.length) return { updated };
    for (const row of rows) await transact(async connection => {
      await connection.query('SELECT id FROM shop WHERE id=? FOR UPDATE', [row.shopid]);
      await service.ensureCardNumber({ connection, shopId: row.shopid, memberId: row.id });
      updated++;
    });
  }
}
if (require.main === module) {
  const url = process.env.LOYALTY_BACKFILL_DATABASE_URL;
  if (!url) { console.error('Explicit LOYALTY_BACKFILL_DATABASE_URL required'); process.exitCode = 1; }
  else {
    const pool = require('mysql2/promise').createPool(url);
    backfillCardNumbers({ pool }).then(({ updated }) => console.log(`${updated} loyalty card numbers assigned`))
      .catch(() => { console.error('Loyalty backfill failed; it can be resumed safely'); process.exitCode = 1; }).finally(() => pool.end());
  }
}
module.exports = { backfillCardNumbers };
