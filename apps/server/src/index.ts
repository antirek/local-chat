import http from 'http';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { Chat3Client } from './chat3Client.js';
import { createApiRouter } from './api.js';
import { verifyToken } from './auth.js';
import { UpdatesWatchGateway, type WatchScope } from './updatesWatchGateway.js';
import { MultiplexWatchClient } from './multiplexWatchClient.js';
import { createMultiplexOpenStream } from './multiplexOpenStream.js';

async function main() {
  await mongoose.connect(config.mongoUri);
  console.log('[local-chat] mongo connected', config.mongoUri);

  const chat3 = new Chat3Client();
  console.log(
    '[local-chat] chat3 grpc',
    config.chat3.grpcUrl,
    'tenant',
    config.chat3.tenantId,
    'watchMode',
    config.chat3.watchMode
  );

  const openPerScope = (scope: WatchScope) => {
    if (scope.kind === 'user') {
      return chat3.subscribeUpdates(scope.userId);
    }
    if (scope.kind === 'tenants') {
      return chat3.subscribeTenantUpdates(scope.tenantIds);
    }
    return chat3.subscribeTenantUpdates([]);
  };

  let gateway: UpdatesWatchGateway;
  if (config.chat3.watchMode === 'multiplex') {
    const multiplex = new MultiplexWatchClient({
      openCall: () => chat3.watchUpdates()
    });
    gateway = new UpdatesWatchGateway(createMultiplexOpenStream(multiplex, openPerScope));
  } else {
    gateway = new UpdatesWatchGateway(openPerScope);
  }

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', createApiRouter(chat3));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (socket, req) => {
    try {
      const url = new URL(req.url || '', 'http://localhost');
      const token = url.searchParams.get('token') || '';
      const user = verifyToken(token);

      // Default product mode: personal scope (tenant + user).
      // Broader scopes (tenants / all) are available via gateway for other adapters.
      const scope: WatchScope = {
        kind: 'user',
        tenantId: config.chat3.tenantId,
        userId: user.login
      };

      socket.send(JSON.stringify({ type: 'connected', userId: user.login, scope: 'user' }));

      const unwatch = gateway.watch(scope, (update: any) => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: 'chat3.update', update }));
        }
      });

      socket.on('close', () => {
        unwatch();
      });
    } catch (error: any) {
      console.error('[ws] auth failed', error?.message);
      socket.close();
    }
  });

  server.listen(config.port, () => {
    console.log(`[local-chat] listening on :${config.port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
