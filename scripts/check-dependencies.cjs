'use strict';
// Phase 0.3 host-only validation. No tables, migrations or production mutations.
const { Pool } = require('pg');
const net = require('node:net');

const timeoutMs = 5000;
const localDb = 'postgres://renivet:renivet_local_only@127.0.0.1:5432/renivet';
function assertLocal(name, value) {
  const url = new URL(value);
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error(name + ' must target localhost in Phase 0.3.');
  }
  return url;
}
function checkRedis(url) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({host: url.hostname, port: Number(url.port || 6379)});
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    socket.setTimeout(timeoutMs, () => finish(new Error('Redis timed out')));
    socket.on('error', finish);
    socket.on('connect', () => socket.write('*1\r\n$4\r\nPING\r\n'));
    socket.on('data', (data) => {
      if (data.toString().startsWith('+PONG')) finish();
      else finish(new Error('Unexpected Redis PING response'));
    });
  });
}
async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Local dependency checks are disabled in production');
  }
  const dbUrl = process.env.DATABASE_URL || localDb;
  assertLocal('DATABASE_URL', dbUrl);
  const redisUrl = assertLocal('REDIS_URL', process.env.REDIS_URL || 'redis://127.0.0.1:6379');
  const typesense = assertLocal('TYPESENSE_URL', process.env.TYPESENSE_URL || 'http://127.0.0.1:8108');
  const python = assertLocal('PYTHON_SERVICE_URL', process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000');
  const pool = new Pool({ connectionString: dbUrl, connectionTimeoutMillis: timeoutMs, max: 1 });
  try {
    const result = await pool.query('SELECT 1 AS ready');
    if (result.rows[0]?.ready !== 1) throw new Error('PostgreSQL query mismatch');
    console.log('PASS PostgreSQL SQL connection');
  } finally { await pool.end(); }
  await checkRedis(redisUrl);
  console.log('PASS Redis PING from backend runtime');
  const typeResponse = await fetch(new URL('/collections', typesense), {
    headers: { 'X-TYPESENSE-API-KEY': process.env.TYPESENSE_API_KEY || 'local-typesense-do-not-deploy' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!typeResponse.ok || !Array.isArray(await typeResponse.json())) {
    throw new Error('Typesense authenticated collections check failed');
  }
  console.log('PASS Typesense authorized API');
  const pyResponse = await fetch(new URL('/health', python), { signal: AbortSignal.timeout(timeoutMs) });
  if (!pyResponse.ok || (await pyResponse.json()).status !== 'ok') {
    throw new Error('FastAPI health check failed');
  }
  console.log('PASS FastAPI connectivity');
}
main().catch(error => {
  console.error('FAIL: local dependency check:', error.message);
  process.exitCode = 1;
});
