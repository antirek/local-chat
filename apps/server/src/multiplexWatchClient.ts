/**
 * Client-side multiplex WatchUpdates session for local-chat BFF.
 * One bidi stream; watch/unwatch personal users with local refcount.
 */
import type * as grpc from '@grpc/grpc-js';

export type MultiplexUserKey = string;

export function multiplexUserKey(tenantId: string, userId: string): MultiplexUserKey {
  return `${tenantId}:${userId}`;
}

type UserEntry = {
  tenantId: string;
  userId: string;
  refCount: number;
  listeners: Set<(update: any) => void>;
};

export type MultiplexWatchClientOpts = {
  /** Open a new WatchUpdates duplex call (metadata already set). */
  openCall: () => grpc.ClientDuplexStream<any, any>;
  userType?: string;
};

/**
 * Manages one WatchUpdates stream and fans out updates by (tenant,user).
 */
export class MultiplexWatchClient {
  private call: grpc.ClientDuplexStream<any, any> | null = null;
  private users = new Map<MultiplexUserKey, UserEntry>();
  private started = false;
  private starting: Promise<void> | null = null;
  private readonly userType: string;
  /** Test/diagnostics: how many times openCall was invoked. */
  openCount = 0;

  constructor(private readonly opts: MultiplexWatchClientOpts) {
    this.userType = opts.userType || 'user';
  }

  /** Number of distinct watched users. */
  size(): number {
    return this.users.size;
  }

  refCount(tenantId: string, userId: string): number {
    return this.users.get(multiplexUserKey(tenantId, userId))?.refCount ?? 0;
  }

  /**
   * Watch a user; returns unwatch disposer.
   * First ref opens/ensures stream + sends watch; last ref sends unwatch.
   */
  watch(tenantId: string, userId: string, onUpdate: (update: any) => void): () => void {
    const key = multiplexUserKey(tenantId, userId);
    let entry = this.users.get(key);
    if (!entry) {
      entry = {
        tenantId,
        userId,
        refCount: 0,
        listeners: new Set()
      };
      this.users.set(key, entry);
      void this.ensureStarted()
        .then(() => this.writeWatch(tenantId, [userId]))
        .catch((err) => console.error('[MultiplexWatchClient] watch failed', err));
    }

    entry.refCount += 1;
    entry.listeners.add(onUpdate);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.users.get(key);
      if (!current) return;
      current.listeners.delete(onUpdate);
      current.refCount -= 1;
      if (current.refCount <= 0) {
        this.users.delete(key);
        void this.writeUnwatch(tenantId, [userId]).catch((err) =>
          console.error('[MultiplexWatchClient] unwatch failed', err)
        );
        // Idle: keep stream open (plan policy).
      }
    };
  }

  /** Force-close bidi (e.g. process shutdown). */
  close(): void {
    try {
      this.call?.end();
      this.call?.cancel();
    } catch {
      /* ignore */
    }
    this.call = null;
    this.started = false;
    this.starting = null;
    this.users.clear();
  }

  private ensureStarted(): Promise<void> {
    if (this.started && this.call) return Promise.resolve();
    if (this.starting) return this.starting;

    this.starting = new Promise<void>((resolve, reject) => {
      try {
        this.openCount += 1;
        const call = this.opts.openCall();
        this.call = call;

        const onEstablished = (update: any) => {
          const type = update?.source_event_type || '';
          if (type === 'connection.established') {
            this.started = true;
            resolve();
          }
        };

        call.on('data', (update: any) => {
          onEstablished(update);
          this.routeUpdate(update);
        });

        call.on('error', (err: Error) => {
          console.error('[MultiplexWatchClient] stream error', err.message);
          this.handleDisconnect();
          if (!this.started) reject(err);
        });

        call.on('end', () => {
          this.handleDisconnect();
        });

        // Safety timeout
        setTimeout(() => {
          if (!this.started) {
            reject(new Error('MultiplexWatchClient: established timeout'));
          }
        }, 15000);
      } catch (err) {
        reject(err);
      }
    }).finally(() => {
      this.starting = null;
    });

    return this.starting;
  }

  private handleDisconnect(): void {
    const snapshot = Array.from(this.users.values()).map((e) => ({
      tenantId: e.tenantId,
      userId: e.userId
    }));
    this.call = null;
    this.started = false;

    if (snapshot.length === 0) return;

    // Resync: reopen and re-watch active users
    void this.ensureStarted()
      .then(async () => {
        const byTenant = new Map<string, string[]>();
        for (const u of snapshot) {
          const list = byTenant.get(u.tenantId) || [];
          list.push(u.userId);
          byTenant.set(u.tenantId, list);
        }
        for (const [tenantId, userIds] of byTenant) {
          await this.writeWatch(tenantId, userIds);
        }
      })
      .catch((err) => console.error('[MultiplexWatchClient] resync failed', err));
  }

  private routeUpdate(update: any): void {
    const type = update?.source_event_type || '';
    if (
      type === 'connection.established' ||
      type === 'watch.ack' ||
      type === 'unwatch.ack' ||
      type === 'watch.error'
    ) {
      return;
    }
    const tenantId = update?.tenant_id || '';
    const userId = update?.user_id || '';
    const entry = this.users.get(multiplexUserKey(tenantId, userId));
    if (!entry) return;
    for (const listener of entry.listeners) {
      try {
        listener(update);
      } catch (err) {
        console.error('[MultiplexWatchClient] listener error', err);
      }
    }
  }

  private writeWatch(tenantId: string, userIds: string[]): Promise<void> {
    return this.write({
      watch: {
        tenant_id: tenantId,
        user_ids: userIds,
        user_type: this.userType
      }
    });
  }

  private writeUnwatch(tenantId: string, userIds: string[]): Promise<void> {
    return this.write({
      unwatch: {
        tenant_id: tenantId,
        user_ids: userIds,
        user_type: this.userType
      }
    });
  }

  private async write(msg: Record<string, unknown>): Promise<void> {
    await this.ensureStarted();
    if (!this.call) throw new Error('MultiplexWatchClient: no call');
    this.call.write(msg);
  }
}
