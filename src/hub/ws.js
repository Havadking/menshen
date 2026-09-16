import { WebSocketServer } from 'ws';
import { createLogger } from '../logger.js';

const log = createLogger('ws');

/**
 * WebSocket 分发：HELLO（全量）→ 每轮 DEVICE_SYNC → JOIN/LEAVE/UPDATE/ROUTER_STATE。
 */
export function attachWebSocket(server, { engine, store, path = '/ws', heartbeatMs = 30_000 }) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== path) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const send = (ws, event, data) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ event, ts: Date.now(), data }));
  };
  const broadcast = (event, data) => {
    const msg = JSON.stringify({ event, ts: Date.now(), data });
    for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(msg);
  };

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', (e) => log.warn(`连接错误: ${e.message}`));
    ws.on('message', (raw) => {
      // 客户端目前只发 PONG（JSON 层心跳，可选）
      try {
        const msg = JSON.parse(raw);
        if (msg?.event === 'PONG') ws.isAlive = true;
      } catch { /* ignore */ }
    });
    const snap = engine.snapshot();
    send(ws, 'HELLO', { ...snap, events: store.listEvents({ limit: 50 }) });
    log.debug(`客户端接入 ${req.socket.remoteAddress}，当前 ${wss.clients.size} 个`);
  });

  // 协议层心跳：两次未回 pong 即断开
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatMs);
  wss.on('close', () => clearInterval(heartbeat));

  engine.on('sync', (snap) => broadcast('DEVICE_SYNC', snap));
  engine.on('join', (ev) => broadcast('DEVICE_JOIN', ev));
  engine.on('leave', (ev) => broadcast('DEVICE_LEAVE', ev));
  engine.on('update', (profile) => broadcast('DEVICE_UPDATE', profile));
  engine.on('router', (state) => broadcast('ROUTER_STATE', state));

  return {
    wss,
    broadcast,
    close: () => new Promise((resolve) => {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => resolve());
    }),
  };
}
