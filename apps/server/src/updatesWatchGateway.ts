/**
 * Refcounted watch/unwatch for Chat3 update streams.
 * unwatch = release ref; stream cancelled when ref hits 0.
 */

export type WatchScope =
  | { kind: 'user'; tenantId: string; userId: string }
  | { kind: 'tenants'; tenantIds: string[] }
  | { kind: 'all' };

export function watchScopeKey(scope: WatchScope): string {
  if (scope.kind === 'user') {
    return `user:${scope.tenantId}:${scope.userId}`;
  }
  if (scope.kind === 'tenants') {
    const ids = Array.from(
      new Set(scope.tenantIds.map((id) => String(id).trim()).filter(Boolean))
    ).sort();
    return `tenants:${ids.join(',')}`;
  }
  return 'all';
}

export type StreamHandle = {
  cancel: () => void;
  on: (event: 'data' | 'error' | 'end', cb: (...args: any[]) => void) => void;
};

export type OpenStream = (scope: WatchScope) => StreamHandle;

type Entry = {
  scope: WatchScope;
  refCount: number;
  stream: StreamHandle;
  listeners: Set<(update: any) => void>;
  onData: (update: any) => void;
};

/**
 * BFF gateway: watchUpdates(scope) / unwatch via returned disposer.
 * Multiple watchers on same scope share one Chat3 stream (refcount).
 */
export class UpdatesWatchGateway {
  private entries = new Map<string, Entry>();

  constructor(private readonly openStream: OpenStream) {}

  /**
   * Start (or join) a Chat3 stream for scope. Returns unwatch().
   * Fan-out: each listener gets every update from the shared stream.
   */
  watch(scope: WatchScope, onUpdate: (update: any) => void): () => void {
    const key = watchScopeKey(scope);
    let entry = this.entries.get(key);

    if (!entry) {
      const listeners = new Set<(update: any) => void>();
      const onData = (update: any) => {
        for (const listener of listeners) {
          try {
            listener(update);
          } catch (err) {
            console.error('[UpdatesWatchGateway] listener error', err);
          }
        }
      };
      const stream = this.openStream(scope);
      stream.on('data', onData);
      stream.on('error', (err: Error) => {
        console.error('[UpdatesWatchGateway] stream error', key, err.message);
      });
      entry = { scope, refCount: 0, stream, listeners, onData };
      this.entries.set(key, entry);
    }

    entry.refCount += 1;
    entry.listeners.add(onUpdate);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.entries.get(key);
      if (!current) return;
      current.listeners.delete(onUpdate);
      current.refCount -= 1;
      if (current.refCount <= 0) {
        try {
          current.stream.cancel();
        } catch {
          /* ignore */
        }
        this.entries.delete(key);
      }
    };
  }

  /** Test / diagnostics */
  refCount(scope: WatchScope): number {
    return this.entries.get(watchScopeKey(scope))?.refCount ?? 0;
  }

  size(): number {
    return this.entries.size;
  }
}
