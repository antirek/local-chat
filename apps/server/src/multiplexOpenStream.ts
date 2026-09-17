/**
 * Adapt MultiplexWatchClient to UpdatesWatchGateway OpenStream for user scopes.
 */
import type { StreamHandle, WatchScope, OpenStream } from './updatesWatchGateway.js';
import type { MultiplexWatchClient } from './multiplexWatchClient.js';

export function createMultiplexOpenStream(
  multiplex: MultiplexWatchClient,
  fallback: OpenStream
): OpenStream {
  return (scope: WatchScope): StreamHandle => {
    if (scope.kind !== 'user') {
      return fallback(scope);
    }

    const handlers: Record<string, Array<(...args: any[]) => void>> = {};
    let unwatchMux: (() => void) | null = null;
    let cancelled = false;

    const handle: StreamHandle = {
      cancel() {
        if (cancelled) return;
        cancelled = true;
        unwatchMux?.();
        unwatchMux = null;
      },
      on(event, cb) {
        (handlers[event] ||= []).push(cb);
      }
    };

    unwatchMux = multiplex.watch(scope.tenantId, scope.userId, (update) => {
      for (const cb of handlers.data || []) {
        try {
          cb(update);
        } catch {
          /* ignore */
        }
      }
    });

    return handle;
  };
}
