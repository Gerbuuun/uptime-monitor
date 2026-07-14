import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatHistoryStatic,
  formatMonitorList,
  formatProject,
  formatTimeline,
  summarizeChecks,
} from '../src/cli-output.ts';
import type { Check, MonitorSnapshot } from '../src/domain.ts';

const monitor: MonitorSnapshot = {
  config: {
    internalID: 'internal-sync',
    slug: 'example-api',
    projectID: null,
    name: 'Example API',
    url: 'https://api.example.com/',
    expectedStatus: 200,
    expectedBody: 'OK',
    timeoutMs: 10_000,
    healthyIntervalMs: 60_000,
    suspectIntervalMs: 15_000,
    downIntervalMs: 60_000,
    recoveringIntervalMs: 15_000,
    failureThreshold: 2,
    recoveryThreshold: 2,
    alerts: true,
    enabled: true,
  },
  status: 'healthy',
  consecutiveFailures: 0,
  consecutiveSuccesses: 3,
  activeIncidentID: null,
  lastCheckedAt: 1_000,
  lastSucceededAt: 1_000,
  nextCheckAt: 61_000,
  updatedAt: 1_000,
};

const checks: readonly Check[] = [
  { id: 3, checkedAt: 3_000, successful: false, statusCode: 500, latencyMs: 25, error: 'HTTP 500', body: 'error' },
  { id: 2, checkedAt: 2_000, successful: true, statusCode: 200, latencyMs: 1_200, error: null, body: 'OK' },
  { id: 1, checkedAt: 1_000, successful: true, statusCode: 200, latencyMs: 25, error: null, body: 'OK' },
];

describe('CLI output', () => {
  it('renders one line per monitor in list output', () => {
    const output = formatMonitorList([monitor, { ...monitor, config: { ...monitor.config, slug: 'api' } }], false);
    assert.equal(output.split('\n').length, 2);
    assert.match(output, /HEALTHY\s+example-api/);
  });

  it('summarizes up, degraded, and failed history checks', () => {
    const output = formatHistoryStatic(monitor, checks, false, false);
    assert.equal(output.split('\n').length, 3);
    assert.match(output, /FAILED.*HTTP 500/);
    assert.match(output, /DEGRADED.*HTTP 200/);
    assert.match(output, /UP.*HTTP 200/);
  });

  it('returns complete check counts for agent output', () => {
    assert.deepEqual(summarizeChecks(checks), {
      total: 3,
      successful: 2,
      up: 1,
      degraded: 1,
      failed: 1,
      successRatePercent: 66.67,
    });
  });

  it('renders failures above degraded and healthy timeline buckets', () => {
    const output = formatTimeline(
      monitor,
      {
        resolutionMs: 300_000,
        points: [
          {
            startedAt: 1_000,
            endedAt: 301_000,
            resolutionMs: 300_000,
            samples: 3,
            up: 3,
            degraded: 0,
            failed: 0,
            latencyMinMs: 10,
            latencyAverageMs: 20,
            latencyMaxMs: 30,
          },
          {
            startedAt: 301_000,
            endedAt: 601_000,
            resolutionMs: 300_000,
            samples: 2,
            up: 0,
            degraded: 1,
            failed: 1,
            latencyMinMs: 1_100,
            latencyAverageMs: 1_500,
            latencyMaxMs: 1_900,
          },
        ],
        intervals: [],
        anomalies: checks.slice(0, 2),
      },
      false,
      100,
    );
    assert.match(output, /5m resolution · 5 checks/);
    assert.match(output, /▂█/);
    assert.match(output, /Retained anomalies \(2\)/);
  });

  it('colors project and member statuses', () => {
    const output = formatProject(
      {
        id: 'example-services',
        name: 'Example Services',
        status: 'healthy',
        monitors: [
          {
            internalID: 'internal-sync',
            slug: 'zero-sync',
            status: 'healthy',
            lastCheckedAt: 1_000,
            updatedAt: 1_000,
          },
        ],
        createdAt: 1_000,
        updatedAt: 1_000,
      },
      true,
    );
    assert.match(output, /\u001b\[32m● HEALTHY/);
    assert.match(output, /zero-sync/);
  });
});
