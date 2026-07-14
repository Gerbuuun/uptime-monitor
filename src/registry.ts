import { DurableObject, DurableObjectState } from 'alchemy/Cloudflare/Workers';
import type { RuntimeContext } from 'alchemy/RuntimeContext';
import * as Effect from 'effect/Effect';

import { normalizeSlug, type MonitorID, type MonitorIdentity, type ProjectID } from './domain.ts';

type MonitorRecordRow = {
  readonly internal_id: string;
  readonly slug: MonitorID;
  readonly project_id: ProjectID | null;
};

export interface RegistryDurableObject {
  readonly register: (
    id: MonitorID,
    projectID: ProjectID | null,
  ) => Effect.Effect<MonitorIdentity, never, RuntimeContext>;
  readonly resolve: (id: MonitorID) => Effect.Effect<MonitorIdentity | null, never, RuntimeContext>;
  readonly rename: (
    id: MonitorID,
    nextID: MonitorID,
    projectID: ProjectID | null,
  ) => Effect.Effect<MonitorIdentity | null, never, RuntimeContext>;
  readonly page: (
    limit: number,
    cursor: string | null,
    projectID: ProjectID | null,
  ) => Effect.Effect<
    { readonly identities: readonly MonitorIdentity[]; readonly nextCursor: string | null },
    never,
    RuntimeContext
  >;
  readonly all: () => Effect.Effect<readonly MonitorIdentity[], never, RuntimeContext>;
  readonly registerProject: (id: ProjectID) => Effect.Effect<void, never, RuntimeContext>;
  readonly listProjects: () => Effect.Effect<readonly ProjectID[], never, RuntimeContext>;
  readonly projectExists: (id: ProjectID) => Effect.Effect<boolean, never, RuntimeContext>;
}

export class Registry extends DurableObject<Registry, RegistryDurableObject>()('UptimeRegistry') {}

export default Registry.make(
  Effect.succeed(
    Effect.gen(function* () {
      const state = yield* DurableObjectState;
      yield* state.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS monitor_records (
          internal_id TEXT PRIMARY KEY,
          slug TEXT NOT NULL UNIQUE,
          project_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL
        );
      `);

      const identityFromRow = Effect.fn('@UptimeMonitor/Registry.identityFromRow')(function* (
        row: MonitorRecordRow,
      ) {
        return {
          internalID: row.internal_id,
          slug: row.slug,
          projectID: row.project_id,
        } satisfies MonitorIdentity;
      });

      const resolve = Effect.fn('@UptimeMonitor/Registry.resolve')(function* (id: MonitorID) {
        const rows = yield* (yield* state.storage.sql.exec<MonitorRecordRow>(
          `SELECT internal_id, slug, project_id FROM monitor_records WHERE slug = ? LIMIT 1`,
          normalizeSlug(id),
        )).toArray();
        return rows[0] ? yield* identityFromRow(rows[0]) : null;
      });

      return {
        register: Effect.fn('@UptimeMonitor/Registry.register')(function* (
          id: MonitorID,
          projectID: ProjectID | null,
        ) {
          const slug = normalizeSlug(id);
          const existing = yield* resolve(slug);
          if (existing) return existing;
          const now = Date.now();
          const internalID = crypto.randomUUID();
          yield* state.storage.sql.exec(
            'INSERT INTO monitor_records (internal_id, slug, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
            internalID,
            slug,
            projectID,
            now,
            now,
          );
          return { internalID, slug, projectID };
        }),
        resolve,
        rename: Effect.fn('@UptimeMonitor/Registry.rename')(function* (
          id: MonitorID,
          nextID: MonitorID,
          projectID: ProjectID | null,
        ) {
          const identity = yield* resolve(id);
          if (!identity) return null;
          const now = Date.now();
          yield* state.storage.sql.exec(
            'UPDATE monitor_records SET slug = ?, project_id = ?, updated_at = ? WHERE internal_id = ?',
            normalizeSlug(nextID),
            projectID,
            now,
            identity.internalID,
          );
          return yield* resolve(normalizeSlug(nextID));
        }),
        page: Effect.fn('@UptimeMonitor/Registry.page')(function* (
          limit: number,
          cursor: string | null,
          projectID: ProjectID | null,
        ) {
          const boundedLimit = Math.max(1, Math.min(limit, 500));
          const rows = yield* (yield* state.storage.sql.exec<MonitorRecordRow>(
            `SELECT internal_id, slug, project_id FROM monitor_records
             WHERE slug > ? AND (? IS NULL OR project_id = ?)
             ORDER BY slug LIMIT ?`,
            cursor ?? '',
            projectID === null ? null : normalizeSlug(projectID),
            projectID === null ? null : normalizeSlug(projectID),
            boundedLimit + 1,
          )).toArray();
          return {
            identities: yield* Effect.forEach(rows.slice(0, boundedLimit), identityFromRow),
            nextCursor: rows.length > boundedLimit ? rows[boundedLimit - 1]!.slug : null,
          };
        }),
        all: Effect.fn('@UptimeMonitor/Registry.all')(function* () {
          const rows = yield* (yield* state.storage.sql.exec<MonitorRecordRow>(
            'SELECT internal_id, slug, project_id FROM monitor_records ORDER BY slug',
          )).toArray();
          return yield* Effect.forEach(rows, identityFromRow);
        }),
        registerProject: Effect.fn('@UptimeMonitor/Registry.registerProject')(function* (id: ProjectID) {
          yield* state.storage.sql.exec(
            'INSERT OR IGNORE INTO projects (id, created_at) VALUES (?, ?)',
            normalizeSlug(id),
            Date.now(),
          );
        }),
        listProjects: Effect.fn('@UptimeMonitor/Registry.listProjects')(function* () {
          return (yield* (yield* state.storage.sql.exec<{ readonly id: ProjectID }>(
            'SELECT id FROM projects ORDER BY id',
          )).toArray()).map((row) => row.id);
        }),
        projectExists: Effect.fn('@UptimeMonitor/Registry.projectExists')(function* (id: ProjectID) {
          return (
            (yield* (yield* state.storage.sql.exec<{ readonly id: string }>(
              'SELECT id FROM projects WHERE id = ?',
              normalizeSlug(id),
            )).toArray()).length > 0
          );
        }),
      } satisfies RegistryDurableObject;
    }),
  ),
);
