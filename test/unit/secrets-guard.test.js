/**
 * Secrets Guard Tests
 *
 * These tests exist to prevent accidental removal of ignore rules that keep
 * maintainer credentials out of git history and npm packages.
 */

const fs = require('fs');
const path = require('path');

module.exports = function (test, assert) {
  function readRepoFile(name) {
    const repoRoot = path.join(__dirname, '..', '..');
    return fs.readFileSync(path.join(repoRoot, name), 'utf8');
  }

  test('.gitignore keeps .env ignored', () => {
    const contents = readRepoFile('.gitignore');
    assert.match(contents, /(^|\r?\n)\.env(\r?\n|$)/);
    assert.match(contents, /(^|\r?\n)\.env\.\*(\r?\n|$)/);
  });

  test('.npmignore keeps .env out of published package', () => {
    const contents = readRepoFile('.npmignore');
    assert.match(contents, /(^|\r?\n)\.env(\r?\n|$)/);
    assert.match(contents, /(^|\r?\n)\.env\.\*(\r?\n|$)/);
  });
};
