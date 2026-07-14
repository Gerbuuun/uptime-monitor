import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as HttpServer from 'effect/unstable/http/HttpServer';
import { HttpApiBuilder, HttpApiError } from 'effect/unstable/httpapi';

import { UptimeApi } from './api.ts';
import { MonitorManager } from './manager.ts';

const HealthLive = HttpApiBuilder.group(UptimeApi, 'Health', (handlers) =>
  handlers
    .handle('home', () =>
      Effect.succeed(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Uptime Monitor</title></head>
  <body style="font:16px system-ui;max-width:42rem;margin:4rem auto;padding:0 1.5rem;line-height:1.5">
    <h1>Uptime Monitor</h1>
    <p>The stateful uptime monitoring Worker is running.</p>
    <p><a href="/health">Health</a> · <a href="/openapi.json">OpenAPI</a></p>
  </body>
</html>`),
    )
    .handle('health', () => Effect.succeed({ status: 'ok' as const })),
);

const MonitorsLive = HttpApiBuilder.group(UptimeApi, 'Monitors', (handlers) =>
  handlers
    .handle('discover', ({ payload }) =>
      MonitorManager.use((manager) => manager.discover(payload.url, payload.timeoutMs ?? 10_000)),
    )
    .handle('upsert', ({ params, payload }) => MonitorManager.use((manager) => manager.upsert(params.slug, payload)))
    .handle('list', ({ query }) =>
      MonitorManager.use((manager) => manager.list(query.limit ?? 50, query.cursor ?? null, query.project ?? null)),
    )
    .handle('status', ({ params }) =>
      MonitorManager.use((manager) => manager.status(params.slug)).pipe(
        Effect.flatMap((monitor) => (monitor ? Effect.succeed(monitor) : Effect.fail(new HttpApiError.NotFound()))),
      ),
    )
    .handle('history', ({ params, query }) =>
      MonitorManager.use((manager) => manager.status(params.slug)).pipe(
        Effect.flatMap((monitor) =>
          monitor
            ? MonitorManager.use((manager) => manager.history(params.slug, query.limit ?? 50, query.cursor ?? null))
            : Effect.fail(new HttpApiError.NotFound()),
        ),
      ),
    )
    .handle('timeline', ({ params, query }) =>
      MonitorManager.use((manager) => manager.timeline(params.slug, query.since, query.until ?? Date.now())).pipe(
        Effect.flatMap((timeline) => (timeline ? Effect.succeed(timeline) : Effect.fail(new HttpApiError.NotFound()))),
      ),
    )
    .handle('rename', ({ params, payload }) =>
      MonitorManager.use((manager) => manager.rename(params.slug, payload.slug, payload.projectID)).pipe(
        Effect.flatMap((monitor) => (monitor ? Effect.succeed(monitor) : Effect.fail(new HttpApiError.NotFound()))),
      ),
    )
    .handle('check', ({ params }) =>
      MonitorManager.use((manager) => manager.check(params.slug)).pipe(
        Effect.flatMap((monitor) => (monitor ? Effect.succeed(monitor) : Effect.fail(new HttpApiError.NotFound()))),
      ),
    )
    .handle('listAlerts', ({ params }) =>
      MonitorManager.use((manager) => manager.status(params.slug)).pipe(
        Effect.flatMap((monitor) =>
          monitor
            ? MonitorManager.use((manager) => manager.listAlerts(params.slug))
            : Effect.fail(new HttpApiError.NotFound()),
        ),
      ),
    )
    .handle('upsertAlert', ({ params, payload }) =>
      MonitorManager.use((manager) => manager.status(params.slug)).pipe(
        Effect.flatMap((monitor) =>
          monitor
            ? MonitorManager.use((manager) => manager.upsertAlert(params.slug, params.alertID, payload))
            : Effect.fail(new HttpApiError.NotFound()),
        ),
      ),
    )
    .handle('removeAlert', ({ params }) =>
      MonitorManager.use((manager) => manager.status(params.slug)).pipe(
        Effect.flatMap((monitor) =>
          monitor
            ? MonitorManager.use((manager) => manager.removeAlert(params.slug, params.alertID)).pipe(
                Effect.map((removed) => ({ removed })),
              )
            : Effect.fail(new HttpApiError.NotFound()),
        ),
      ),
    ),
);

const ProjectsLive = HttpApiBuilder.group(UptimeApi, 'Projects', (handlers) =>
  handlers
    .handle('upsert', ({ params, payload }) =>
      MonitorManager.use((manager) => manager.upsertProject(params.id, payload.name)),
    )
    .handle('list', () => MonitorManager.use((manager) => manager.listProjects()))
    .handle('status', ({ params }) =>
      MonitorManager.use((manager) => manager.projectStatus(params.id)).pipe(
        Effect.flatMap((project) => (project ? Effect.succeed(project) : Effect.fail(new HttpApiError.NotFound()))),
      ),
    ),
);

export const HttpLive = HttpApiBuilder.layer(UptimeApi, { openapiPath: '/openapi.json' }).pipe(
  Layer.provide([HealthLive, MonitorsLive, ProjectsLive, HttpServer.layerServices]),
);
