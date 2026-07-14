import * as Context from 'effect/Context';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import type { DiscoveryResult, MonitorConfig, ProbeResult } from './domain.ts';

class ProbeRequestError extends Data.TaggedError('ProbeRequestError')<{
  readonly message: string;
}> {}

export class Probe extends Context.Service<
  Probe,
  {
    readonly check: (config: MonitorConfig) => Effect.Effect<ProbeResult>;
    readonly discover: (url: string, timeoutMs: number) => Effect.Effect<DiscoveryResult>;
  }
>()('@UptimeMonitor/Probe') {
  static readonly layer = Layer.succeed(
    Probe,
    Probe.of({
      check: (config) => {
        const checkedAt = Date.now();
        return Effect.tryPromise({
          try: async () => {
            const response = await fetch(config.url, {
              headers: { 'cache-control': 'no-cache', 'user-agent': 'uptime-monitor/1.0' },
              redirect: 'manual',
              signal: AbortSignal.timeout(config.timeoutMs),
            });
            const body = await readBoundedBody(response, 4_096);
            const statusMatches = response.status === config.expectedStatus;
            const bodyMatches = config.expectedBody === null || body.trim() === config.expectedBody;

            return {
              checkedAt,
              successful: statusMatches && bodyMatches,
              statusCode: response.status,
              latencyMs: Date.now() - checkedAt,
              error: statusMatches ? (bodyMatches ? null : 'response-body-mismatch') : 'unexpected-status-code',
              body,
            } satisfies ProbeResult;
          },
          catch: (error) =>
            new ProbeRequestError({
              message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            }),
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              checkedAt,
              successful: false,
              statusCode: null,
              latencyMs: Date.now() - checkedAt,
              error: error.message.slice(0, 512),
              body: null,
            }),
          ),
        );
      },
      discover: (url, timeoutMs) => {
        const checkedAt = Date.now();
        return request(url, timeoutMs).pipe(
          Effect.map((response) => {
            const body = response.body.trim();
            const contentType = response.contentType?.split(';')[0] ?? null;
            return {
              checkedAt,
              reachable: true,
              statusCode: response.statusCode,
              latencyMs: Date.now() - checkedAt,
              contentType,
              body: response.body,
              error: null,
              suggestedStatus: response.statusCode,
              suggestedBody: contentType === 'text/plain' && body.length > 0 && body.length <= 256 ? body : null,
            } satisfies DiscoveryResult;
          }),
          Effect.catch((error) =>
            Effect.succeed({
              checkedAt,
              reachable: false,
              statusCode: null,
              latencyMs: Date.now() - checkedAt,
              contentType: null,
              body: null,
              error: error.message.slice(0, 512),
              suggestedStatus: 200,
              suggestedBody: null,
            } satisfies DiscoveryResult),
          ),
        );
      },
    }),
  );
}

function request(url: string, timeoutMs: number) {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        headers: { 'cache-control': 'no-cache', 'user-agent': 'uptime-monitor/1.0' },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      return {
        statusCode: response.status,
        contentType: response.headers.get('content-type'),
        body: await readBoundedBody(response, 4_096),
      };
    },
    catch: (error) =>
      new ProbeRequestError({
        message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }),
  });
}

async function readBoundedBody(response: Response, limit: number) {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;

  while (bytes < limit) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const remaining = limit - bytes;
    parts.push(decoder.decode(chunk.value.subarray(0, remaining), { stream: chunk.value.length <= remaining }));
    bytes += Math.min(chunk.value.length, remaining);
    if (chunk.value.length > remaining) {
      await reader.cancel('response body exceeded monitor capture limit');
      break;
    }
  }

  parts.push(decoder.decode());
  return parts.join('');
}
