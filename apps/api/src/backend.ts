import { DiscoveryStore, PoolDatabase, runDiscoveryLoop, type WorkerAdapters, type WorkerOptions } from '@tastecase/worker';
import { buildServer, type ServerOptions } from './server.js';

export interface BackendOptions extends Omit<ServerOptions, 'workerReady'> {
  adapters: WorkerAdapters;
  workerOptions?: WorkerOptions;
  workerLoop?: typeof runDiscoveryLoop;
}

/** One caller-owned pool and persistent process. Tests inject adapters, never production auth. */
export function buildBackend(options: BackendOptions) {
  const controller = new AbortController();
  let running = false;
  let worker: Promise<void> | undefined;
  const app = buildServer({ ...options, workerReady: () => running });
  const startWorker = () => {
    if (controller.signal.aborted) throw new Error('Backend already closed.');
    if (!worker) {
      running = true;
      worker = Promise.resolve().then(() => (options.workerLoop ?? runDiscoveryLoop)(
        new DiscoveryStore(new PoolDatabase(options.pool)), options.adapters, controller.signal, options.workerOptions,
      )).finally(() => { running = false; });
      // Readiness exposes failures; callers may also await the original promise.
      void worker.catch(() => {});
    }
    return worker;
  };
  app.addHook('preClose', async () => {
    running = false;
    controller.abort();
  });
  app.addHook('onClose', async () => {
    await worker?.catch(() => {});
  });
  return { app, startWorker };
}
