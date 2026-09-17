import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MultiplexWatchClient } from './multiplexWatchClient.js';
import { createMultiplexOpenStream } from './multiplexOpenStream.js';
import { UpdatesWatchGateway, type StreamHandle } from './updatesWatchGateway.js';

class FakeDuplex extends EventEmitter {
  writes: any[] = [];
  cancelled = false;
  write(msg: any) {
    this.writes.push(msg);
    return true;
  }
  end() {
    this.emit('end');
  }
  cancel() {
    this.cancelled = true;
  }
}

describe('MultiplexWatchClient', () => {
  it('G1/G2/G3 refcount watch/unwatch commands', async () => {
    let duplex: FakeDuplex | null = null;
    const client = new MultiplexWatchClient({
      openCall: () => {
        duplex = new FakeDuplex() as any;
        queueMicrotask(() => {
          duplex!.emit('data', {
            source_event_type: 'connection.established',
            data: { conn_id: 'c1', scope: 'multiplex' }
          });
        });
        return duplex as any;
      }
    });

    const a1 = client.watch('tnt', 'alice', () => {});
    const a2 = client.watch('tnt', 'alice', () => {});
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(client.openCount, 1);
    assert.equal(client.refCount('tnt', 'alice'), 2);
    const watchWrites = duplex!.writes.filter((w) => w.watch);
    assert.equal(watchWrites.length, 1);

    a1();
    assert.equal(client.refCount('tnt', 'alice'), 1);
    assert.equal(duplex!.writes.filter((w) => w.unwatch).length, 0);

    a2();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(client.refCount('tnt', 'alice'), 0);
    assert.equal(duplex!.writes.filter((w) => w.unwatch).length, 1);
    // idle: stream not cancelled
    assert.equal(duplex!.cancelled, false);
  });

  it('G4 routes update only to matching user', async () => {
    let duplex: FakeDuplex | null = null;
    const client = new MultiplexWatchClient({
      openCall: () => {
        duplex = new FakeDuplex() as any;
        queueMicrotask(() => {
          duplex!.emit('data', { source_event_type: 'connection.established' });
        });
        return duplex as any;
      }
    });

    const aliceMsgs: any[] = [];
    const bobMsgs: any[] = [];
    client.watch('tnt', 'alice', (u) => aliceMsgs.push(u));
    client.watch('tnt', 'bob', (u) => bobMsgs.push(u));
    await new Promise((r) => setTimeout(r, 30));

    duplex!.emit('data', {
      source_event_type: 'message.create',
      tenant_id: 'tnt',
      user_id: 'bob',
      update_id: '1'
    });

    assert.equal(aliceMsgs.length, 0);
    assert.equal(bobMsgs.length, 1);
  });
});

describe('createMultiplexOpenStream + gateway', () => {
  it('user scopes use multiplex; tenants use fallback', async () => {
    let duplex: FakeDuplex | null = null;
    const mux = new MultiplexWatchClient({
      openCall: () => {
        duplex = new FakeDuplex() as any;
        queueMicrotask(() => {
          duplex!.emit('data', { source_event_type: 'connection.established' });
        });
        return duplex as any;
      }
    });

    let fallbackOpens = 0;
    const fallback = (): StreamHandle => {
      fallbackOpens += 1;
      return {
        cancel() {},
        on() {}
      };
    };

    const gateway = new UpdatesWatchGateway(createMultiplexOpenStream(mux, fallback));
    const u1 = gateway.watch({ kind: 'user', tenantId: 't', userId: 'a' }, () => {});
    const u2 = gateway.watch({ kind: 'tenants', tenantIds: ['t'] }, () => {});
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(mux.openCount, 1);
    assert.equal(fallbackOpens, 1);
    u1();
    u2();
  });
});
