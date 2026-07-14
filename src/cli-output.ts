import type { AlertRule, Check, MonitorSnapshot, MonitorStatus, ProjectSnapshot, Timeline } from './domain.ts';

const ansi = {
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  cyan: '\u001b[36m',
  reset: '\u001b[0m',
};

export function formatMonitorList(monitors: readonly MonitorSnapshot[], colors: boolean) {
  if (monitors.length === 0) return 'No monitors configured.';
  const idWidth = Math.max(...monitors.map((monitor) => monitor.config.slug.length));
  return monitors
    .map((monitor) => {
      const status = monitorStatus(monitor.status);
      return `${paint(status.color, `${status.icon} ${monitor.status.toUpperCase().padEnd(13)}`, colors)}  ${monitor.config.slug.padEnd(idWidth)}  ${relativeTime(monitor.lastCheckedAt)}  ${monitor.config.url}`;
    })
    .join('\n');
}

export function formatMonitor(monitor: MonitorSnapshot, colors: boolean, verbose = false) {
  const status = monitorStatus(monitor.status);
  const title = `${paint(status.color, status.icon, colors)} ${paint('bold', monitor.config.name, colors)} ${paint('dim', `(${monitor.config.slug})`, colors)}`;
  const lines = [
    title,
    field('Status', paint(status.color, monitor.status.toUpperCase(), colors)),
    field('Project', monitor.config.projectID ?? 'none'),
    field('URL', monitor.config.url),
    field('Last check', timestamp(monitor.lastCheckedAt)),
    field('Last success', timestamp(monitor.lastSucceededAt)),
    field('Next check', timestamp(monitor.nextCheckAt)),
  ];
  if (!verbose) return lines.join('\n');
  return [
    ...lines,
    '',
    paint('bold', 'Expectation', colors),
    field('HTTP status', String(monitor.config.expectedStatus)),
    field('Body', monitor.config.expectedBody ?? 'any'),
    field('Timeout', duration(monitor.config.timeoutMs)),
    '',
    paint('bold', 'Cadence', colors),
    field('Healthy', duration(monitor.config.healthyIntervalMs)),
    field('Suspect', duration(monitor.config.suspectIntervalMs)),
    field('Down', duration(monitor.config.downIntervalMs)),
    field('Recovering', duration(monitor.config.recoveringIntervalMs)),
    field('Thresholds', `${monitor.config.failureThreshold} failures / ${monitor.config.recoveryThreshold} successes`),
    field('Alerts', monitor.config.alerts ? 'enabled' : 'disabled'),
    field('Incident', monitor.activeIncidentID ?? 'none'),
    field('Streak', `${monitor.consecutiveSuccesses} successful / ${monitor.consecutiveFailures} failed`),
  ].join('\n');
}

export function formatTimeline(monitor: MonitorSnapshot, timeline: Timeline, colors: boolean, width = 100) {
  if (timeline.points.length === 0) return `No timeline data recorded for ${monitor.config.slug} in this range.`;
  const columns = Math.max(10, Math.min(width, 120));
  const chunkSize = Math.max(1, Math.ceil(timeline.points.length / columns));
  const blocks = Array.from({ length: Math.ceil(timeline.points.length / chunkSize) }, (_, index) =>
    timeline.points.slice(index * chunkSize, (index + 1) * chunkSize),
  )
    .map((points) => {
      const failed = points.some((point) => point.failed > 0);
      const degraded = points.some((point) => point.degraded > 0);
      if (failed) return paint('red', paint('bold', '█', colors), colors);
      if (degraded) return paint('yellow', '▆', colors);
      return paint('green', '▂', colors);
    })
    .join('');
  const totals = timeline.points.reduce(
    (total, point) => ({
      samples: total.samples + point.samples,
      up: total.up + point.up,
      degraded: total.degraded + point.degraded,
      failed: total.failed + point.failed,
    }),
    { samples: 0, up: 0, degraded: 0, failed: 0 },
  );
  return [
    `${paint('bold', monitor.config.name, colors)} ${paint('dim', `(${monitor.config.slug})`, colors)} · ${formatResolution(timeline.resolutionMs)} resolution · ${totals.samples} checks`,
    `${paint('green', `▂ ${totals.up} up`, colors)}  ${paint('yellow', `▆ ${totals.degraded} degraded`, colors)}  ${paint('red', `█ ${totals.failed} failed`, colors)}`,
    blocks,
    `${new Date(timeline.points[0]!.startedAt).toLocaleString()} → ${new Date(timeline.points.at(-1)!.endedAt).toLocaleString()}`,
    timeline.anomalies.length === 0
      ? paint('dim', 'No retained degraded or failed checks in this range.', colors)
      : `\nRetained anomalies (${timeline.anomalies.length})\n${timeline.anomalies.map((check) => formatCheckLine(check, colors)).join('\n')}`,
  ].join('\n');
}

export function formatAlertList(alerts: readonly AlertRule[], colors: boolean, verbose = false) {
  if (alerts.length === 0) return 'No alert rules configured.';
  return alerts
    .map((alert) => {
      const status = alert.enabled ? paint('green', '● ENABLED ', colors) : paint('dim', '○ DISABLED', colors);
      const line = `${status}  ${alert.id.padEnd(20)}  ${alert.type.padEnd(7)}  ${alert.events.join(',')}  ${alert.destination}`;
      return verbose
        ? `${line}\n${field('Created', new Date(alert.createdAt).toLocaleString())}\n${field('Updated', new Date(alert.updatedAt).toLocaleString())}`
        : line;
    })
    .join(verbose ? '\n\n' : '\n');
}

export function formatProjectLine(project: ProjectSnapshot, colors: boolean) {
  const status = projectStatus(project.status);
  return `${paint(status.color, `${status.icon} ${project.status.toUpperCase().padEnd(9)}`, colors)}  ${project.id.padEnd(24)} ${project.monitors.length} monitor${project.monitors.length === 1 ? '' : 's'}  ${project.name}`;
}

export function formatProject(project: ProjectSnapshot, colors: boolean) {
  return [
    formatProjectLine(project, colors),
    ...project.monitors.map((monitor) => {
      const status = monitorStatus(monitor.status);
      return `  ${paint(status.color, `${status.icon} ${monitor.status.toUpperCase().padEnd(13)}`, colors)} ${monitor.slug.padEnd(24)} checked ${timestamp(monitor.lastCheckedAt)}`;
    }),
  ].join('\n');
}

export function formatHistoryStatic(
  monitor: MonitorSnapshot,
  checksNewestFirst: readonly Check[],
  colors: boolean,
  verbose: boolean,
) {
  if (checksNewestFirst.length === 0) return `No checks recorded for ${monitor.config.slug}.`;
  if (verbose) return checksNewestFirst.map((check) => formatCheck(check, colors, true)).join('\n\n');
  return checksNewestFirst.map((check) => formatCheckLine(check, colors)).join('\n');
}

export function formatHistoryFrame(
  monitor: MonitorSnapshot,
  checks: readonly Check[],
  selected: number,
  colors: boolean,
  width: number,
  verbose: boolean,
) {
  return [
    historyHeader(monitor, checks, colors),
    historyBar(checks, selected, width, colors),
    `${paint('dim', '←/→ move · home/end jump · q close', colors)}  ${selected + 1}/${checks.length}`,
    '',
    formatCheck(checks[selected]!, colors, verbose),
  ].join('\n');
}

function historyHeader(monitor: MonitorSnapshot, checks: readonly Check[], colors: boolean) {
  const summary = summarizeChecks(checks);
  return [
    `${paint('bold', monitor.config.name, colors)} ${paint('dim', `(${monitor.config.slug})`, colors)} · ${summary.successRatePercent.toFixed(1)}% successful`,
    `${paint('green', `▂ ${summary.up} up`, colors)}  ${paint('yellow', `▆ ${summary.degraded} degraded`, colors)}  ${paint('red', `█ ${summary.failed} failed`, colors)}  ${paint('dim', 'degraded = successful but ≥ 1s', colors)}`,
  ].join('\n');
}

function historyBar(checks: readonly Check[], selected: number, width: number, colors: boolean) {
  const available = Math.max(10, width - 2);
  const start = Math.max(0, Math.min(selected - Math.floor(available / 2), checks.length - available));
  const visible = checks.slice(start, start + available);
  const blocks = visible
    .map((check, index) => {
      const color = check.successful ? (check.latencyMs >= 1_000 ? 'yellow' : 'green') : 'red';
      const block = check.successful ? (check.latencyMs >= 1_000 ? '▆' : '▂') : '█';
      return paint(color, check.successful ? block : paint('bold', block, colors), colors);
    })
    .join('');
  return `${blocks}\n${' '.repeat(selected - start)}${paint('cyan', '▲', colors)}`;
}

function formatCheck(check: Check, colors: boolean, verbose = false) {
  const kind = check.successful ? (check.latencyMs >= 1_000 ? 'DEGRADED' : 'UP') : 'FAILED';
  const color = check.successful ? (check.latencyMs >= 1_000 ? 'yellow' : 'green') : 'red';
  const lines = [
    `${paint(color, `● ${kind}`, colors)}  ${new Date(check.checkedAt).toLocaleString()}  ${check.latencyMs}ms`,
    field('HTTP status', check.statusCode === null ? 'none' : String(check.statusCode)),
  ];
  if (check.error) lines.push(field('Error', singleLine(check.error)));
  if (verbose || check.error) lines.push(field('Body', check.body === null ? 'none' : singleLine(check.body)));
  return lines.join('\n');
}

function formatCheckLine(check: Check, colors: boolean) {
  const kind = check.successful ? (check.latencyMs >= 1_000 ? 'DEGRADED' : 'UP') : 'FAILED';
  const color = check.successful ? (check.latencyMs >= 1_000 ? 'yellow' : 'green') : 'red';
  const status = check.statusCode === null ? 'no response' : `HTTP ${check.statusCode}`;
  const error = check.error ? `  ${singleLine(check.error)}` : '';
  return `${paint(color, `● ${kind.padEnd(8)}`, colors)}  ${new Date(check.checkedAt).toLocaleString()}  ${String(check.latencyMs).padStart(5)}ms  ${status}${error}`;
}

function monitorStatus(status: MonitorStatus) {
  if (status === 'healthy') return { color: 'green' as const, icon: '●' };
  if (status === 'suspect' || status === 'recovering') return { color: 'yellow' as const, icon: '●' };
  if (status === 'down') return { color: 'red' as const, icon: '●' };
  return { color: 'dim' as const, icon: '○' };
}

function projectStatus(status: ProjectSnapshot['status']) {
  if (status === 'healthy') return { color: 'green' as const, icon: '●' };
  if (status === 'degraded') return { color: 'yellow' as const, icon: '●' };
  if (status === 'down') return { color: 'red' as const, icon: '●' };
  return { color: 'dim' as const, icon: '○' };
}

function paint(color: keyof typeof ansi, value: string, enabled: boolean) {
  return enabled ? `${ansi[color]}${value}${ansi.reset}` : value;
}

function field(label: string, value: string) {
  return `  ${label.padEnd(14)} ${value}`;
}

function timestamp(value: number | null) {
  return value === null ? 'never' : `${new Date(value).toLocaleString()} (${relativeTime(value)})`;
}

function relativeTime(value: number | null) {
  if (value === null) return 'never';
  const seconds = Math.round((Date.now() - value) / 1_000);
  if (Math.abs(seconds) < 5) return 'now';
  if (Math.abs(seconds) < 60) return `${Math.abs(seconds)}s ${seconds > 0 ? 'ago' : 'from now'}`;
  const minutes = Math.round(Math.abs(seconds) / 60);
  if (minutes < 60) return `${minutes}m ${seconds > 0 ? 'ago' : 'from now'}`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ${seconds > 0 ? 'ago' : 'from now'}`;
}

function duration(milliseconds: number) {
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000}m`;
  if (milliseconds % 1_000 === 0) return `${milliseconds / 1_000}s`;
  return `${milliseconds}ms`;
}

function formatResolution(milliseconds: number) {
  return milliseconds === 0 ? 'individual checks' : duration(milliseconds);
}

function singleLine(value: string) {
  return value.replaceAll(/\s+/g, ' ').trim() || '(empty)';
}

export function summarizeChecks(checks: readonly Check[]) {
  const up = checks.filter((check) => check.successful && check.latencyMs < 1_000).length;
  const degraded = checks.filter((check) => check.successful && check.latencyMs >= 1_000).length;
  const failed = checks.length - up - degraded;
  return {
    total: checks.length,
    successful: up + degraded,
    up,
    degraded,
    failed,
    successRatePercent:
      checks.length === 0 ? 0 : Math.round((((up + degraded) / checks.length) * 100 + Number.EPSILON) * 100) / 100,
  };
}
