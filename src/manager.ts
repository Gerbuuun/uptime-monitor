import type { RuntimeContext } from 'alchemy/RuntimeContext';
import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';

import type {
  AlertID,
  AlertInput,
  AlertRule,
  CheckPage,
  DiscoveryResult,
  MonitorID,
  MonitorInput,
  MonitorPage,
  MonitorSnapshot,
  ProjectID,
  ProjectSnapshot,
  Timeline,
} from './domain.ts';

export interface MonitorManagerShape {
  readonly upsert: (id: MonitorID, input: MonitorInput) => Effect.Effect<MonitorSnapshot, never, RuntimeContext>;
  readonly discover: (url: string, timeoutMs: number) => Effect.Effect<DiscoveryResult, never, RuntimeContext>;
  readonly list: (
    limit: number,
    cursor: MonitorID | null,
    projectID: ProjectID | null,
  ) => Effect.Effect<MonitorPage, never, RuntimeContext>;
  readonly status: (id: MonitorID) => Effect.Effect<MonitorSnapshot | null, never, RuntimeContext>;
  readonly history: (
    id: MonitorID,
    limit: number,
    cursor: number | null,
  ) => Effect.Effect<CheckPage, never, RuntimeContext>;
  readonly listAlerts: (id: MonitorID) => Effect.Effect<readonly AlertRule[], never, RuntimeContext>;
  readonly upsertAlert: (
    id: MonitorID,
    alertID: AlertID,
    input: AlertInput,
  ) => Effect.Effect<AlertRule, never, RuntimeContext>;
  readonly removeAlert: (id: MonitorID, alertID: AlertID) => Effect.Effect<boolean, never, RuntimeContext>;
  readonly rename: (
    id: MonitorID,
    nextID: MonitorID,
    projectID: ProjectID | null | undefined,
  ) => Effect.Effect<MonitorSnapshot | null, never, RuntimeContext>;
  readonly timeline: (
    id: MonitorID,
    since: number,
    until: number,
  ) => Effect.Effect<Timeline | null, never, RuntimeContext>;
  readonly upsertProject: (id: ProjectID, name: string) => Effect.Effect<ProjectSnapshot, never, RuntimeContext>;
  readonly listProjects: () => Effect.Effect<readonly ProjectSnapshot[], never, RuntimeContext>;
  readonly projectStatus: (id: ProjectID) => Effect.Effect<ProjectSnapshot | null, never, RuntimeContext>;
  readonly check: (id: MonitorID) => Effect.Effect<MonitorSnapshot | null, never, RuntimeContext>;
  readonly supervise: () => Effect.Effect<number, never, RuntimeContext>;
}

export class MonitorManager extends Context.Service<MonitorManager, MonitorManagerShape>()(
  '@UptimeMonitor/MonitorManager',
) {}
