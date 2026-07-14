import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  configPath,
  normalizeBaseUrl,
  normalizeEmail,
  readCliConfig,
  writeCliConfig,
} from '../src/cli-config.ts';

describe('CLI configuration', () => {
  it('stores configuration in the user profile', () => {
    assert.equal(configPath(), join(process.env.HOME!, '.config', 'uptime-monitor', 'config.json'));
  });

  it('writes a private, normalized configuration file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'uptime-monitor-config-'));
    const path = join(directory, 'nested', 'config.json');
    writeCliConfig(
      {
        baseUrl: 'https://uptime-monitor.example.workers.dev/',
        token: 'test-token',
        alertEmail: ' alerts@example.com ',
      },
      path,
    );

    assert.deepEqual(readCliConfig(path), {
      baseUrl: 'https://uptime-monitor.example.workers.dev',
      token: 'test-token',
      alertEmail: 'alerts@example.com',
    });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /\"baseUrl\": \"https:\/\/uptime-monitor.example.workers.dev\/\"/);
  });

  it('rejects non-origin URLs and empty alert destinations', () => {
    assert.throws(() => normalizeBaseUrl('https://example.com/api'), /must be an origin/);
    assert.throws(() => normalizeEmail('  '), /destination cannot be empty/);
  });
});
