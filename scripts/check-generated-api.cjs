'use strict';

const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '..');
const scratch = mkdtempSync(join(tmpdir(), 'renivet-api-contract-'));
const expected = [
  ['openapi/renivet.openapi.json', join(scratch, 'renivet.openapi.json')],
  ['src/generated/api-schema.d.ts', join(scratch, 'api-schema.d.ts')],
];
const normalizeLineEndings = (value) => value.replace(/\r\n/g, '\n');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    throw new Error(`${result.stdout ?? ''}${result.stderr ?? ''}` || `${command} exited with ${result.status}`);
  }
}

try {
  run(process.execPath, ['scripts/export-openapi.cjs', '--output', expected[0][1]]);
  run(process.execPath, [
    join(root, 'node_modules', 'openapi-typescript', 'bin', 'cli.js'),
    expected[0][1],
    '-o',
    expected[1][1],
  ]);

  for (const [trackedRelativePath, generatedPath] of expected) {
    const tracked = normalizeLineEndings(readFileSync(join(root, trackedRelativePath), 'utf8'));
    const generated = normalizeLineEndings(readFileSync(generatedPath, 'utf8'));
    if (tracked !== generated) {
      process.stderr.write(`${trackedRelativePath} is out of date. Run npm run api:generate and review the diff.\n`);
      process.exitCode = 1;
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
