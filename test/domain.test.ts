import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as Schema from 'effect/Schema';

import {
  AlertInput,
  DiscoveryResult,
  MonitorID,
  MonitorInput,
  ProjectInput,
  RenameMonitor,
  normalizeSlug,
} from '../src/domain.ts';

describe('AlertInput', () => {
  it('accepts email and HTTPS webhook rules', () => {
    assert.equal(
      Schema.decodeUnknownSync(AlertInput)({
        type: 'email',
        destination: 'ops@example.com',
        events: ['down', 'recovered'],
      }).type,
      'email',
    );
    assert.equal(
      Schema.decodeUnknownSync(AlertInput)({
        type: 'webhook',
        destination: 'https://hooks.example.com/secret',
        events: ['down'],
      }).type,
      'webhook',
    );
  });

  it('rejects insecure webhooks and empty event lists', () => {
    assert.throws(() =>
      Schema.decodeUnknownSync(AlertInput)({
        type: 'webhook',
        destination: 'http://hooks.example.com/secret',
        events: ['down'],
      }),
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(AlertInput)({
        type: 'email',
        destination: 'ops@example.com',
        events: [],
      }),
    );
  });
});

describe('projects and monitor identity', () => {
  it('accepts optional project assignment and state-preserving rename input', () => {
    assert.equal(
      Schema.decodeUnknownSync(MonitorInput)({
        name: 'Sync',
        url: 'https://sync.example.com/',
        projectID: 'example-services',
      }).projectID,
      'example-services',
    );
    assert.deepEqual(Schema.decodeUnknownSync(RenameMonitor)({ slug: 'zero-sync' }), { slug: 'zero-sync' });
    assert.equal(Schema.decodeUnknownSync(ProjectInput)({ name: 'Example Services' }).name, 'Example Services');
    assert.equal(normalizeSlug(Schema.decodeUnknownSync(MonitorID)('Zero-Sync')), 'zero-sync');
  });

  it('rejects invalid project and monitor slugs', () => {
    assert.throws(() =>
      Schema.decodeUnknownSync(MonitorInput)({
        name: 'Sync',
        url: 'https://sync.example.com/',
        projectID: 'Example Services!',
      }),
    );
    assert.throws(() => Schema.decodeUnknownSync(RenameMonitor)({ slug: 'Zero Sync' }));
  });
});

describe('DiscoveryResult', () => {
  it('represents a discovered status and suggested exact plain-text body', () => {
    const result = Schema.decodeUnknownSync(DiscoveryResult)({
      checkedAt: 1,
      reachable: true,
      statusCode: 200,
      latencyMs: 42,
      contentType: 'text/plain',
      body: 'OK',
      error: null,
      suggestedStatus: 200,
      suggestedBody: 'OK',
    });
    assert.equal(result.suggestedBody, 'OK');
  });
});
