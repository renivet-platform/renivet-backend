'use strict';

const argon2 = require('argon2');
const { randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');

async function benchmark() {
  const samples = [];
  for (let index = 0; index < 3; index += 1) {
    const started = performance.now();
    await argon2.hash(randomBytes(32), {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
      hashLength: 32,
    });
    samples.push(Math.round(performance.now() - started));
  }
  const ordered = [...samples].sort((left, right) => left - right);
  process.stdout.write(`${JSON.stringify({ algorithm: 'Argon2id', memoryKiB: 19456, iterations: 2, parallelism: 1, samplesMs: samples, medianMs: ordered[1] })}\n`);
}

benchmark().catch(() => {
  process.stderr.write('Argon2id benchmark failed.\n');
  process.exitCode = 1;
});
