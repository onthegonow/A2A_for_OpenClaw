/**
 * CLI Uninstall Tests
 *
 * Covers: a2a uninstall --force and --keep-config behavior.
 */

module.exports = function (test, assert, helpers) {
  const fs = require('fs');
  const path = require('path');
  const { spawnSync } = require('child_process');

  function writeDummyFiles(dir) {
    const configFile = path.join(dir, 'a2a-config.json');
    const disclosureFile = path.join(dir, 'a2a-disclosure.json');
    const tokensFile = path.join(dir, 'a2a-tokens.json');
    const dbFile = path.join(dir, 'a2a-conversations.db');
    const logsDbFile = path.join(dir, 'a2a-logs.db');
    const callbookDbFile = path.join(dir, 'a2a-callbook.db');
    fs.writeFileSync(configFile, JSON.stringify({ ok: true }));
    fs.writeFileSync(disclosureFile, JSON.stringify({ ok: true }));
    fs.writeFileSync(tokensFile, JSON.stringify({ ok: true }));
    fs.writeFileSync(dbFile, 'not-a-real-sqlite-db');
    fs.writeFileSync(logsDbFile, 'not-a-real-sqlite-db');
    fs.writeFileSync(callbookDbFile, 'not-a-real-sqlite-db');
    return { configFile, disclosureFile, tokensFile, dbFile, logsDbFile, callbookDbFile };
  }

  test('a2a uninstall --force removes config and db files', () => {
    const tmp = helpers.tmpConfigDir('cli-uninstall');
    const { configFile, disclosureFile, tokensFile, dbFile, logsDbFile, callbookDbFile } = writeDummyFiles(tmp.dir);

    const res = spawnSync(process.execPath, ['bin/cli.js', 'uninstall', '--force'], {
      env: { ...process.env, A2A_CONFIG_DIR: tmp.dir },
      encoding: 'utf8',
      timeout: 20000
    });

    assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr=${(res.stderr || '').trim()}`);
    assert.ok(!fs.existsSync(configFile), 'expected a2a-config.json to be removed');
    assert.ok(!fs.existsSync(disclosureFile), 'expected a2a-disclosure.json to be removed');
    assert.ok(!fs.existsSync(tokensFile), 'expected a2a-tokens.json to be removed');
    assert.ok(!fs.existsSync(dbFile), 'expected a2a-conversations.db to be removed');
    assert.ok(!fs.existsSync(logsDbFile), 'expected a2a-logs.db to be removed');
    assert.ok(!fs.existsSync(callbookDbFile), 'expected a2a-callbook.db to be removed');
    assert.includes(res.stdout, 'npm uninstall -g a2acalling');

    tmp.cleanup();
  });

  test('a2a uninstall --keep-config preserves config and db files', () => {
    const tmp = helpers.tmpConfigDir('cli-uninstall-keep');
    const { configFile, disclosureFile, dbFile } = writeDummyFiles(tmp.dir);

    const res = spawnSync(process.execPath, ['bin/cli.js', 'uninstall', '--keep-config', '--force'], {
      env: { ...process.env, A2A_CONFIG_DIR: tmp.dir },
      encoding: 'utf8',
      timeout: 20000
    });

    assert.equal(res.status, 0, `expected exit 0, got ${res.status}. stderr=${(res.stderr || '').trim()}`);
    assert.ok(fs.existsSync(configFile), 'expected a2a-config.json to be preserved');
    assert.ok(fs.existsSync(disclosureFile), 'expected a2a-disclosure.json to be preserved');
    assert.ok(fs.existsSync(dbFile), 'expected a2a-conversations.db to be preserved');
    assert.includes(res.stdout, 'Config preserved: yes');

    tmp.cleanup();
  });
};

