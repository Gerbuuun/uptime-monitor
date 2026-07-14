import { providers } from 'alchemy/Cloudflare';
import { state } from 'alchemy/Cloudflare/StateStore';
import { Stack } from 'alchemy/Stack';
import * as Effect from 'effect/Effect';

import WorkerLive, { UptimeWorker } from './src/worker.ts';

export default Stack(
  'Uptime',
  { providers: providers(), state: state() },
  Effect.gen(function* () {
    const { name, stage } = yield* Stack;
    const worker = yield* UptimeWorker;
    return {
      name,
      stage,
      workerName: worker.workerName,
      workerId: worker.workerId,
      url: worker.url,
    };
  }).pipe(Effect.provide(WorkerLive)),
);
