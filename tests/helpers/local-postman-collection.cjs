'use strict';

const { readFileSync, writeFileSync } = require('node:fs');

function createUnauthenticatedLocalCollection(sourcePath, destinationPath) {
  const collection = JSON.parse(readFileSync(sourcePath, 'utf8'));
  if (collection.info && typeof collection.info === 'object') {
    delete collection.info._postman_id;
  }
  writeFileSync(destinationPath, `${JSON.stringify(collection, null, 2)}\n`, { mode: 0o600 });
  return destinationPath;
}

module.exports = { createUnauthenticatedLocalCollection };
