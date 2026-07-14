import { CronEventSourceLive, Worker, cron } from 'alchemy/Cloudflare/Workers';
import { Stack } from 'alchemy/Stack';
import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Logger from 'effect/Logger';
import { HttpRouter } from 'effect/unstable/http';

import { authorizationLayer } from './authorization.ts';
import { normalizeMonitor, normalizeSlug, type MonitorID, type ProjectID } from './domain.ts';
import * as Email from './email.ts';
import { HttpLive } from './http.ts';
import { MonitorManager } from './manager.ts';
import MonitorLive, { Monitor } from './monitor.ts';
import { NotificationLive } from './notification.ts';
import { Probe } from './probe.ts';
import ProjectLive, { Project } from './project.ts';
import RegistryLive, { Registry } from './registry.ts';

export class UptimeWorker extends Worker<UptimeWorker, {}, Monitor | Registry | Project>()(
  '@UptimeMonitor/Worker',
) {}

export default UptimeWorker.make(
  Effect.gen(function* () {
    const { stage } = yield* Stack;
    return {
      name: stage === 'production' ? 'uptime-monitor' : `uptime-monitor-${stage}`,
      main: import.meta.filename,
      compatibility: { date: '2026-07-11', flags: ['nodejs_compat'] },
      url: true,
      observability: {
        enabled: true,
        logs: { enabled: true, invocationLogs: true },
      },
      dev: { port: 8790 },
    };
  }),
  Effect.gen(function* () {
    const apiToken = yield* Config.redacted('UPTIME_API_TOKEN');
    const monitors = yield* Monitor;
    const registry = yield* Registry;
    const projects = yield* Project;
    const probe = yield* Probe;
    const registryStub = () => registry.getByName('registry');

    const resolveMonitor = Effect.fn('@UptimeMonitor/resolveMonitor')(function* (id: MonitorID) {
      const identity = yield* registryStub().resolve(id);
      return identity ? { identity, monitor: monitors.getByName(identity.internalID) } : null;
    });

    const reconcileProject = Effect.fn('@UptimeMonitor/reconcileProject')(function* (projectID: ProjectID) {
      const identities = (yield* registryStub().all()).filter((identity) => identity.projectID === projectID);
      const snapshots = yield* Effect.forEach(identities, (identity) =>
        monitors
          .getByName(identity.internalID)
          .status()
          .pipe(
            Effect.map((snapshot) =>
              snapshot ? { internalID: identity.internalID, slug: identity.slug, snapshot } : null,
            ),
          ),
      );
      return yield* projects
        .getByName(projectID)
        .reconcile(snapshots.filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null));
    });

    const manager = MonitorManager.of({
      discover: (url, timeoutMs) => probe.discover(url, timeoutMs).pipe(Effect.orDie),
      upsert: (id, input) =>
        Effect.gen(function* () {
          const existing = yield* registryStub().resolve(id);
          const requestedProjectID = input.projectID === undefined ? (existing?.projectID ?? null) : input.projectID;
          const projectID = requestedProjectID === null ? null : normalizeSlug(requestedProjectID);
          if (projectID !== null && !(yield* registryStub().projectExists(projectID))) {
            return yield* Effect.die(new Error(`Project ${projectID} does not exist`));
          }
          const identity = existing
            ? (yield* registryStub().rename(existing.slug, existing.slug, projectID))!
            : yield* registryStub().register(id, projectID);
          return yield* monitors
            .getByName(identity.internalID)
            .upsert(normalizeMonitor(identity.internalID, identity.slug, { ...input, projectID }));
        }).pipe(Effect.orDie),
      list: (limit, cursor, projectID) =>
        Effect.suspend(() => registryStub().page(limit, cursor, projectID))
          .pipe(
            Effect.flatMap((page) =>
              Effect.forEach(page.identities, (identity) => monitors.getByName(identity.internalID).status()).pipe(
                Effect.map((items) => ({
                  items: items.filter((item): item is NonNullable<typeof item> => item !== null),
                  page: { limit, nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
                })),
              ),
            ),
          )
          .pipe(Effect.orDie),
      status: (id) =>
        resolveMonitor(id)
          .pipe(Effect.flatMap((resolved) => (resolved ? resolved.monitor.status() : Effect.succeed(null))))
          .pipe(Effect.orDie),
      history: (id, limit, cursor) =>
        resolveMonitor(id)
          .pipe(
            Effect.flatMap((resolved) =>
              resolved ? resolved.monitor.history(limit, cursor) : Effect.die(new Error(`Monitor ${id} not found`)),
            ),
          )
          .pipe(Effect.orDie),
      listAlerts: (id) =>
        resolveMonitor(id)
          .pipe(
            Effect.flatMap((resolved) =>
              resolved ? resolved.monitor.listAlerts() : Effect.die(new Error(`Monitor ${id} not found`)),
            ),
          )
          .pipe(Effect.orDie),
      upsertAlert: (id, alertID, input) =>
        resolveMonitor(id)
          .pipe(
            Effect.flatMap((resolved) =>
              resolved
                ? resolved.monitor.upsertAlert(alertID, input)
                : Effect.die(new Error(`Monitor ${id} not found`)),
            ),
          )
          .pipe(Effect.orDie),
      removeAlert: (id, alertID) =>
        resolveMonitor(id)
          .pipe(
            Effect.flatMap((resolved) =>
              resolved ? resolved.monitor.removeAlert(alertID) : Effect.die(new Error(`Monitor ${id} not found`)),
            ),
          )
          .pipe(Effect.orDie),
      rename: (id, nextID, projectID) =>
        Effect.gen(function* () {
          const current = yield* registryStub().resolve(id);
          if (!current) return null;
          const requestedProjectID = projectID === undefined ? current.projectID : projectID;
          const nextProjectID = requestedProjectID === null ? null : normalizeSlug(requestedProjectID);
          if (nextProjectID !== null && !(yield* registryStub().projectExists(nextProjectID))) {
            return yield* Effect.die(new Error(`Project ${nextProjectID} does not exist`));
          }
          const renamed = yield* registryStub().rename(id, nextID, nextProjectID);
          return renamed
            ? yield* monitors.getByName(renamed.internalID).setIdentity(renamed.slug, renamed.projectID)
            : null;
        }).pipe(Effect.orDie),
      timeline: (id, since, until) =>
        resolveMonitor(id)
          .pipe(
            Effect.flatMap((resolved) => (resolved ? resolved.monitor.timeline(since, until) : Effect.succeed(null))),
          )
          .pipe(Effect.orDie),
      upsertProject: (id, name) =>
        registryStub()
          .registerProject(id)
          .pipe(Effect.andThen(projects.getByName(normalizeSlug(id)).upsert(normalizeSlug(id), name)), Effect.orDie),
      listProjects: () =>
        registryStub()
          .listProjects()
          .pipe(
            Effect.flatMap((ids) => Effect.forEach(ids, reconcileProject)),
            Effect.map((items) => items.filter((item): item is NonNullable<typeof item> => item !== null)),
          )
          .pipe(Effect.orDie),
      projectStatus: (id) =>
        registryStub()
          .projectExists(id)
          .pipe(
            Effect.flatMap((exists) => (exists ? reconcileProject(normalizeSlug(id)) : Effect.succeed(null))),
            Effect.orDie,
          ),
      check: (id) =>
        resolveMonitor(id)
          .pipe(Effect.flatMap((resolved) => (resolved ? resolved.monitor.checkNow() : Effect.succeed(null))))
          .pipe(Effect.orDie),
      supervise: () =>
        Effect.suspend(() => registryStub().all())
          .pipe(
            Effect.flatMap((identities) =>
              Effect.forEach(identities, (identity) => monitors.getByName(identity.internalID).ensureScheduled()),
            ),
            Effect.tap(() =>
              registryStub()
                .listProjects()
                .pipe(Effect.flatMap((ids) => Effect.forEach(ids, reconcileProject))),
            ),
            Effect.map((results) => results.filter(Boolean).length),
          )
          .pipe(Effect.orDie),
    });

    yield* cron('*/5 * * * *', () =>
      manager.supervise().pipe(Effect.tap((rearmed) => Effect.logInfo('uptime_supervisor_completed', { rearmed }))),
    );

    return {
      fetch: HttpLive.pipe(
        HttpRouter.toHttpEffect,
        Effect.provide(Layer.succeed(MonitorManager, manager)),
        Effect.provide(authorizationLayer(apiToken)),
        Effect.provide(Logger.layer([Logger.consoleJson])),
      ),
    };
  }).pipe(
    Effect.provide(MonitorLive),
    Effect.provide(ProjectLive),
    Effect.provide(RegistryLive),
    Effect.provide(NotificationLive),
    Effect.provide(Probe.layer),
    Effect.provide(CronEventSourceLive),
    Effect.provide(Email.cloudflare('@UptimeMonitor/Email')),
    Effect.orDie,
  ),
);
