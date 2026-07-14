#!/usr/bin/env node

import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Cause from 'effect/Cause';
import * as Console from 'effect/Console';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Queue from 'effect/Queue';
import * as Redacted from 'effect/Redacted';
import * as Schedule from 'effect/Schedule';
import * as Terminal from 'effect/Terminal';
import { Argument, Command, Flag, Prompt } from 'effect/unstable/cli';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { HttpApiClient, HttpApiMiddleware } from 'effect/unstable/httpapi';

import { Authorization, UptimeApi } from './api.ts';
import {
  configPath,
  normalizeBaseUrl,
  normalizeToken,
  readCliConfig,
  writeCliConfig,
} from './cli-config.ts';
import {
  formatHistoryFrame,
  formatHistoryStatic,
  formatAlertList,
  formatMonitor,
  formatMonitorList,
  formatProject,
  formatProjectLine,
  formatTimeline,
  summarizeChecks,
} from './cli-output.ts';
import type { DiscoveryResult } from './domain.ts';

const root = Command.make('uptime').pipe(
  Command.withSharedFlags({
    verbose: Flag.boolean('verbose').pipe(Flag.withDescription('Show expanded, human-readable details')),
    json: Flag.boolean('json').pipe(
      Flag.withDescription('Print complete, structured context as JSON for scripts and agents'),
    ),
    noInput: Flag.boolean('no-input').pipe(Flag.withDescription('Never prompt; fail when required input is missing')),
    yes: Flag.boolean('yes').pipe(Flag.withAlias('y'), Flag.withDescription('Skip confirmation prompts')),
  }),
);

const monitorID = Argument.string('slug').pipe(Argument.withDescription('Case-insensitive monitor slug'));

const list = Command.make(
  'list',
  {
    limit: Flag.integer('limit').pipe(Flag.withDefault(50)),
    cursor: Flag.string('cursor').pipe(Flag.optional),
    project: Flag.string('project').pipe(Flag.optional),
  },
  ({ limit, cursor, project }) =>
    Effect.gen(function* () {
      const output = yield* root;
      const page = yield* withClient((client) =>
        client.Monitors.list({
          query: { limit, cursor: Option.getOrUndefined(cursor), project: Option.getOrUndefined(project) },
        }),
      );
      yield* printValue(agentOutput('list', { summary: summarizeMonitors(page.items), ...page }), output, () =>
        output.verbose
          ? page.items.map((monitor) => formatMonitor(monitor, colorsEnabled(), true)).join('\n\n')
          : `${formatMonitorList(page.items, colorsEnabled())}${page.page.hasMore ? `\nMore monitors: --cursor ${page.page.nextCursor}` : ''}`,
      );
    }),
).pipe(Command.withDescription('List monitors and their current status'));

const history = Command.make(
  'history',
  {
    id: monitorID,
    limit: Flag.integer('limit').pipe(Flag.withDefault(50)),
    cursor: Flag.integer('cursor').pipe(Flag.optional),
    noInteractive: Flag.boolean('no-interactive').pipe(
      Flag.withDescription('Print once without opening the history viewer'),
    ),
  },
  ({ id, limit, cursor, noInteractive }) =>
    Effect.gen(function* () {
      const output = yield* root;
      const result = yield* withClient((client) =>
        Effect.all({
          monitor: client.Monitors.status({ params: { slug: id } }),
          history: client.Monitors.history({
            params: { slug: id },
            query: { limit, cursor: Option.getOrUndefined(cursor) },
          }),
        }),
      );
      if (output.json) {
        yield* printJson(
          agentOutput('history', {
            monitor: result.monitor,
            summary: summarizeChecks(result.history.items),
            semantics: {
              order: 'newest-first',
              degraded: 'successful check with latencyMs >= 1000',
              requestedLimit: limit,
            },
            ...result.history,
          }),
        );
        return;
      }
      if (!process.stdin.isTTY || !process.stdout.isTTY || noInteractive || result.history.items.length === 0) {
        yield* Console.log(formatHistoryStatic(result.monitor, result.history.items, colorsEnabled(), output.verbose));
        if (result.history.page.hasMore) yield* Console.log(`More checks: --cursor ${result.history.page.nextCursor}`);
        return;
      }
      yield* interactiveHistory(result.monitor, result.history.items.toReversed(), output.verbose);
    }),
).pipe(Command.withDescription('Show recent checks for a monitor'));

const check = Command.make('check', { id: monitorID }, ({ id }) =>
  Effect.gen(function* () {
    const output = yield* root;
    const monitor = yield* withClient((client) => client.Monitors.check({ params: { slug: id } }));
    yield* printValue(agentOutput('check', { monitor }), output, () =>
      formatMonitor(monitor, colorsEnabled(), output.verbose),
    );
  }),
).pipe(Command.withDescription('Run a monitor immediately'));

const timeline = Command.make(
  'timeline',
  {
    id: monitorID,
    since: Flag.string('since').pipe(
      Flag.withDefault('24h'),
      Flag.withDescription('Lookback such as 24h, 7d, 30d, 90d, or an ISO timestamp'),
    ),
    until: Flag.string('until').pipe(Flag.optional, Flag.withDescription('ISO timestamp; defaults to now')),
  },
  ({ id, since, until }) =>
    Effect.gen(function* () {
      const output = yield* root;
      const untilMs = Option.isSome(until) ? yield* parseTimestamp(until.value) : Date.now();
      const sinceMs = yield* parseSince(since, untilMs);
      const result = yield* withClient((client) =>
        Effect.all({
          monitor: client.Monitors.status({ params: { slug: id } }),
          timeline: client.Monitors.timeline({ params: { slug: id }, query: { since: sinceMs, until: untilMs } }),
        }),
      );
      yield* printValue(
        agentOutput('monitor.timeline', {
          monitor: result.monitor,
          range: { since: sinceMs, until: untilMs },
          retention: {
            rawHealthyChecks: '7d',
            buckets: ['5m through 30d', '15m through 90d', '1h indefinitely'],
            anomalies: 'retained indefinitely',
          },
          timeline: result.timeline,
        }),
        output,
        () => formatTimeline(result.monitor, result.timeline, colorsEnabled(), (process.stdout.columns ?? 102) - 2),
      );
    }),
).pipe(Command.withDescription('Show tiered long-range history with retained incidents and degradations'));

const monitorCreate = Command.make(
  'create',
  {
    name: Argument.string('name').pipe(Argument.optional, Argument.withDescription('Human-readable monitor name')),
    slug: Flag.string('slug').pipe(Flag.optional, Flag.withDescription('URL-safe slug; derived from the name')),
    url: Flag.string('url').pipe(Flag.optional, Flag.withDescription('HTTP(S) URL to check')),
    expectedStatus: Flag.integer('expected-status').pipe(Flag.optional),
    expectedBody: Flag.string('expected-body').pipe(Flag.optional),
    timeoutSeconds: Flag.integer('timeout-seconds').pipe(Flag.withDefault(10)),
    healthySeconds: Flag.integer('healthy-seconds').pipe(Flag.withDefault(60)),
    suspectSeconds: Flag.integer('suspect-seconds').pipe(Flag.withDefault(15)),
    downSeconds: Flag.integer('down-seconds').pipe(Flag.withDefault(60)),
    recoveringSeconds: Flag.integer('recovering-seconds').pipe(Flag.withDefault(15)),
    failureThreshold: Flag.integer('failure-threshold').pipe(Flag.withDefault(2)),
    recoveryThreshold: Flag.integer('recovery-threshold').pipe(Flag.withDefault(2)),
    disabled: Flag.boolean('disabled'),
    project: Flag.string('project').pipe(Flag.optional, Flag.withDescription('Assign the monitor to a project')),
  },
  (input) =>
    Effect.gen(function* () {
      const output = yield* root;
      const interactive = canPrompt(output);
      const name = yield* requireText(input.name, 'monitor name', output, {
        message: 'Name',
        validate: validateName,
      });
      const suggestedSlug = slugify(name);
      const slug = yield* ensureMonitorSlugAvailable(
        Option.isSome(input.slug)
          ? slugify(input.slug.value)
          : interactive
            ? slugify(
                yield* Prompt.run(
                  Prompt.text({ message: 'Slug', default: suggestedSlug, validate: validateSlugInput }),
                ),
              )
            : suggestedSlug,
      );
      const projectID = Option.isSome(input.project)
        ? slugify(input.project.value)
        : interactive
          ? yield* chooseProject()
          : null;
      const url = yield* requireText(input.url, 'URL', output, {
        message: 'URL',
        validate: validateHttpUrl,
      });
      const discovery = yield* withClient((client) =>
        client.Monitors.discover({ payload: { url, timeoutMs: input.timeoutSeconds * 1_000 } }),
      );
      if (!output.json) yield* Console.log(formatDiscovery(discovery));
      const expectation = yield* collectExpectation(discovery, input, interactive);
      const addAlert = interactive
        ? yield* Prompt.run(Prompt.confirm({ message: 'Create an alert rule now?', initial: true }))
        : false;
      const alert = addAlert ? yield* collectAlertInput(output) : null;

      if (!output.yes && interactive) {
        yield* Console.log(
          `\nCreate ${name}\n  Slug           ${slug}\n  Project        ${projectID ?? 'none'}\n  URL            ${url}\n  Healthy when   HTTP ${expectation.expectedStatus}${expectation.expectedBody ? ` and body is ${JSON.stringify(expectation.expectedBody)}` : ''}\n  Alert          ${alert ? `${alert.type} → ${maskCliDestination(alert.type, alert.destination)}` : 'none'}\n`,
        );
        if (!(yield* Prompt.run(Prompt.confirm({ message: 'Create monitor?', initial: true })))) return;
      }

      yield* withClient((client) =>
        client.Monitors.upsert({
          params: { slug },
          payload: {
            name,
            url,
            expectedStatus: expectation.expectedStatus,
            expectedBody: expectation.expectedBody,
            timeoutMs: input.timeoutSeconds * 1_000,
            healthyIntervalMs: input.healthySeconds * 1_000,
            suspectIntervalMs: input.suspectSeconds * 1_000,
            downIntervalMs: input.downSeconds * 1_000,
            recoveringIntervalMs: input.recoveringSeconds * 1_000,
            failureThreshold: input.failureThreshold,
            recoveryThreshold: input.recoveryThreshold,
            alerts: false,
            enabled: !input.disabled,
            projectID,
          },
        }),
      );
      const createdAlert = alert
        ? yield* withClient((client) =>
            alert.type === 'email'
              ? client.Monitors.upsertAlert({
                  params: { slug, alertID: alert.id },
                  payload: { type: 'email', destination: alert.destination, events: alert.events, enabled: true },
                })
              : client.Monitors.upsertAlert({
                  params: { slug, alertID: alert.id },
                  payload: { type: 'webhook', destination: alert.destination, events: alert.events, enabled: true },
                }),
          )
        : null;
      const checkedMonitor = yield* withClient((client) => client.Monitors.check({ params: { slug } }));
      yield* printValue(
        agentOutput('monitor.create', { discovery, monitor: checkedMonitor, alert: createdAlert }),
        output,
        () => formatMonitor(checkedMonitor, colorsEnabled(), output.verbose),
      );
    }),
).pipe(Command.withDescription('Create a monitor from a name, derived slug, and discovery check'));

const monitorGet = Command.make('get', { id: monitorID }, ({ id }) =>
  Effect.gen(function* () {
    const output = yield* root;
    const monitor = yield* withClient((client) => client.Monitors.status({ params: { slug: id } }));
    yield* printValue(agentOutput('monitor.get', { monitor }), output, () =>
      formatMonitor(monitor, colorsEnabled(), output.verbose),
    );
  }),
).pipe(Command.withDescription('Show one monitor'));

const monitorEdit = Command.make(
  'edit',
  {
    id: monitorID,
    url: Flag.string('url').pipe(Flag.optional),
    name: Flag.string('name').pipe(Flag.optional),
    expectedStatus: Flag.integer('expected-status').pipe(Flag.optional),
    expectedBody: Flag.string('expected-body').pipe(Flag.optional),
    timeoutSeconds: Flag.integer('timeout-seconds').pipe(Flag.optional),
    healthySeconds: Flag.integer('healthy-seconds').pipe(Flag.optional),
    suspectSeconds: Flag.integer('suspect-seconds').pipe(Flag.optional),
    downSeconds: Flag.integer('down-seconds').pipe(Flag.optional),
    recoveringSeconds: Flag.integer('recovering-seconds').pipe(Flag.optional),
    failureThreshold: Flag.integer('failure-threshold').pipe(Flag.optional),
    recoveryThreshold: Flag.integer('recovery-threshold').pipe(Flag.optional),
    enable: Flag.boolean('enable'),
    disable: Flag.boolean('disable'),
    check: Flag.boolean('check'),
    project: Flag.string('project').pipe(Flag.optional),
    noProject: Flag.boolean('no-project'),
  },
  (input) =>
    Effect.gen(function* () {
      const output = yield* root;
      if (input.enable && input.disable)
        return yield* Effect.fail(new Error('Use either --enable or --disable, not both.'));
      if (Option.isSome(input.project) && input.noProject)
        return yield* Effect.fail(new Error('Use either --project or --no-project, not both.'));
      const current = yield* withClient((client) => client.Monitors.status({ params: { slug: input.id } }));
      const interactive = canPrompt(output);
      const hasChanges =
        [
          input.url,
          input.name,
          input.expectedStatus,
          input.expectedBody,
          input.timeoutSeconds,
          input.healthySeconds,
          input.suspectSeconds,
          input.downSeconds,
          input.recoveringSeconds,
          input.failureThreshold,
          input.recoveryThreshold,
        ].some((value) => value._tag === 'Some') ||
        input.enable ||
        input.disable ||
        Option.isSome(input.project) ||
        input.noProject;
      if (!interactive && !hasChanges) {
        return yield* Effect.fail(new Error('No changes supplied. Pass edit flags or run in an interactive terminal.'));
      }

      const url = Option.isSome(input.url)
        ? yield* validateHttpUrl(input.url.value).pipe(Effect.mapError((message) => new Error(message)))
        : interactive
          ? yield* Prompt.run(Prompt.text({ message: 'URL', default: current.config.url, validate: validateHttpUrl }))
          : current.config.url;
      const name = Option.isSome(input.name)
        ? input.name.value
        : interactive
          ? yield* Prompt.run(Prompt.text({ message: 'Name', default: current.config.name }))
          : current.config.name;
      const expectedStatus = Option.isSome(input.expectedStatus)
        ? input.expectedStatus.value
        : interactive
          ? Number(
              yield* Prompt.run(
                Prompt.text({
                  message: 'Expected HTTP status',
                  default: String(current.config.expectedStatus),
                  validate: validateStatus,
                }),
              ),
            )
          : current.config.expectedStatus;
      const expectedBody = Option.isSome(input.expectedBody)
        ? input.expectedBody.value || null
        : interactive
          ? (yield* Prompt.run(
              Prompt.text({
                message: 'Expected body (leave empty to ignore)',
                default: current.config.expectedBody ?? '',
              }),
            )) || null
          : current.config.expectedBody;
      const config = {
        name,
        url,
        expectedStatus,
        expectedBody,
        timeoutMs: Option.getOrElse(input.timeoutSeconds, () => current.config.timeoutMs / 1_000) * 1_000,
        healthyIntervalMs:
          Option.getOrElse(input.healthySeconds, () => current.config.healthyIntervalMs / 1_000) * 1_000,
        suspectIntervalMs:
          Option.getOrElse(input.suspectSeconds, () => current.config.suspectIntervalMs / 1_000) * 1_000,
        downIntervalMs: Option.getOrElse(input.downSeconds, () => current.config.downIntervalMs / 1_000) * 1_000,
        recoveringIntervalMs:
          Option.getOrElse(input.recoveringSeconds, () => current.config.recoveringIntervalMs / 1_000) * 1_000,
        failureThreshold: Option.getOrElse(input.failureThreshold, () => current.config.failureThreshold),
        recoveryThreshold: Option.getOrElse(input.recoveryThreshold, () => current.config.recoveryThreshold),
        alerts: current.config.alerts,
        enabled: input.disable ? false : input.enable ? true : current.config.enabled,
        projectID: input.noProject
          ? null
          : Option.isSome(input.project)
            ? input.project.value
            : current.config.projectID,
      };
      if (!output.yes && interactive) {
        yield* Console.log(
          `\nUpdate ${input.id}\n  URL            ${config.url}\n  Name           ${config.name}\n  Project        ${config.projectID ?? 'none'}\n  Enabled        ${config.enabled}\n`,
        );
        if (!(yield* Prompt.run(Prompt.confirm({ message: 'Save changes?', initial: true })))) return;
      }
      const updated = yield* withClient((client) =>
        client.Monitors.upsert({ params: { slug: input.id }, payload: config }),
      );
      const checked = input.check
        ? yield* withClient((client) => client.Monitors.check({ params: { slug: input.id } }))
        : updated;
      yield* printValue(agentOutput('monitor.edit', { before: current, monitor: checked }), output, () =>
        formatMonitor(checked, colorsEnabled(), output.verbose),
      );
    }),
).pipe(Command.withDescription('Edit only the supplied monitor fields'));

const monitorRename = Command.make(
  'rename',
  {
    id: monitorID,
    nextID: Argument.string('new-slug').pipe(Argument.optional),
    project: Flag.string('project').pipe(Flag.optional),
    noProject: Flag.boolean('no-project'),
  },
  (input) =>
    Effect.gen(function* () {
      const output = yield* root;
      if (Option.isSome(input.project) && input.noProject)
        return yield* Effect.fail(new Error('Use either --project or --no-project, not both.'));
      const nextID = yield* requireText(input.nextID, 'new monitor slug', output, {
        message: 'New monitor slug',
        validate: validateSlugInput,
      });
      const current = yield* withClient((client) => client.Monitors.status({ params: { slug: input.id } }));
      const projectID = input.noProject
        ? null
        : Option.isSome(input.project)
          ? input.project.value
          : current.config.projectID;
      if (!output.yes && canPrompt(output)) {
        yield* Console.log(`\nRename ${input.id} → ${nextID}\n  Project        ${projectID ?? 'none'}\n`);
        if (!(yield* Prompt.run(Prompt.confirm({ message: 'Rename monitor?', initial: true })))) return;
      }
      const monitor = yield* withClient((client) =>
        client.Monitors.rename({
          params: { slug: input.id },
          payload: { slug: nextID, projectID },
        }),
      );
      yield* printValue(
        agentOutput('monitor.rename', {
          previousID: input.id,
          monitor,
        }),
        output,
        () => formatMonitor(monitor, colorsEnabled(), output.verbose),
      );
    }),
).pipe(Command.withDescription('Rename a monitor while preserving its state'));

const alertsRoot = Command.make('alerts').pipe(Command.withDescription('Manage alert rules for a monitor'));

const alertsList = Command.make('list', { id: monitorID }, ({ id }) =>
  Effect.gen(function* () {
    const output = yield* root;
    const alerts = yield* withClient((client) => client.Monitors.listAlerts({ params: { slug: id } }));
    yield* printValue(agentOutput('monitor.alerts.list', { monitorID: id, alerts }), output, () =>
      formatAlertList(alerts, colorsEnabled(), output.verbose),
    );
  }),
).pipe(Command.withDescription('List alert rules'));

const alertsCreate = Command.make(
  'create',
  {
    id: monitorID,
    alertID: Argument.string('alert-id').pipe(Argument.optional),
    type: Flag.choice('type', ['email', 'webhook'] as const).pipe(Flag.optional),
    destination: Flag.string('destination').pipe(Flag.optional),
    events: Flag.string('events').pipe(Flag.optional, Flag.withDescription('Comma-separated: down,recovered')),
    disabled: Flag.boolean('disabled'),
  },
  (input) =>
    Effect.gen(function* () {
      const output = yield* root;
      const id = input.id;
      const alert = yield* collectAlertInput(output, input);
      if (!output.yes && canPrompt(output)) {
        yield* Console.log(
          `\nCreate alert ${alert.id}\n  Type           ${alert.type}\n  Destination    ${maskCliDestination(alert.type, alert.destination)}\n  Events         ${alert.events.join(', ')}\n`,
        );
        if (!(yield* Prompt.run(Prompt.confirm({ message: 'Create alert?', initial: true })))) return;
      }
      const created = yield* withClient((client) =>
        alert.type === 'email'
          ? client.Monitors.upsertAlert({
              params: { slug: id, alertID: alert.id },
              payload: {
                type: 'email',
                destination: alert.destination,
                events: alert.events,
                enabled: !input.disabled,
              },
            })
          : client.Monitors.upsertAlert({
              params: { slug: id, alertID: alert.id },
              payload: {
                type: 'webhook',
                destination: alert.destination,
                events: alert.events,
                enabled: !input.disabled,
              },
            }),
      );
      yield* printValue(agentOutput('monitor.alerts.create', { monitorID: id, alert: created }), output, () =>
        formatAlertList([created], colorsEnabled(), true),
      );
    }),
).pipe(Command.withDescription('Create or replace an email or webhook alert rule'));

const alertsRemove = Command.make(
  'remove',
  { id: monitorID, alertID: Argument.string('alert-id') },
  ({ id, alertID }) =>
    Effect.gen(function* () {
      const output = yield* root;
      if (!output.yes) {
        if (!canPrompt(output))
          return yield* Effect.fail(new Error('Removing an alert requires --yes in non-interactive mode'));
        if (!(yield* Prompt.run(Prompt.confirm({ message: `Remove alert ${alertID}?`, initial: false })))) return;
      }
      const result = yield* withClient((client) => client.Monitors.removeAlert({ params: { slug: id, alertID } }));
      yield* printValue(agentOutput('monitor.alerts.remove', { monitorID: id, alertID, ...result }), output, () =>
        result.removed ? `Removed alert ${alertID}.` : `Alert ${alertID} did not exist.`,
      );
    }),
).pipe(Command.withDescription('Remove an alert rule'));

const alerts = alertsRoot.pipe(Command.withSubcommands([alertsList, alertsCreate, alertsRemove]));

const monitor = Command.make('monitor').pipe(
  Command.withDescription('Create and manage monitors'),
  Command.withSubcommands([
    monitorCreate,
    list,
    monitorGet,
    monitorEdit,
    monitorRename,
    history,
    timeline,
    check,
    alerts,
  ]),
);

const projectCreate = Command.make(
  'create',
  {
    name: Argument.string('name').pipe(Argument.optional),
    slug: Flag.string('slug').pipe(Flag.optional),
  },
  (input) =>
    Effect.gen(function* () {
      const output = yield* root;
      const name = yield* requireText(input.name, 'project name', output, {
        message: 'Project name',
        validate: validateName,
      });
      const id = Option.isSome(input.slug)
        ? slugify(input.slug.value)
        : canPrompt(output)
          ? slugify(
              yield* Prompt.run(
                Prompt.text({ message: 'Project slug', default: slugify(name), validate: validateSlugInput }),
              ),
            )
          : slugify(name);
      yield* validateSlug(id);
      const project = yield* withClient((client) => client.Projects.upsert({ params: { id }, payload: { name } }));
      yield* printValue(agentOutput('project.create', { project }), output, () =>
        formatProject(project, colorsEnabled()),
      );
    }),
).pipe(Command.withDescription('Create or update a project'));

const projectList = Command.make('list', {}, () =>
  Effect.gen(function* () {
    const output = yield* root;
    const projects = yield* withClient((client) => client.Projects.list({}));
    yield* printValue(agentOutput('project.list', { projects }), output, () =>
      projects.length === 0
        ? 'No projects.'
        : projects.map((project) => formatProjectLine(project, colorsEnabled())).join('\n'),
    );
  }),
).pipe(Command.withDescription('List projects and their roll-up status'));

const projectStatus = Command.make('status', { id: Argument.string('id') }, ({ id }) =>
  Effect.gen(function* () {
    const output = yield* root;
    const project = yield* withClient((client) => client.Projects.status({ params: { id } }));
    yield* printValue(agentOutput('project.status', { project }), output, () =>
      formatProject(project, colorsEnabled()),
    );
  }),
).pipe(Command.withDescription('Show project status and member monitors'));

const project = Command.make('project').pipe(
  Command.withDescription('Create and inspect monitor groups'),
  Command.withSubcommands([projectCreate, projectList, projectStatus]),
);

const login = Command.make(
  'login',
  {
    url: Flag.string('url').pipe(Flag.optional, Flag.withDescription('Deployed Worker origin')),
    token: Flag.string('token').pipe(
      Flag.optional,
      Flag.withDescription('Worker API token; prefer the hidden prompt so it is not saved in shell history'),
    ),
  },
  (input) =>
    Effect.gen(function* () {
      const output = yield* root;
      const saved = yield* storedConfig();
      const interactive = canPrompt(output);
      const baseUrl = Option.isSome(input.url)
        ? yield* validateBaseUrl(input.url.value)
        : interactive
          ? yield* Prompt.run(
              Prompt.text({
                message: 'Worker URL',
                default: saved.baseUrl ?? '',
                validate: (value) => validateBaseUrl(value).pipe(Effect.as(value)),
              }),
            ).pipe(Effect.flatMap(validateBaseUrl))
          : saved.baseUrl
            ? saved.baseUrl
            : yield* Effect.fail(new Error('Missing Worker URL. Pass --url or run login in an interactive terminal.'));
      const token = Option.isSome(input.token)
        ? yield* validateToken(input.token.value)
        : interactive
          ? yield* Prompt.run(Prompt.password({ message: 'API token', validate: validateToken })).pipe(
              Effect.map(Redacted.value),
              Effect.flatMap(validateToken),
            )
          : yield* Effect.fail(new Error('Missing API token. Pass --token or run login in an interactive terminal.'));

      yield* withCredentials(baseUrl, token).pipe(
        Effect.flatMap((client) => client.Monitors.list({ query: { limit: 1 } })),
      );
      yield* Effect.try({
        try: () => writeCliConfig({ baseUrl, token }),
        catch: (cause) => new Error(`Could not save CLI credentials: ${errorMessage(cause)}`),
      });
      yield* printValue(
        agentOutput('login', {
          baseUrl,
          configPath: configPath(),
        }),
        output,
        () => `Signed in. Credentials saved to ${configPath()}.`,
      );
    }),
).pipe(Command.withAlias('sign-in'), Command.withDescription('Save and verify Worker credentials for this device'));

const logout = Command.make('logout', {}, () =>
  Effect.gen(function* () {
    const output = yield* root;
    const saved = yield* storedConfig();
    yield* Effect.try({
      try: () => writeCliConfig({}),
      catch: (cause) => new Error(`Could not update CLI configuration: ${errorMessage(cause)}`),
    });
    yield* printValue(
      agentOutput('logout', { configPath: configPath() }),
      output,
      () => 'Signed out. Saved Worker credentials have been removed.',
    );
  }),
).pipe(Command.withDescription('Remove saved Worker credentials from this device'));

const configurationRoot = Command.make('config').pipe(Command.withDescription('Manage local CLI defaults'));

const configurationShow = Command.make('show', {}, () =>
  Effect.gen(function* () {
    const output = yield* root;
    const saved = yield* storedConfig();
    const baseUrl = saved.baseUrl ?? null;
    const tokenConfigured = saved.token !== undefined;
    const values = {
      configPath: configPath(),
      baseUrl,
      tokenConfigured,
    };
    yield* printValue(agentOutput('config.show', values), output, () =>
      [
        `Config file: ${values.configPath}`,
        `Worker URL: ${values.baseUrl ?? 'not configured'}`,
        `Credentials: ${values.tokenConfigured ? 'configured' : 'not configured'}`,
      ].join('\n'),
    );
  }),
).pipe(Command.withDescription('Show effective CLI configuration without exposing secrets'));

const configuration = configurationRoot.pipe(Command.withSubcommands([configurationShow]));

const cli = root.pipe(
  Command.withDescription('Manage the Uptime Monitor Worker'),
  Command.withSubcommands([login, logout, configuration, monitor, project]),
);

normalizeResourceSyntax();
Command.run(cli, { version: '0.1.0' }).pipe(
  Effect.provide(NodeServices.layer),
  Effect.catchCause((cause) => {
    const failure = Cause.findErrorOption(cause);
    if (Option.isSome(failure) && isShowHelp(failure.value)) return Effect.void;
    return Console.error(Option.isSome(failure) ? `Error: ${errorMessage(failure.value)}` : Cause.pretty(cause)).pipe(
      Effect.andThen(Effect.sync(() => void (process.exitCode = 1))),
    );
  }),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);

function normalizeResourceSyntax() {
  const args = process.argv.slice(2);
  const monitorIndex = args.indexOf('monitor');
  if (monitorIndex < 0 || args[monitorIndex + 2] !== 'alerts') return;
  const action = args[monitorIndex + 3];
  if (action !== 'list' && action !== 'create' && action !== 'remove') return;
  process.argv.splice(monitorIndex + 2, 4, 'monitor', 'alerts', action, args[monitorIndex + 1]!);
}

function withClient<A>(use: (client: HttpApiClient.ForApi<typeof UptimeApi>) => Effect.Effect<A, unknown, never>) {
  return Effect.gen(function* () {
    const { baseUrl, token } = yield* connectionConfig();
    const client = yield* withCredentials(baseUrl, token);
    return yield* use(client);
  });
}

function withCredentials(baseUrl: string, token: string) {
  const authorization = HttpApiMiddleware.layerClient(Authorization, ({ request, next }) =>
    next(HttpClientRequest.bearerToken(request, token)),
  );
  return HttpApiClient.make(UptimeApi, {
    transformClient: (httpClient) =>
      httpClient.pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl(baseUrl)),
        HttpClient.retryTransient({ schedule: Schedule.exponential('250 millis'), times: 3 }),
      ),
  }).pipe(Effect.provide(authorization), Effect.provide(FetchHttpClient.layer));
}

function connectionConfig() {
  return Effect.gen(function* () {
    const saved = yield* storedConfig();
    const baseUrl = saved.baseUrl;
    const token = saved.token;
    if (!baseUrl) {
      return yield* Effect.fail(
        new Error('No Worker URL is configured. Run `uptime login` first.'),
      );
    }
    if (!token) {
      return yield* Effect.fail(
        new Error('No API token is configured. Run `uptime login` first.'),
      );
    }
    return {
      baseUrl: yield* validateBaseUrl(baseUrl),
      token: yield* validateToken(token),
    };
  });
}

function storedConfig() {
  return Effect.try({
    try: () => readCliConfig(),
    catch: (cause) => new Error(`Could not load CLI configuration: ${errorMessage(cause)}`),
  });
}

function validateBaseUrl(value: string) {
  return Effect.try({
    try: () => normalizeBaseUrl(value),
    catch: (cause) => errorMessage(cause),
  });
}

function validateToken(value: string) {
  return Effect.try({
    try: () => normalizeToken(value),
    catch: (cause) => errorMessage(cause),
  });
}

function errorMessage(error: unknown) {
  if (typeof error === 'object' && error !== null && '_tag' in error && typeof error._tag === 'string') {
    if (error._tag === 'NotFound') return 'Resource not found. Check the project or monitor slug and try again.';
    if (error._tag === 'Unauthorized') return 'Authentication failed. Run `uptime login` to update saved credentials.';
    if (error._tag === 'InternalServerError') return 'The uptime Worker encountered an internal error.';
    return error._tag.replaceAll(/([a-z])([A-Z])/g, '$1 $2');
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error) || 'The command failed without an error message.';
}

function isShowHelp(error: unknown) {
  return typeof error === 'object' && error !== null && '_tag' in error && error._tag === 'ShowHelp';
}

function printJson(value: unknown) {
  return Console.log(JSON.stringify(value, null, 2));
}

function printValue(value: unknown, output: { readonly json: boolean }, format: () => string) {
  return output.json ? printJson(value) : Console.log(format());
}

function agentOutput(command: string, payload: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    command,
    generatedAt: new Date().toISOString(),
    ...payload,
  };
}

function summarizeMonitors(monitors: Parameters<typeof formatMonitorList>[0]) {
  return {
    total: monitors.length,
    byStatus: {
      healthy: monitors.filter((monitor) => monitor.status === 'healthy').length,
      suspect: monitors.filter((monitor) => monitor.status === 'suspect').length,
      down: monitors.filter((monitor) => monitor.status === 'down').length,
      recovering: monitors.filter((monitor) => monitor.status === 'recovering').length,
      uninitialized: monitors.filter((monitor) => monitor.status === 'uninitialized').length,
      disabled: monitors.filter((monitor) => monitor.status === 'disabled').length,
    },
  };
}

function collectExpectation(
  discovery: DiscoveryResult,
  input: {
    readonly expectedStatus: Option.Option<number>;
    readonly expectedBody: Option.Option<string>;
  },
  interactive: boolean,
) {
  if (Option.isSome(input.expectedStatus) || Option.isSome(input.expectedBody)) {
    return Effect.succeed({
      expectedStatus: Option.getOrElse(input.expectedStatus, () => discovery.suggestedStatus),
      expectedBody: Option.getOrNull(input.expectedBody),
    });
  }
  if (!interactive) {
    if (!discovery.reachable)
      return Effect.fail(
        new Error(`The discovery check failed: ${discovery.error}. Pass --expected-status to continue explicitly.`),
      );
    return Effect.succeed({
      expectedStatus: discovery.suggestedStatus,
      expectedBody: discovery.suggestedBody,
    });
  }
  return Prompt.run(
    Prompt.select({
      message: 'Is this health expectation correct?',
      choices: [
        ...(discovery.suggestedBody === null
          ? []
          : [
              {
                title: `HTTP ${discovery.suggestedStatus} and exact body ${JSON.stringify(discovery.suggestedBody)}`,
                value: 'suggested' as const,
              },
            ]),
        { title: `HTTP ${discovery.suggestedStatus} only`, value: 'status' as const },
        { title: 'Customize…', value: 'custom' as const },
      ],
    }),
  ).pipe(
    Effect.flatMap((choice) => {
      if (choice === 'suggested') {
        return Effect.succeed({
          expectedStatus: discovery.suggestedStatus,
          expectedBody: discovery.suggestedBody,
        });
      }
      if (choice === 'status') {
        return Effect.succeed({ expectedStatus: discovery.suggestedStatus, expectedBody: null });
      }
      return Effect.gen(function* () {
        const expectedStatus = Number(
          yield* Prompt.run(
            Prompt.text({
              message: 'Expected HTTP status',
              default: String(discovery.suggestedStatus),
              validate: validateStatus,
            }),
          ),
        );
        const expectedBody = yield* Prompt.run(
          Prompt.text({ message: 'Expected exact body (leave empty to ignore)', default: '' }),
        );
        return { expectedStatus, expectedBody: expectedBody || null };
      });
    }),
  );
}

function formatDiscovery(discovery: DiscoveryResult) {
  if (!discovery.reachable) return `\nDiscovery check failed after ${discovery.latencyMs}ms\n  ${discovery.error}`;
  const body = discovery.body?.replaceAll(/\s+/g, ' ').trim();
  return `\nDiscovery check\n  HTTP ${discovery.statusCode} · ${discovery.latencyMs}ms · ${discovery.contentType ?? 'unknown content type'}${body ? `\n  Body: ${JSON.stringify(body.slice(0, 160))}${body.length > 160 ? '…' : ''}` : ''}`;
}

function ensureMonitorSlugAvailable(slug: string) {
  return validateSlug(slug).pipe(
    Effect.andThen(
      withClient((client) => client.Monitors.list({ query: { limit: 500 } })).pipe(
        Effect.flatMap((page) =>
          page.items.some((monitor) => monitor.config.slug.toLowerCase() === slug.toLowerCase())
            ? Effect.fail(new Error(`The monitor slug ${JSON.stringify(slug)} already exists. Choose another slug.`))
            : Effect.succeed(slug),
        ),
      ),
    ),
  );
}

function chooseProject() {
  return Effect.gen(function* () {
    const projects = yield* withClient((client) => client.Projects.list({}));
    const selected = yield* Prompt.run(
      Prompt.select({
        message: 'Project',
        choices: [
          { title: 'None', value: '__none__' },
          ...projects.map((project) => ({ title: `${project.name} (${project.id})`, value: project.id })),
          { title: 'Create a new project…', value: '__create__' },
        ],
      }),
    );
    if (selected === '__none__') return null;
    if (selected !== '__create__') return selected;
    const name = yield* Prompt.run(Prompt.text({ message: 'Project name', validate: validateName }));
    const slug = slugify(
      yield* Prompt.run(Prompt.text({ message: 'Project slug', default: slugify(name), validate: validateSlugInput })),
    );
    if (projects.some((project) => project.id.toLowerCase() === slug.toLowerCase())) {
      return yield* Effect.fail(new Error(`The project slug ${JSON.stringify(slug)} already exists.`));
    }
    yield* withClient((client) => client.Projects.upsert({ params: { id: slug }, payload: { name } }));
    return slug;
  });
}

function canPrompt(output: { readonly json: boolean; readonly noInput: boolean }) {
  return !output.json && !output.noInput && process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function requireText(
  value: Option.Option<string>,
  name: string,
  output: { readonly json: boolean; readonly noInput: boolean },
  prompt: {
    readonly message: string;
    readonly validate: (value: string) => Effect.Effect<string, string>;
  },
) {
  if (Option.isSome(value)) return prompt.validate(value.value).pipe(Effect.mapError((message) => new Error(message)));
  if (!canPrompt(output))
    return Effect.fail(new Error(`Missing ${name}. Pass it explicitly or run in an interactive terminal.`));
  return Prompt.run(Prompt.text(prompt));
}

function collectAlertInput(
  output: { readonly json: boolean; readonly noInput: boolean },
  input?: {
    readonly alertID?: Option.Option<string>;
    readonly type?: Option.Option<'email' | 'webhook'>;
    readonly destination?: Option.Option<string>;
    readonly events?: Option.Option<string>;
  },
) {
  return Effect.gen(function* () {
    const interactive = canPrompt(output);
    const type = Option.isSome(input?.type ?? Option.none())
      ? (input?.type as Option.Some<'email' | 'webhook'>).value
      : interactive
        ? yield* Prompt.run(
            Prompt.select({
              message: 'Alert type',
              choices: [
                { title: 'Email', value: 'email' as const },
                { title: 'Webhook', value: 'webhook' as const },
              ],
            }),
          )
        : yield* Effect.fail(new Error('Missing alert type. Pass --type email or --type webhook.'));
    const id = yield* requireText(input?.alertID ?? Option.none(), 'alert ID', output, {
      message: 'Alert ID',
      validate: validateMonitorID,
    });
    const destination = yield* requireText(input?.destination ?? Option.none(), `${type} destination`, output, {
      message: type === 'email' ? 'Email address' : 'Webhook URL',
      validate: type === 'email' ? validateEmail : validateWebhookUrl,
    });
    const events = Option.isSome(input?.events ?? Option.none())
      ? yield* parseEvents((input?.events as Option.Some<string>).value)
      : interactive
        ? yield* Prompt.run(
            Prompt.multiSelect({
              message: 'Notify when',
              min: 1,
              choices: [
                { title: 'Down', value: 'down' as const, selected: true },
                { title: 'Recovered', value: 'recovered' as const, selected: true },
              ],
            }),
          )
        : (['down', 'recovered'] as const);
    return { id, type, destination, events };
  });
}

function validateMonitorID(value: string) {
  return Effect.suspend(() =>
    /^[a-z0-9][a-z0-9-]{0,62}$/.test(value)
      ? Effect.succeed(value)
      : Effect.fail('Use 1-63 lowercase letters, numbers, or dashes.'),
  );
}

function validateName(value: string) {
  return value.trim().length > 0 ? Effect.succeed(value.trim()) : Effect.fail('Enter a name.');
}

function validateSlugInput(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(value)
    ? Effect.succeed(value)
    : Effect.fail('Use 1-63 URL-safe letters, numbers, or dashes.');
}

function validateSlug(value: string) {
  return Effect.suspend(() =>
    /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(value)
      ? Effect.succeed(value)
      : Effect.fail(new Error('Use 1-63 URL-safe letters, numbers, or dashes.')),
  );
}

function slugify(value: string) {
  return value
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 63);
}

function validateHttpUrl(value: string) {
  return Effect.suspend(() =>
    /^https?:\/\//.test(value) ? Effect.succeed(value) : Effect.fail('Enter an HTTP(S) URL.'),
  );
}

function validateWebhookUrl(value: string) {
  return Effect.suspend(() =>
    value.startsWith('https://') ? Effect.succeed(value) : Effect.fail('Webhook URLs must use HTTPS.'),
  );
}

function validateEmail(value: string) {
  return Effect.suspend(() =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? Effect.succeed(value) : Effect.fail('Enter a valid email address.'),
  );
}

function validateStatus(value: string) {
  return Effect.suspend(() => {
    const status = Number(value);
    return Number.isInteger(status) && status >= 100 && status <= 599
      ? Effect.succeed(value)
      : Effect.fail('Enter an HTTP status between 100 and 599.');
  });
}

function parseEvents(value: string) {
  const events = [...new Set(value.split(',').map((event) => event.trim()))];
  if (events.length > 0 && events.every((event) => event === 'down' || event === 'recovered')) {
    return Effect.succeed(events as readonly ('down' | 'recovered')[]);
  }
  return Effect.fail(new Error('Events must be a comma-separated subset of down,recovered.'));
}

function parseSince(value: string, until: number) {
  const match = /^(\d+)(m|h|d|w)$/.exec(value);
  if (!match) return parseTimestamp(value);
  const unit = match[2] === 'm' ? 60_000 : match[2] === 'h' ? 3_600_000 : match[2] === 'd' ? 86_400_000 : 604_800_000;
  return Effect.succeed(until - Number(match[1]) * unit);
}

function parseTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp)
    ? Effect.fail(new Error(`Invalid time ${JSON.stringify(value)}. Use a duration such as 30d or an ISO timestamp.`))
    : Effect.succeed(timestamp);
}

function maskCliDestination(type: 'email' | 'webhook', destination: string) {
  if (type === 'email') return destination;
  const url = new URL(destination);
  return `${url.protocol}//${url.host}/••••`;
}

function colorsEnabled() {
  return process.stdout.isTTY && process.env.NO_COLOR === undefined;
}

function interactiveHistory(
  monitor: Parameters<typeof formatHistoryFrame>[0],
  checks: Parameters<typeof formatHistoryFrame>[1],
  verbose: boolean,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const terminal = yield* Terminal.Terminal;
      const input = yield* terminal.readInput;
      yield* terminal.display('\u001b[?25l');
      yield* Effect.addFinalizer(() => terminal.display('\u001b[?25h\n').pipe(Effect.orDie));

      const render = (selected: number): Effect.Effect<void, never, never> =>
        terminal
          .display(
            `\u001b[2J\u001b[H${formatHistoryFrame(monitor, checks, selected, colorsEnabled(), process.stdout.columns ?? 72, verbose)}`,
          )
          .pipe(
            Effect.orDie,
            Effect.andThen(Queue.take(input)),
            Effect.flatMap((event) => {
              if (event.key.name === 'q' || event.key.name === 'escape' || event.key.name === 'return')
                return Effect.void;
              if (event.key.name === 'left' || event.key.name === 'up') return render(Math.max(0, selected - 1));
              if (event.key.name === 'right' || event.key.name === 'down') {
                return render(Math.min(checks.length - 1, selected + 1));
              }
              if (event.key.name === 'home') return render(0);
              if (event.key.name === 'end') return render(checks.length - 1);
              return render(selected);
            }),
            Effect.catchCause(() => Effect.void),
          );

      yield* render(checks.length - 1);
    }),
  );
}
