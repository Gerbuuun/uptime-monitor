import { DurableObject, DurableObjectState } from 'alchemy/Cloudflare/Workers';
import type { RuntimeContext } from 'alchemy/RuntimeContext';
import * as Effect from 'effect/Effect';

import type { MonitorSnapshot, ProjectID, ProjectSnapshot } from './domain.ts';

type ProjectRow = {
  readonly id: ProjectID;
  readonly name: string;
  readonly created_at: number;
  readonly updated_at: number;
};
type MemberRow = {
  readonly internal_id: string;
  readonly slug: string;
  readonly status: MonitorSnapshot['status'];
  readonly last_checked_at: number | null;
  readonly updated_at: number;
};

export interface ProjectDurableObject {
  readonly upsert: (id: ProjectID, name: string) => Effect.Effect<ProjectSnapshot, never, RuntimeContext>;
  readonly status: () => Effect.Effect<ProjectSnapshot | null, never, RuntimeContext>;
  readonly reconcile: (
    monitors: readonly { readonly internalID: string; readonly slug: string; readonly snapshot: MonitorSnapshot }[],
  ) => Effect.Effect<ProjectSnapshot | null, never, RuntimeContext>;
  readonly report: (
    internalID: string,
    slug: string,
    snapshot: MonitorSnapshot,
  ) => Effect.Effect<void, never, RuntimeContext>;
}

export class Project extends DurableObject<Project, ProjectDurableObject>()('UptimeProject') {}

export default Project.make(
  Effect.succeed(
    Effect.gen(function* () {
      const state = yield* DurableObjectState;
      yield* state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS project (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS members (
          internal_id TEXT PRIMARY KEY,
          slug TEXT NOT NULL,
          status TEXT NOT NULL,
          last_checked_at INTEGER,
          updated_at INTEGER NOT NULL
        );
      `);

      const getStatus = Effect.fn('@UptimeMonitor/Project.status')(function* () {
        const projects = yield* (yield* state.storage.sql.exec<ProjectRow>('SELECT * FROM project LIMIT 1')).toArray();
        if (!projects[0]) return null;
        const members = yield* (yield* state.storage.sql.exec<MemberRow>(
          'SELECT * FROM members ORDER BY slug',
        )).toArray();
        return {
          id: projects[0].id,
          name: projects[0].name,
          status: projectStatus(members),
          monitors: members.map((member) => ({
            internalID: member.internal_id,
            slug: member.slug,
            status: member.status,
            lastCheckedAt: member.last_checked_at,
            updatedAt: member.updated_at,
          })),
          createdAt: projects[0].created_at,
          updatedAt: projects[0].updated_at,
        } satisfies ProjectSnapshot;
      });

      return {
        upsert: Effect.fn('@UptimeMonitor/Project.upsert')(function* (id: ProjectID, name: string) {
          const now = Date.now();
          yield* state.storage.sql.exec(
            `INSERT INTO project (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
            id,
            name,
            now,
            now,
          );
          return (yield* getStatus())!;
        }),
        status: getStatus,
        reconcile: Effect.fn('@UptimeMonitor/Project.reconcile')(function* (monitors) {
          yield* state.storage.sql.exec('DELETE FROM members');
          yield* Effect.forEach(monitors, (monitor) =>
            state.storage.sql.exec(
              'INSERT INTO members (internal_id, slug, status, last_checked_at, updated_at) VALUES (?, ?, ?, ?, ?)',
              monitor.internalID,
              monitor.slug,
              monitor.snapshot.status,
              monitor.snapshot.lastCheckedAt,
              monitor.snapshot.updatedAt,
            ),
          );
          yield* state.storage.sql.exec('UPDATE project SET updated_at = ?', Date.now());
          return yield* getStatus();
        }),
        report: Effect.fn('@UptimeMonitor/Project.report')(function* (internalID, slug, snapshot) {
          yield* state.storage.sql.exec(
            `INSERT INTO members (internal_id, slug, status, last_checked_at, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(internal_id) DO UPDATE SET slug = excluded.slug, status = excluded.status,
               last_checked_at = excluded.last_checked_at, updated_at = excluded.updated_at`,
            internalID,
            slug,
            snapshot.status,
            snapshot.lastCheckedAt,
            snapshot.updatedAt,
          );
          yield* state.storage.sql.exec('UPDATE project SET updated_at = ?', Date.now());
        }),
      } satisfies ProjectDurableObject;
    }),
  ),
);

function projectStatus(members: readonly MemberRow[]): ProjectSnapshot['status'] {
  const active = members.filter((member) => member.status !== 'disabled');
  if (active.length === 0 || active.some((member) => member.status === 'uninitialized')) return 'unknown';
  if (active.some((member) => member.status === 'down')) return 'down';
  if (active.some((member) => member.status === 'suspect' || member.status === 'recovering')) return 'degraded';
  return 'healthy';
}
