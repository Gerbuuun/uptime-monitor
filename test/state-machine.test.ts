import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeMonitor, type ProbeResult, type TransitionState } from '../src/domain.ts';
import { transitionMonitor } from '../src/state-machine.ts';

const config = normalizeMonitor('internal-sync', 'example-api', {
  name: 'Example API',
  url: 'https://api.example.com/',
});
const success = { checkedAt: 1, successful: true, statusCode: 200, latencyMs: 10, error: null, body: 'OK' };
const failure = { ...success, successful: false, statusCode: 503 } satisfies ProbeResult;
const initial = {
  status: 'uninitialized',
  consecutiveFailures: 0,
  consecutiveSuccesses: 0,
  activeIncidentID: null,
} satisfies TransitionState;

describe('transitionMonitor', () => {
  it('confirms an outage before opening an incident', () => {
    const suspect = transitionMonitor(config, initial, failure, 'incident-1');
    const down = transitionMonitor(config, suspect, failure, 'incident-2');

    assert.equal(suspect.status, 'suspect');
    assert.equal(suspect.nextCheckInMs, 15_000);
    assert.equal(down.status, 'down');
    assert.equal(down.openedIncidentID, 'incident-2');
  });

  it('confirms recovery before closing an incident', () => {
    const down = {
      status: 'down',
      consecutiveFailures: 2,
      consecutiveSuccesses: 0,
      activeIncidentID: 'incident-1',
    } satisfies TransitionState;
    const recovering = transitionMonitor(config, down, success, 'unused');
    const healthy = transitionMonitor(config, recovering, success, 'unused');

    assert.equal(recovering.status, 'recovering');
    assert.equal(healthy.status, 'healthy');
    assert.equal(healthy.recoveredIncidentID, 'incident-1');
  });

  it('returns to down when recovery fails', () => {
    const recovering = {
      status: 'recovering',
      consecutiveFailures: 0,
      consecutiveSuccesses: 1,
      activeIncidentID: 'incident-1',
    } satisfies TransitionState;

    assert.equal(transitionMonitor(config, recovering, failure, 'unused').status, 'down');
  });
});
