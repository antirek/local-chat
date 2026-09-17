import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  UpdatesWatchGateway,
  watchScopeKey,
  type StreamHandle,
  type WatchScope
} from './updatesWatchGateway.js';

function fakeStream(): StreamHandle & { emit: (u: any) => void; cancelled: boolean } {
  const handlers: Record<string, Array<(...args: any[]) => void>> = {};
  return {
    cancelled: false,
    cancel() {
      this.cancelled = true;
    },
    on(event, cb) {
      (handlers[event] ||= []).push(cb);
    },
    emit(u: any) {
      for (const cb of handlers.data || []) cb(u);
    }
  };
}

describe('UpdatesWatchGateway', () => {
  it('watchScopeKey distinguishes scopes', () => {
    assert.equal(
      watchScopeKey({ kind: 'user', tenantId: 't1', userId: 'u1' }),
      'user:t1:u1'
    );
    assert.equal(watchScopeKey({ kind: 'all' }), 'all');
    assert.equal(
      watchScopeKey({ kind: 'tenants', tenantIds: ['b', 'a'] }),
      'tenants:a,b'
    );
  });

  it('refcount shares one stream and cancels on last unwatch', () => {
    const opened: WatchScope[] = [];
    let stream = fakeStream();
    const gateway = new UpdatesWatchGateway((scope) => {
      opened.push(scope);
      stream = fakeStream();
      return stream;
    });

    const scope: WatchScope = { kind: 'user', tenantId: 'tnt', userId: 'alice' };
    const receivedA: any[] = [];
    const receivedB: any[] = [];

    const unwatchA = gateway.watch(scope, (u) => receivedA.push(u));
    const unwatchB = gateway.watch(scope, (u) => receivedB.push(u));

    assert.equal(opened.length, 1);
    assert.equal(gateway.refCount(scope), 2);

    stream.emit({ user_id: 'alice', n: 1 });
    assert.deepEqual(receivedA, [{ user_id: 'alice', n: 1 }]);
    assert.deepEqual(receivedB, [{ user_id: 'alice', n: 1 }]);

    unwatchA();
    assert.equal(gateway.refCount(scope), 1);
    assert.equal(stream.cancelled, false);

    unwatchB();
    assert.equal(gateway.refCount(scope), 0);
    assert.equal(stream.cancelled, true);
    assert.equal(gateway.size(), 0);
  });

  it('different scopes open different streams', () => {
    let opens = 0;
    const gateway = new UpdatesWatchGateway(() => {
      opens += 1;
      return fakeStream();
    });

    const u1 = gateway.watch(
      { kind: 'user', tenantId: 't', userId: 'a' },
      () => {}
    );
    const u2 = gateway.watch(
      { kind: 'tenants', tenantIds: ['t'] },
      () => {}
    );
    assert.equal(opens, 2);
    u1();
    u2();
  });
});
