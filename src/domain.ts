import * as Schema from 'effect/Schema';

const Milliseconds = Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 86_400_000 }));
const Threshold = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }));

export const MonitorID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/));
export type MonitorID = typeof MonitorID.Type;
export const ProjectID = MonitorID;
export type ProjectID = typeof ProjectID.Type;

export const MonitorStatus = Schema.Literals(['uninitialized', 'healthy', 'suspect', 'down', 'recovering', 'disabled']);
export type MonitorStatus = typeof MonitorStatus.Type;

export const MonitorInput = Schema.Struct({
  name: Schema.NonEmptyString,
  url: Schema.String.check(Schema.isPattern(/^https?:\/\//)),
  expectedStatus: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
  expectedBody: Schema.optional(Schema.NullOr(Schema.String)),
  timeoutMs: Schema.optional(Milliseconds),
  healthyIntervalMs: Schema.optional(Milliseconds),
  suspectIntervalMs: Schema.optional(Milliseconds),
  downIntervalMs: Schema.optional(Milliseconds),
  recoveringIntervalMs: Schema.optional(Milliseconds),
  failureThreshold: Schema.optional(Threshold),
  recoveryThreshold: Schema.optional(Threshold),
  alerts: Schema.optional(Schema.Boolean),
  enabled: Schema.optional(Schema.Boolean),
  projectID: Schema.optional(Schema.NullOr(ProjectID)),
});
export type MonitorInput = typeof MonitorInput.Type;

export const MonitorConfig = Schema.Struct({
  internalID: Schema.String,
  slug: MonitorID,
  projectID: Schema.NullOr(ProjectID),
  name: Schema.NonEmptyString,
  url: Schema.String,
  expectedStatus: Schema.Int,
  expectedBody: Schema.NullOr(Schema.String),
  timeoutMs: Schema.Int,
  healthyIntervalMs: Schema.Int,
  suspectIntervalMs: Schema.Int,
  downIntervalMs: Schema.Int,
  recoveringIntervalMs: Schema.Int,
  failureThreshold: Schema.Int,
  recoveryThreshold: Schema.Int,
  alerts: Schema.Boolean,
  enabled: Schema.Boolean,
});
export type MonitorConfig = typeof MonitorConfig.Type;

export const MonitorSnapshot = Schema.Struct({
  config: MonitorConfig,
  status: MonitorStatus,
  consecutiveFailures: Schema.Int,
  consecutiveSuccesses: Schema.Int,
  activeIncidentID: Schema.NullOr(Schema.String),
  lastCheckedAt: Schema.NullOr(Schema.Int),
  lastSucceededAt: Schema.NullOr(Schema.Int),
  nextCheckAt: Schema.NullOr(Schema.Int),
  updatedAt: Schema.Int,
});
export type MonitorSnapshot = typeof MonitorSnapshot.Type;

export const Check = Schema.Struct({
  id: Schema.Int,
  checkedAt: Schema.Int,
  successful: Schema.Boolean,
  statusCode: Schema.NullOr(Schema.Int),
  latencyMs: Schema.Int,
  error: Schema.NullOr(Schema.String),
  body: Schema.NullOr(Schema.String),
});
export type Check = typeof Check.Type;

export const MonitorHistory = Schema.Array(Check);
export const MonitorList = Schema.Array(MonitorSnapshot);

export const Page = Schema.Struct({
  limit: Schema.Int,
  nextCursor: Schema.NullOr(Schema.String),
  hasMore: Schema.Boolean,
});

export const MonitorPage = Schema.Struct({ items: MonitorList, page: Page });
export type MonitorPage = typeof MonitorPage.Type;

export const CheckPage = Schema.Struct({ items: MonitorHistory, page: Page });
export type CheckPage = typeof CheckPage.Type;

export const AlertID = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/));
export type AlertID = typeof AlertID.Type;
export const AlertType = Schema.Literals(['email', 'webhook']);
export type AlertType = typeof AlertType.Type;
export const AlertEvent = Schema.Literals(['down', 'recovered']);
export type AlertEvent = typeof AlertEvent.Type;
export const AlertInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('email'),
    destination: Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
    events: Schema.Array(AlertEvent).check(Schema.isMinLength(1)),
    enabled: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal('webhook'),
    destination: Schema.String.check(Schema.isPattern(/^https:\/\//)),
    events: Schema.Array(AlertEvent).check(Schema.isMinLength(1)),
    enabled: Schema.optional(Schema.Boolean),
  }),
]);
export type AlertInput = typeof AlertInput.Type;
export const AlertRule = Schema.Struct({
  id: AlertID,
  type: AlertType,
  destination: Schema.String,
  events: Schema.Array(AlertEvent),
  enabled: Schema.Boolean,
  createdAt: Schema.Int,
  updatedAt: Schema.Int,
});
export type AlertRule = typeof AlertRule.Type;
export const AlertList = Schema.Array(AlertRule);

export const MonitorIdentity = Schema.Struct({
  internalID: Schema.String,
  slug: MonitorID,
  projectID: Schema.NullOr(ProjectID),
});
export type MonitorIdentity = typeof MonitorIdentity.Type;

export const RenameMonitor = Schema.Struct({
  slug: MonitorID,
  projectID: Schema.optional(Schema.NullOr(ProjectID)),
});

export const ProjectInput = Schema.Struct({ name: Schema.NonEmptyString });
export const ProjectStatus = Schema.Literals(['healthy', 'degraded', 'down', 'unknown']);
export const ProjectSnapshot = Schema.Struct({
  id: ProjectID,
  name: Schema.NonEmptyString,
  status: ProjectStatus,
  monitors: Schema.Array(
    Schema.Struct({
      internalID: Schema.String,
      slug: MonitorID,
      status: MonitorStatus,
      lastCheckedAt: Schema.NullOr(Schema.Int),
      updatedAt: Schema.Int,
    }),
  ),
  createdAt: Schema.Int,
  updatedAt: Schema.Int,
});
export type ProjectSnapshot = typeof ProjectSnapshot.Type;
export const ProjectList = Schema.Array(ProjectSnapshot);

export const TimelinePoint = Schema.Struct({
  startedAt: Schema.Int,
  endedAt: Schema.Int,
  resolutionMs: Schema.Int,
  samples: Schema.Int,
  up: Schema.Int,
  degraded: Schema.Int,
  failed: Schema.Int,
  latencyMinMs: Schema.Int,
  latencyAverageMs: Schema.Number,
  latencyMaxMs: Schema.Int,
});
export const StatusInterval = Schema.Struct({
  status: Schema.Literals(['up', 'degraded', 'failed']),
  startedAt: Schema.Int,
  endedAt: Schema.NullOr(Schema.Int),
});
export const Timeline = Schema.Struct({
  resolutionMs: Schema.Int,
  points: Schema.Array(TimelinePoint),
  intervals: Schema.Array(StatusInterval),
  anomalies: MonitorHistory,
});
export type Timeline = typeof Timeline.Type;

export const DiscoveryInput = Schema.Struct({
  url: Schema.String.check(Schema.isPattern(/^https?:\/\//)),
  timeoutMs: Schema.optional(Milliseconds),
});
export const DiscoveryResult = Schema.Struct({
  checkedAt: Schema.Int,
  reachable: Schema.Boolean,
  statusCode: Schema.NullOr(Schema.Int),
  latencyMs: Schema.Int,
  contentType: Schema.NullOr(Schema.String),
  body: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  suggestedStatus: Schema.Int,
  suggestedBody: Schema.NullOr(Schema.String),
});
export type DiscoveryResult = typeof DiscoveryResult.Type;

export const UpsertMonitor = Schema.Struct({
  params: Schema.Struct({ slug: MonitorID }),
  payload: MonitorInput,
});

export const MonitorParams = Schema.Struct({ slug: MonitorID });
export const AlertParams = Schema.Struct({ slug: MonitorID, alertID: AlertID });
export const ProjectParams = Schema.Struct({ id: ProjectID });
export const ListQuery = Schema.Struct({
  limit: Schema.optional(Schema.NumberFromString.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 500 })))),
  cursor: Schema.optional(MonitorID),
  project: Schema.optional(ProjectID),
});
export const HistoryQuery = Schema.Struct({
  limit: Schema.optional(Schema.NumberFromString.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 500 })))),
  cursor: Schema.optional(Schema.NumberFromString.pipe(Schema.check(Schema.isGreaterThan(0)))),
});
export const TimelineQuery = Schema.Struct({
  since: Schema.NumberFromString.pipe(Schema.check(Schema.isGreaterThan(0))),
  until: Schema.optional(Schema.NumberFromString.pipe(Schema.check(Schema.isGreaterThan(0)))),
});

export interface ProbeResult {
  readonly checkedAt: number;
  readonly successful: boolean;
  readonly statusCode: number | null;
  readonly latencyMs: number;
  readonly error: string | null;
  readonly body: string | null;
}

export interface TransitionState {
  readonly status: MonitorStatus;
  readonly consecutiveFailures: number;
  readonly consecutiveSuccesses: number;
  readonly activeIncidentID: string | null;
}

export interface MonitorTransition extends TransitionState {
  readonly openedIncidentID: string | null;
  readonly recoveredIncidentID: string | null;
  readonly nextCheckInMs: number;
}

export function normalizeSlug(value: string) {
  return value.toLowerCase();
}

export function normalizeMonitor(internalID: string, slug: MonitorID, input: MonitorInput): MonitorConfig {
  return {
    internalID,
    slug,
    projectID: input.projectID ?? null,
    name: input.name,
    url: input.url,
    expectedStatus: input.expectedStatus ?? 200,
    expectedBody: input.expectedBody ?? null,
    timeoutMs: input.timeoutMs ?? 10_000,
    healthyIntervalMs: input.healthyIntervalMs ?? 60_000,
    suspectIntervalMs: input.suspectIntervalMs ?? 15_000,
    downIntervalMs: input.downIntervalMs ?? 60_000,
    recoveringIntervalMs: input.recoveringIntervalMs ?? 15_000,
    failureThreshold: input.failureThreshold ?? 2,
    recoveryThreshold: input.recoveryThreshold ?? 2,
    alerts: input.alerts ?? true,
    enabled: input.enabled ?? true,
  };
}
