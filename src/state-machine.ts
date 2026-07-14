import type { MonitorConfig, MonitorTransition, ProbeResult, TransitionState } from './domain.ts';

export function transitionMonitor(
  config: MonitorConfig,
  state: TransitionState,
  result: ProbeResult,
  incidentID: string,
): MonitorTransition {
  if (!config.enabled) {
    return {
      status: 'disabled',
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      activeIncidentID: null,
      openedIncidentID: null,
      recoveredIncidentID: null,
      nextCheckInMs: config.healthyIntervalMs,
    };
  }

  if (result.successful) return successfulTransition(config, state);
  return failedTransition(config, state, incidentID);
}

function successfulTransition(config: MonitorConfig, state: TransitionState): MonitorTransition {
  if (state.status !== 'down' && state.status !== 'recovering') {
    return transition('healthy', 0, state.consecutiveSuccesses + 1, null, null, null, config.healthyIntervalMs);
  }

  const successes = state.consecutiveSuccesses + 1;
  if (successes < config.recoveryThreshold) {
    return transition('recovering', 0, successes, state.activeIncidentID, null, null, config.recoveringIntervalMs);
  }

  return transition('healthy', 0, successes, null, null, state.activeIncidentID, config.healthyIntervalMs);
}

function failedTransition(config: MonitorConfig, state: TransitionState, incidentID: string): MonitorTransition {
  const failures = state.consecutiveFailures + 1;
  if (state.status === 'down' || state.status === 'recovering') {
    return transition('down', failures, 0, state.activeIncidentID ?? incidentID, null, null, config.downIntervalMs);
  }

  if (failures < config.failureThreshold) {
    return transition('suspect', failures, 0, null, null, null, config.suspectIntervalMs);
  }

  return transition('down', failures, 0, incidentID, incidentID, null, config.downIntervalMs);
}

function transition(
  status: MonitorTransition['status'],
  consecutiveFailures: number,
  consecutiveSuccesses: number,
  activeIncidentID: string | null,
  openedIncidentID: string | null,
  recoveredIncidentID: string | null,
  nextCheckInMs: number,
): MonitorTransition {
  return {
    status,
    consecutiveFailures,
    consecutiveSuccesses,
    activeIncidentID,
    openedIncidentID,
    recoveredIncidentID,
    nextCheckInMs,
  };
}
