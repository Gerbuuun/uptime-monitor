import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { HttpApiError } from 'effect/unstable/httpapi';

import { Authorization } from './api.ts';

export function authorizationLayer(token: Redacted.Redacted) {
  return Layer.effect(
    Authorization,
    Effect.gen(function* () {
      const expected = yield* digest(Redacted.value(token));

      return Authorization.of({
        bearer: Effect.fn(function* (httpEffect, { credential }) {
          const actual = yield* digest(Redacted.value(credential));
          if (!crypto.subtle.timingSafeEqual(expected, actual)) {
            return yield* new HttpApiError.Unauthorized();
          }
          return yield* httpEffect;
        }),
      });
    }),
  );
}

function digest(value: string) {
  return Effect.promise(() => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).pipe(
    Effect.map((hash) => new Uint8Array(hash)),
  );
}
