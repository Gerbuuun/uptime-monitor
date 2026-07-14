import { Send, SendBinding, SendEmail, type SendEmailProps } from 'alchemy/Cloudflare/Email';
import type { RuntimeContext } from 'alchemy/RuntimeContext';
import * as Context from 'effect/Context';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

export interface EmailMessage {
  readonly from: { readonly email: string; readonly name: string };
  readonly to: string | readonly string[];
  readonly replyTo?: { readonly email: string; readonly name: string } | string;
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export class EmailSendError extends Data.TaggedError('EmailSendError')<{
  readonly cause: unknown;
}> {}

export class EmailSender extends Context.Service<
  EmailSender,
  {
    readonly send: (message: EmailMessage) => Effect.Effect<void, EmailSendError, RuntimeContext>;
  }
>()('@UptimeMonitor/EmailSender') {}

export const cloudflare = (id: string, props?: SendEmailProps) =>
  Layer.effect(
    EmailSender,
    Effect.gen(function* () {
      const sender = yield* SendEmail(id, props);
      const email = yield* Send(sender);
      return EmailSender.of({
        send: (message) =>
          email
            .send({
              to: typeof message.to === 'string' ? message.to : [...message.to],
              from: message.from,
              replyTo: message.replyTo,
              subject: message.subject,
              text: message.text,
              html: message.html,
              headers: message.headers,
            })
            .pipe(Effect.mapError((cause) => new EmailSendError({ cause })), Effect.asVoid),
      });
    }),
  ).pipe(Layer.provide(SendBinding));
