import type { RuntimeContext } from 'alchemy/RuntimeContext';
import * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schedule from 'effect/Schedule';

import type { AlertType } from './domain.ts';
import { type EmailMessage, EmailSender } from './email.ts';

export interface NotificationMessage {
  readonly actionID: string;
  readonly monitorID: string;
  readonly monitorName: string;
  readonly incidentID: string;
  readonly kind: 'down' | 'recovered';
  readonly url: string;
  readonly occurredAt: number;
  readonly error: string | null;
  readonly alert: {
    readonly type: AlertType;
    readonly destination: string;
  };
}

export class NotificationError extends Data.TaggedError('NotificationError')<{
  readonly cause: unknown;
}> {}

export class Notification extends Context.Service<
  Notification,
  {
    readonly defaultEmailAddress: string | null;
    readonly send: (message: NotificationMessage) => Effect.Effect<void, NotificationError, RuntimeContext>;
  }
>()('@UptimeMonitor/Notification') {}

export const NotificationLive = Layer.effect(
  Notification,
  Effect.gen(function* () {
    const email = yield* EmailSender;
    const to = yield* Config.option(Config.string('UPTIME_ALERT_TO'));
    const from = yield* Config.string('UPTIME_ALERT_FROM');

    return Notification.of({
      defaultEmailAddress: Option.getOrNull(to),
      send: (message) =>
        (message.alert.type === 'email'
          ? email
              .send(
                {
                  from: { email: from, name: 'Uptime Monitor' },
                  to: message.alert.destination,
                  subject:
                    message.kind === 'down' ? `[DOWN] ${message.monitorName}` : `[RECOVERED] ${message.monitorName}`,
                  text: formatMessage(message),
                  headers: { 'x-uptime-action-id': message.actionID },
                },
              )
              .pipe(Effect.mapError((cause) => new NotificationError({ cause })))
          : Effect.tryPromise({
              try: (signal) =>
                fetch(message.alert.destination, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', 'user-agent': 'uptime-monitor/1.0' },
                  body: JSON.stringify({
                    actionID: message.actionID,
                    monitor: { id: message.monitorID, name: message.monitorName, url: message.url },
                    incidentID: message.incidentID,
                    event: message.kind,
                    occurredAt: new Date(message.occurredAt).toISOString(),
                    error: message.error,
                  }),
                  signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
                }).then(async (response) => {
                  await response.body?.cancel();
                  if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
                }),
              catch: (cause) => new NotificationError({ cause }),
            })
        ).pipe(Effect.retry({ schedule: Schedule.exponential('1 second'), times: 3 }), Effect.asVoid),
    });
  }),
);

function formatMessage(message: NotificationMessage) {
  return [
    `${message.monitorName} is ${message.kind === 'down' ? 'DOWN' : 'healthy again'}.`,
    '',
    `Monitor: ${message.monitorID}`,
    `URL: ${message.url}`,
    `Incident: ${message.incidentID}`,
    `Time: ${new Date(message.occurredAt).toISOString()}`,
    ...(message.error ? [`Error: ${message.error}`] : []),
  ].join('\n');
}
