'use strict';

const { Pool } = require('pg');
const { DurableWorker } = require('../../dist/workers/durable-worker.js');

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { databaseUrl, job, mode, effectName } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
  const worker = new DurableWorker(pool, [{
    consumerId: job.jobKind,
    eventTypes: ['test.worker.created'],
    authorization: { scope: 'system' },
    async handle(_event, transaction) {
      await transaction.query('INSERT INTO system_events (event_name) VALUES ($1)', [effectName]);
      if (mode === 'before_commit') process.exit(71);
    },
  }]);
  const outcome = await worker.process(job);
  await pool.end();
  if (mode === 'after_commit' && outcome === 'processed') process.exit(72);
  process.exit(74);
}

main().catch(() => process.exit(75));
