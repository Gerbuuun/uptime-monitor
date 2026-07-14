import * as Schema from 'effect/Schema';
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiError,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from 'effect/unstable/httpapi';

import {
  AlertInput,
  AlertList,
  AlertParams,
  AlertRule,
  CheckPage,
  DiscoveryInput,
  DiscoveryResult,
  HistoryQuery,
  ListQuery,
  MonitorPage,
  MonitorParams,
  MonitorSnapshot,
  ProjectInput,
  ProjectList,
  ProjectParams,
  ProjectSnapshot,
  RenameMonitor,
  Timeline,
  TimelineQuery,
  UpsertMonitor,
} from './domain.ts';

export class Authorization extends HttpApiMiddleware.Service<Authorization, { requires: never; provides: never }>()(
  '@UptimeMonitor/Authorization',
  {
    requiredForClient: true,
    security: { bearer: HttpApiSecurity.bearer },
    error: HttpApiError.Unauthorized,
  },
) {}

class Health extends HttpApiGroup.make('Health', { topLevel: true }).add(
  HttpApiEndpoint.get('home', '/', {
    success: Schema.String.pipe(HttpApiSchema.asText({ contentType: 'text/html; charset=utf-8' })),
  }),
  HttpApiEndpoint.get('health', '/health', {
    success: Schema.Struct({ status: Schema.Literal('ok') }),
  }),
) {}

class Monitors extends HttpApiGroup.make('Monitors')
  .add(
    HttpApiEndpoint.post('discover', '/discover', {
      payload: DiscoveryInput,
      success: DiscoveryResult,
      error: HttpApiError.InternalServerError,
    }),
    HttpApiEndpoint.put('upsert', '/:slug', {
      params: UpsertMonitor.fields.params,
      payload: UpsertMonitor.fields.payload,
      success: MonitorSnapshot,
      error: HttpApiError.InternalServerError,
    }),
    HttpApiEndpoint.get('list', '/', {
      query: ListQuery,
      success: MonitorPage,
      error: HttpApiError.InternalServerError,
    }),
    HttpApiEndpoint.get('status', '/:slug', {
      params: MonitorParams,
      success: MonitorSnapshot,
      error: [HttpApiError.NotFound, HttpApiError.InternalServerError],
    }),
    HttpApiEndpoint.get('history', '/:slug/history', {
      params: MonitorParams,
      query: HistoryQuery,
      success: CheckPage,
      error: [HttpApiError.NotFound, HttpApiError.InternalServerError],
    }),
    HttpApiEndpoint.get('timeline', '/:slug/timeline', {
      params: MonitorParams,
      query: TimelineQuery,
      success: Timeline,
      error: [HttpApiError.NotFound, HttpApiError.InternalServerError],
    }),
    HttpApiEndpoint.post('rename', '/:slug/rename', {
      params: MonitorParams,
      payload: RenameMonitor,
      success: MonitorSnapshot,
      error: [HttpApiError.NotFound, HttpApiError.InternalServerError],
    }),
    HttpApiEndpoint.post('check', '/:slug/check', {
      params: MonitorParams,
      success: MonitorSnapshot,
      error: [HttpApiError.NotFound, HttpApiError.InternalServerError],
    }),
    HttpApiEndpoint.get('listAlerts', '/:slug/alerts', {
      params: MonitorParams,
      success: AlertList,
      error: [HttpApiError.NotFound, HttpApiError.InternalServerError],
    }),
    HttpApiEndpoint.put('upsertAlert', '/:slug/alerts/:alertID', {
      params: AlertParams,
      payload: AlertInput,
      success: AlertRule,
      error: [HttpApiError.NotFound, HttpApiError.InternalServerError],
    }),
    HttpApiEndpoint.delete('removeAlert', '/:slug/alerts/:alertID', {
      params: AlertParams,
      success: Schema.Struct({ removed: Schema.Boolean }),
      error: [HttpApiError.NotFound, HttpApiError.InternalServerError],
    }),
  )
  .prefix('/monitors')
  .middleware(Authorization) {}

class Projects extends HttpApiGroup.make('Projects')
  .add(
    HttpApiEndpoint.put('upsert', '/:id', {
      params: ProjectParams,
      payload: ProjectInput,
      success: ProjectSnapshot,
      error: HttpApiError.InternalServerError,
    }),
    HttpApiEndpoint.get('list', '/', {
      success: ProjectList,
      error: HttpApiError.InternalServerError,
    }),
    HttpApiEndpoint.get('status', '/:id', {
      params: ProjectParams,
      success: ProjectSnapshot,
      error: [HttpApiError.NotFound, HttpApiError.InternalServerError],
    }),
  )
  .prefix('/projects')
  .middleware(Authorization) {}

export class UptimeApi extends HttpApi.make('UptimeApi').add(Health).add(Monitors).add(Projects) {}
