import { DurableObject, DurableObjectState } from 'alchemy/Cloudflare/Workers';
import type { RuntimeContext } from 'alchemy/RuntimeContext';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';

import type {
  AlertEvent,
  AlertID,
  AlertInput,
  AlertRule,
  AlertType,
  Check,
  CheckPage,
  MonitorConfig,
  MonitorSnapshot,
  MonitorStatus,
  ProbeResult,
  ProjectID,
  Timeline,
} from './domain.ts';
import { Notification } from './notification.ts';
import { Probe } from './probe.ts';
import { Project } from './project.ts';
import { transitionMonitor } from './state-machine.ts';

type MonitorRow = {
  readonly internal_id: string;
  readonly monitor_id: string;
  readonly project_id: ProjectID | null;
  readonly name: string;
  readonly url: string;
  readonly expected_status: number;
  readonly expected_body: string | null;
  readonly timeout_ms: number;
  readonly healthy_interval_ms: number;
  readonly suspect_interval_ms: number;
  readonly down_interval_ms: number;
  readonly recovering_interval_ms: number;
  readonly failure_threshold: number;
  readonly recovery_threshold: number;
  readonly alerts: number;
  readonly enabled: number;
  readonly status: MonitorStatus;
  readonly consecutive_failures: number;
  readonly consecutive_successes: number;
  readonly active_incident_id: string | null;
  readonly last_checked_at: number | null;
  readonly last_succeeded_at: number | null;
  readonly next_check_at: number | null;
  readonly updated_at: number;
};

type CheckRow = {
  readonly id: number;
  readonly checked_at: number;
  readonly successful: number;
  readonly status_code: number | null;
  readonly latency_ms: number;
  readonly error: string | null;
  readonly body: string | null;
};

type ActionRow = {
  readonly id: string;
  readonly incident_id: string;
  readonly kind: 'down' | 'recovered';
  readonly occurred_at: number;
  readonly error: string | null;
  readonly attempts: number;
  readonly alert_id: string | null;
  readonly alert_type: AlertType | null;
  readonly destination: string | null;
};

type AlertRow = {
  readonly id: string;
  readonly type: AlertType;
  readonly destination: string;
  readonly events: string;
  readonly enabled: number;
  readonly created_at: number;
  readonly updated_at: number;
};

export interface MonitorDurableObject {
  readonly upsert: (config: MonitorConfig) => Effect.Effect<MonitorSnapshot, never, RuntimeContext>;
  readonly status: () => Effect.Effect<MonitorSnapshot | null, never, RuntimeContext>;
  readonly history: (limit: number, cursor: number | null) => Effect.Effect<CheckPage, never, RuntimeContext>;
  readonly listAlerts: () => Effect.Effect<readonly AlertRule[], never, RuntimeContext>;
  readonly upsertAlert: (id: AlertID, input: AlertInput) => Effect.Effect<AlertRule, never, RuntimeContext>;
  readonly removeAlert: (id: AlertID) => Effect.Effect<boolean, never, RuntimeContext>;
  readonly setIdentity: (
    slug: MonitorConfig['slug'],
    projectID: ProjectID | null,
  ) => Effect.Effect<MonitorSnapshot | null, never, RuntimeContext>;
  readonly timeline: (since: number, until: number) => Effect.Effect<Timeline, never, RuntimeContext>;
  readonly checkNow: () => Effect.Effect<MonitorSnapshot | null, never, RuntimeContext>;
  readonly ensureScheduled: () => Effect.Effect<boolean, never, RuntimeContext>;
}

export class Monitor extends DurableObject<Monitor, MonitorDurableObject>()('UptimeMonitor') {}

export default Monitor.make(
  Effect.gen(function* () {
    const notification = yield* Notification;
    const probe = yield* Probe;
    const projects = yield* Project;

    return Effect.gen(function* () {
      const state = yield* DurableObjectState;
      yield* state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS monitor (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          internal_id TEXT NOT NULL,
          monitor_id TEXT NOT NULL,
          project_id TEXT,
          name TEXT NOT NULL,
          url TEXT NOT NULL,
          expected_status INTEGER NOT NULL,
          expected_body TEXT,
          timeout_ms INTEGER NOT NULL,
          healthy_interval_ms INTEGER NOT NULL,
          suspect_interval_ms INTEGER NOT NULL,
          down_interval_ms INTEGER NOT NULL,
          recovering_interval_ms INTEGER NOT NULL,
          failure_threshold INTEGER NOT NULL,
          recovery_threshold INTEGER NOT NULL,
          alerts INTEGER NOT NULL,
          enabled INTEGER NOT NULL,
          status TEXT NOT NULL,
          consecutive_failures INTEGER NOT NULL,
          consecutive_successes INTEGER NOT NULL,
          active_incident_id TEXT,
          last_checked_at INTEGER,
          last_succeeded_at INTEGER,
          next_check_at INTEGER,
          check_lease_until INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS checks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          checked_at INTEGER NOT NULL,
          successful INTEGER NOT NULL,
          status_code INTEGER,
          latency_ms INTEGER NOT NULL,
          error TEXT,
          body TEXT
        );
        CREATE INDEX IF NOT EXISTS checks_checked_at ON checks (checked_at DESC);
        CREATE TABLE IF NOT EXISTS incidents (
          id TEXT PRIMARY KEY,
          started_at INTEGER NOT NULL,
          recovered_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS actions (
          id TEXT PRIMARY KEY,
          incident_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          occurred_at INTEGER NOT NULL,
          error TEXT,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL,
          last_error TEXT,
          sent_at INTEGER,
          alert_id TEXT,
          alert_type TEXT,
          destination TEXT
        );
        CREATE TABLE IF NOT EXISTS alert_rules (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          destination TEXT NOT NULL,
          events TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS check_buckets (
          resolution_ms INTEGER NOT NULL,
          bucket_start INTEGER NOT NULL,
          samples INTEGER NOT NULL,
          up INTEGER NOT NULL,
          degraded INTEGER NOT NULL,
          failed INTEGER NOT NULL,
          latency_min_ms INTEGER NOT NULL,
          latency_sum_ms INTEGER NOT NULL,
          latency_max_ms INTEGER NOT NULL,
          PRIMARY KEY (resolution_ms, bucket_start)
        );
        CREATE TABLE IF NOT EXISTS status_intervals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          status TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER
        );
      `);

      const getStatus = Effect.fn('@UptimeMonitor/Monitor.status')(function* () {
        const rows = yield* (yield* state.storage.sql.exec<MonitorRow>('SELECT * FROM monitor WHERE id = 1')).toArray();
        return rows[0] ? snapshotFromRow(rows[0]) : null;
      });

      const history = Effect.fn('@UptimeMonitor/Monitor.history')(function* (limit: number, cursor: number | null) {
        const boundedLimit = Math.max(1, Math.min(limit, 500));
        const rows = yield* (yield* state.storage.sql.exec<CheckRow>(
          'SELECT * FROM checks WHERE id < ? ORDER BY id DESC LIMIT ?',
          cursor ?? Number.MAX_SAFE_INTEGER,
          boundedLimit + 1,
        )).toArray();
        return {
          items: rows.slice(0, boundedLimit).map(checkFromRow),
          page: {
            limit: boundedLimit,
            nextCursor: rows.length > boundedLimit ? String(rows[boundedLimit - 1]!.id) : null,
            hasMore: rows.length > boundedLimit,
          },
        } satisfies CheckPage;
      });

      const timeline = Effect.fn('@UptimeMonitor/Monitor.timeline')(function* (since: number, until: number) {
        const range = until - since;
        const resolutionMs =
          range <= 7 * 86_400_000
            ? 0
            : range <= 30 * 86_400_000
              ? 300_000
              : range <= 90 * 86_400_000
                ? 900_000
                : 3_600_000;
        const points =
          resolutionMs === 0
            ? (yield* (yield* state.storage.sql.exec<CheckRow>(
                'SELECT * FROM checks WHERE checked_at BETWEEN ? AND ? ORDER BY checked_at LIMIT 10000',
                since,
                until,
              )).toArray()).map((check) => ({
                startedAt: check.checked_at,
                endedAt: check.checked_at,
                resolutionMs: 0,
                samples: 1,
                up: check.successful === 1 && check.latency_ms < 1_000 ? 1 : 0,
                degraded: check.successful === 1 && check.latency_ms >= 1_000 ? 1 : 0,
                failed: check.successful === 0 ? 1 : 0,
                latencyMinMs: check.latency_ms,
                latencyAverageMs: check.latency_ms,
                latencyMaxMs: check.latency_ms,
              }))
            : (yield* (yield* state.storage.sql.exec<{
                readonly bucket_start: number;
                readonly samples: number;
                readonly up: number;
                readonly degraded: number;
                readonly failed: number;
                readonly latency_min_ms: number;
                readonly latency_sum_ms: number;
                readonly latency_max_ms: number;
              }>(
                'SELECT * FROM check_buckets WHERE resolution_ms = ? AND bucket_start BETWEEN ? AND ? ORDER BY bucket_start',
                resolutionMs,
                since,
                until,
              )).toArray()).map((bucket) => ({
                startedAt: bucket.bucket_start,
                endedAt: bucket.bucket_start + resolutionMs,
                resolutionMs,
                samples: bucket.samples,
                up: bucket.up,
                degraded: bucket.degraded,
                failed: bucket.failed,
                latencyMinMs: bucket.latency_min_ms,
                latencyAverageMs: bucket.latency_sum_ms / bucket.samples,
                latencyMaxMs: bucket.latency_max_ms,
              }));
        const intervals = yield* (yield* state.storage.sql.exec<{
          readonly status: 'up' | 'degraded' | 'failed';
          readonly started_at: number;
          readonly ended_at: number | null;
        }>(
          'SELECT status, started_at, ended_at FROM status_intervals WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at',
          until,
          since,
        )).toArray();
        const anomalies = yield* (yield* state.storage.sql.exec<CheckRow>(
          `SELECT * FROM checks WHERE checked_at BETWEEN ? AND ?
           AND (successful = 0 OR latency_ms >= 1000) ORDER BY checked_at DESC LIMIT 500`,
          since,
          until,
        )).toArray();
        return {
          resolutionMs,
          points,
          intervals: intervals.map((interval) => ({
            status: interval.status,
            startedAt: interval.started_at,
            endedAt: interval.ended_at,
          })),
          anomalies: anomalies.map(checkFromRow),
        } satisfies Timeline;
      });

      const getAlertRows = Effect.fn('@UptimeMonitor/Monitor.alertRows')(function* () {
        return yield* (yield* state.storage.sql.exec<AlertRow>('SELECT * FROM alert_rules ORDER BY id')).toArray();
      });

      const listAlerts = Effect.fn('@UptimeMonitor/Monitor.listAlerts')(function* () {
        return (yield* getAlertRows()).map(alertFromRow);
      });

      const upsertAlert = Effect.fn('@UptimeMonitor/Monitor.upsertAlert')(function* (
        id: AlertID,
        input: AlertInput,
      ) {
        const now = Date.now();
        yield* state.storage.sql.exec(
          `INSERT INTO alert_rules (id, type, destination, events, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET type = excluded.type, destination = excluded.destination,
             events = excluded.events, enabled = excluded.enabled, updated_at = excluded.updated_at`,
          id,
          input.type,
          input.destination,
          [...new Set(input.events)].join(','),
          input.enabled === false ? 0 : 1,
          now,
          now,
        );
        yield* state.storage.sql.exec('UPDATE monitor SET alerts = 1, updated_at = ? WHERE id = 1', now);
        const rows = yield* (yield* state.storage.sql.exec<AlertRow>(
          'SELECT * FROM alert_rules WHERE id = ?',
          id,
        )).toArray();
        return alertFromRow(rows[0]!);
      });

      const removeAlert = Effect.fn('@UptimeMonitor/Monitor.removeAlert')(function* (id: AlertID) {
        const rows = yield* (yield* state.storage.sql.exec<{ readonly id: string }>(
          'DELETE FROM alert_rules WHERE id = ? RETURNING id',
          id,
        )).toArray();
        return rows.length > 0;
      });

      const processActions = Effect.fn('@UptimeMonitor/Monitor.processActions')(function* (config: MonitorConfig) {
        const actions = yield* (yield* state.storage.sql.exec<ActionRow>(
          `SELECT id, incident_id, kind, occurred_at, error, attempts, alert_id, alert_type, destination
           FROM actions
           WHERE status != 'sent' AND next_attempt_at <= ?
           ORDER BY occurred_at
           LIMIT 5`,
          Date.now(),
        )).toArray();

        yield* Effect.forEach(actions, (action) => {
          const destination = action.destination;
          if (!destination) {
            const attempts = action.attempts + 1;
            return state.storage.sql
              .exec(
                `UPDATE actions
                 SET status = 'failed', attempts = ?, next_attempt_at = ?, last_error = ?
                 WHERE id = ?`,
                attempts,
                Date.now() + Math.min(300_000, 30_000 * 2 ** Math.min(attempts - 1, 4)),
                'Alert destination is empty or missing.',
                action.id,
              )
              .pipe(
                Effect.andThen(
                  Effect.logError('uptime_notification_failed', {
                    monitorID: config.slug,
                    actionID: action.id,
                    attempts,
                  }),
                ),
              );
          }
          return notification
            .send({
              actionID: action.id,
              monitorID: config.slug,
              monitorName: config.name,
              incidentID: action.incident_id,
              kind: action.kind,
              url: config.url,
              occurredAt: action.occurred_at,
              error: action.error,
              alert: {
                type: action.alert_type ?? 'email',
                destination,
              },
            })
            .pipe(
              Effect.as({ sent: true as const }),
              Effect.catch((error) => Effect.succeed({ sent: false as const, error })),
              Effect.flatMap((outcome) => {
                if (outcome.sent) {
                  return state.storage.sql.exec(
                    `UPDATE actions SET status = 'sent', attempts = attempts + 1, sent_at = ?, last_error = NULL
                     WHERE id = ?`,
                    Date.now(),
                    action.id,
                  );
                }

                const attempts = action.attempts + 1;
                return state.storage.sql
                  .exec(
                    `UPDATE actions
                     SET status = 'failed', attempts = ?, next_attempt_at = ?, last_error = ?
                     WHERE id = ?`,
                    attempts,
                    Date.now() + Math.min(300_000, 30_000 * 2 ** Math.min(attempts - 1, 4)),
                    String(outcome.error.cause).slice(0, 1_024),
                    action.id,
                  )
                  .pipe(
                    Effect.andThen(
                      Effect.logError('uptime_notification_failed', {
                        monitorID: config.slug,
                        actionID: action.id,
                        attempts,
                      }),
                    ),
                  );
              }),
            );
        });
      });

      const persistResult = Effect.fn('@UptimeMonitor/Monitor.persistResult')(function* (
        current: MonitorSnapshot,
        result: ProbeResult,
      ) {
        const transition = transitionMonitor(current.config, current, result, crypto.randomUUID());
        const nextCheckAt = result.checkedAt + transition.nextCheckInMs;

        yield* state.storage.sql.exec(
          `INSERT INTO checks (checked_at, successful, status_code, latency_ms, error, body)
           VALUES (?, ?, ?, ?, ?, ?)`,
          result.checkedAt,
          result.successful ? 1 : 0,
          result.statusCode,
          result.latencyMs,
          result.error,
          result.body,
        );
        const checkStatus = result.successful ? (result.latencyMs >= 1_000 ? 'degraded' : 'up') : 'failed';
        yield* Effect.forEach([300_000, 900_000, 3_600_000], (resolutionMs) =>
          state.storage.sql.exec(
            `INSERT INTO check_buckets
               (resolution_ms, bucket_start, samples, up, degraded, failed, latency_min_ms, latency_sum_ms, latency_max_ms)
             VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(resolution_ms, bucket_start) DO UPDATE SET
               samples = samples + 1, up = up + excluded.up, degraded = degraded + excluded.degraded,
               failed = failed + excluded.failed, latency_min_ms = MIN(latency_min_ms, excluded.latency_min_ms),
               latency_sum_ms = latency_sum_ms + excluded.latency_sum_ms,
               latency_max_ms = MAX(latency_max_ms, excluded.latency_max_ms)`,
            resolutionMs,
            Math.floor(result.checkedAt / resolutionMs) * resolutionMs,
            checkStatus === 'up' ? 1 : 0,
            checkStatus === 'degraded' ? 1 : 0,
            checkStatus === 'failed' ? 1 : 0,
            result.latencyMs,
            result.latencyMs,
            result.latencyMs,
          ),
        );
        const openIntervals = yield* (yield* state.storage.sql.exec<{
          readonly id: number;
          readonly status: string;
        }>('SELECT id, status FROM status_intervals WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1')).toArray();
        if (openIntervals[0]?.status !== checkStatus) {
          yield* state.storage.sql.exec(
            'UPDATE status_intervals SET ended_at = ? WHERE ended_at IS NULL',
            result.checkedAt,
          );
          yield* state.storage.sql.exec(
            'INSERT INTO status_intervals (status, started_at, ended_at) VALUES (?, ?, NULL)',
            checkStatus,
            result.checkedAt,
          );
        }
        yield* state.storage.sql.exec(
          `UPDATE monitor SET
             status = ?, consecutive_failures = ?, consecutive_successes = ?, active_incident_id = ?,
             last_checked_at = ?, last_succeeded_at = ?, next_check_at = ?, check_lease_until = 0, updated_at = ?
           WHERE id = 1`,
          transition.status,
          transition.consecutiveFailures,
          transition.consecutiveSuccesses,
          transition.activeIncidentID,
          result.checkedAt,
          result.successful ? result.checkedAt : current.lastSucceededAt,
          nextCheckAt,
          Date.now(),
        );

        if (transition.openedIncidentID) {
          yield* state.storage.sql.exec(
            'INSERT OR IGNORE INTO incidents (id, started_at) VALUES (?, ?)',
            transition.openedIncidentID,
            result.checkedAt,
          );
          if (current.config.alerts) {
            yield* insertActions(transition.openedIncidentID, 'down', result);
          }
        }

        if (transition.recoveredIncidentID) {
          yield* state.storage.sql.exec(
            'UPDATE incidents SET recovered_at = ? WHERE id = ?',
            result.checkedAt,
            transition.recoveredIncidentID,
          );
          if (current.config.alerts) {
            yield* insertActions(transition.recoveredIncidentID, 'recovered', result);
          }
        }

        yield* state.storage.sql.exec(
          'DELETE FROM checks WHERE checked_at < ? AND successful = 1 AND latency_ms < 1000',
          Date.now() - 7 * 86_400_000,
        );
        yield* state.storage.sql.exec(
          'DELETE FROM check_buckets WHERE resolution_ms = 300000 AND bucket_start < ?',
          Date.now() - 30 * 86_400_000,
        );
        yield* state.storage.sql.exec(
          'DELETE FROM check_buckets WHERE resolution_ms = 900000 AND bucket_start < ?',
          Date.now() - 90 * 86_400_000,
        );
        yield* state.storage.setAlarm(nextCheckAt);
        yield* processActions(current.config);
        const snapshot = (yield* getStatus())!;
        if (snapshot.config.projectID !== null) {
          yield* projects
            .getByName(snapshot.config.projectID)
            .report(snapshot.config.internalID, snapshot.config.slug, snapshot)
            .pipe(Effect.orDie);
        }
        return snapshot;
      });

      const insertActions = Effect.fn('@UptimeMonitor/Monitor.insertActions')(function* (
        incidentID: string,
        kind: ActionRow['kind'],
        result: ProbeResult,
      ) {
        const alerts = (yield* getAlertRows()).filter(
          (alert) => alert.enabled === 1 && parseAlertEvents(alert.events).includes(kind),
        );
        yield* Effect.forEach(alerts, (alert) =>
          state.storage.sql.exec(
            `INSERT OR IGNORE INTO actions
               (id, incident_id, kind, occurred_at, error, status, next_attempt_at, alert_id, alert_type, destination)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
            `${incidentID}:${kind}:${alert.id}`,
            incidentID,
            kind,
            result.checkedAt,
            result.error,
            result.checkedAt,
            alert.id,
            alert.type,
            alert.destination,
          ),
        );
      });

      const runCheck = Effect.fn('@UptimeMonitor/Monitor.runCheck')(function* () {
        const current = yield* getStatus();
        if (!current || !current.config.enabled) return current;

        const lease = yield* (yield* state.storage.sql.exec<{ readonly monitor_id: string }>(
          `UPDATE monitor SET check_lease_until = ?
           WHERE id = 1 AND enabled = 1 AND check_lease_until < ?
           RETURNING monitor_id`,
          Date.now() + current.config.timeoutMs + 5_000,
          Date.now(),
        )).toArray();
        if (lease.length === 0) return yield* getStatus();

        const result = yield* probe.check(current.config);
        const latest = yield* getStatus();
        if (!latest || !latest.config.enabled) {
          yield* state.storage.deleteAlarm();
          return latest;
        }

        return yield* persistResult(latest, result);
      });

      const upsert = Effect.fn('@UptimeMonitor/Monitor.upsert')(function* (config: MonitorConfig) {
        const now = Date.now();
        yield* state.storage.sql.exec(
          `INSERT INTO monitor (
             id, internal_id, monitor_id, project_id, name, url, expected_status, expected_body, timeout_ms,
             healthy_interval_ms, suspect_interval_ms, down_interval_ms, recovering_interval_ms,
             failure_threshold, recovery_threshold, alerts, enabled, status,
             consecutive_failures, consecutive_successes, next_check_at, updated_at
           ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             internal_id = excluded.internal_id, monitor_id = excluded.monitor_id,
             project_id = excluded.project_id, name = excluded.name, url = excluded.url,
             expected_status = excluded.expected_status, expected_body = excluded.expected_body,
             timeout_ms = excluded.timeout_ms, healthy_interval_ms = excluded.healthy_interval_ms,
             suspect_interval_ms = excluded.suspect_interval_ms, down_interval_ms = excluded.down_interval_ms,
             recovering_interval_ms = excluded.recovering_interval_ms,
             failure_threshold = excluded.failure_threshold, recovery_threshold = excluded.recovery_threshold,
             alerts = excluded.alerts, enabled = excluded.enabled,
             status = CASE
               WHEN excluded.enabled = 0 THEN 'disabled'
               WHEN monitor.status = 'disabled' THEN 'uninitialized'
               ELSE monitor.status
             END,
             consecutive_failures = CASE WHEN excluded.enabled = 0 THEN 0 ELSE monitor.consecutive_failures END,
             consecutive_successes = CASE WHEN excluded.enabled = 0 THEN 0 ELSE monitor.consecutive_successes END,
             active_incident_id = CASE WHEN excluded.enabled = 0 THEN NULL ELSE monitor.active_incident_id END,
             next_check_at = excluded.next_check_at, check_lease_until = 0, updated_at = excluded.updated_at`,
          config.internalID,
          config.slug,
          config.projectID,
          config.name,
          config.url,
          config.expectedStatus,
          config.expectedBody,
          config.timeoutMs,
          config.healthyIntervalMs,
          config.suspectIntervalMs,
          config.downIntervalMs,
          config.recoveringIntervalMs,
          config.failureThreshold,
          config.recoveryThreshold,
          config.alerts ? 1 : 0,
          config.enabled ? 1 : 0,
          config.enabled ? 'uninitialized' : 'disabled',
          config.enabled ? now + 1_000 : null,
          now,
        );

        if (config.enabled) yield* state.storage.setAlarm(now + 1_000);
        if (!config.enabled) yield* state.storage.deleteAlarm();
        return (yield* getStatus())!;
      });

      const ensureScheduled = Effect.fn('@UptimeMonitor/Monitor.ensureScheduled')(function* () {
        const current = yield* getStatus();
        if (!current || !current.config.enabled) return false;

        const alarm = yield* state.storage.getAlarm();
        if (alarm !== null && alarm >= Date.now() - 60_000 && alarm <= Date.now() + 600_000) return false;

        const nextCheckAt = Date.now() + 1_000;
        yield* state.storage.sql.exec('UPDATE monitor SET next_check_at = ? WHERE id = 1', nextCheckAt);
        yield* state.storage.setAlarm(nextCheckAt);
        return true;
      });

      const setIdentity = Effect.fn('@UptimeMonitor/Monitor.setIdentity')(function* (
        slug: MonitorConfig['slug'],
        projectID: ProjectID | null,
      ) {
        yield* state.storage.sql.exec(
          'UPDATE monitor SET monitor_id = ?, project_id = ?, updated_at = ? WHERE id = 1',
          slug,
          projectID,
          Date.now(),
        );
        return yield* getStatus();
      });

      const result: MonitorDurableObject & {
        readonly alarm: () => Effect.Effect<void, never, RuntimeContext>;
      } = {
        upsert,
        status: getStatus,
        history,
        listAlerts,
        upsertAlert,
        removeAlert,
        setIdentity,
        timeline,
        checkNow: runCheck,
        ensureScheduled,
        alarm: () =>
          runCheck().pipe(
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Effect.logError('uptime_alarm_failed', { cause: Cause.pretty(cause) }).pipe(
                Effect.andThen(state.storage.setAlarm(Date.now() + 60_000)),
              ),
            ),
          ),
      };
      return result;
    });
  }),
);

function snapshotFromRow(row: MonitorRow): MonitorSnapshot {
  return {
    config: {
      internalID: row.internal_id,
      slug: row.monitor_id,
      projectID: row.project_id,
      name: row.name,
      url: row.url,
      expectedStatus: row.expected_status,
      expectedBody: row.expected_body,
      timeoutMs: row.timeout_ms,
      healthyIntervalMs: row.healthy_interval_ms,
      suspectIntervalMs: row.suspect_interval_ms,
      downIntervalMs: row.down_interval_ms,
      recoveringIntervalMs: row.recovering_interval_ms,
      failureThreshold: row.failure_threshold,
      recoveryThreshold: row.recovery_threshold,
      alerts: row.alerts === 1,
      enabled: row.enabled === 1,
    },
    status: row.status,
    consecutiveFailures: row.consecutive_failures,
    consecutiveSuccesses: row.consecutive_successes,
    activeIncidentID: row.active_incident_id,
    lastCheckedAt: row.last_checked_at,
    lastSucceededAt: row.last_succeeded_at,
    nextCheckAt: row.next_check_at,
    updatedAt: row.updated_at,
  };
}

function checkFromRow(row: CheckRow): Check {
  return {
    id: row.id,
    checkedAt: row.checked_at,
    successful: row.successful === 1,
    statusCode: row.status_code,
    latencyMs: row.latency_ms,
    error: row.error,
    body: row.body,
  };
}

function alertFromRow(row: AlertRow): AlertRule {
  return {
    id: row.id,
    type: row.type,
    destination: maskDestination(row.type, row.destination),
    events: parseAlertEvents(row.events),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseAlertEvents(value: string): readonly AlertEvent[] {
  return value.split(',').filter((event): event is AlertEvent => event === 'down' || event === 'recovered');
}

function maskDestination(type: AlertType, destination: string) {
  if (type === 'email') return destination;
  const url = new URL(destination);
  return `${url.protocol}//${url.host}/••••`;
}
