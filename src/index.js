import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createLogger, setLogLevel } from './logger.js';
import { RouterClient } from './router/client.js';
import { friendlyName, setNameOverrides } from './router/names.js';
import { Store } from './store/db.js';
import { StateEngine } from './state/engine.js';
import { Poller } from './poller.js';
import { createHttpServer } from './hub/http.js';
import { attachWebSocket } from './hub/ws.js';

const log = createLogger('main');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const config = loadConfig(process.env.MIWIFI_CONFIG ?? join(ROOT, 'config.json'));
  setLogLevel(config.log.level);

  setNameOverrides(config.names);
  const store = new Store(config.store.path);
  const renamed = store.backfillFriendlyNames(friendlyName);
  if (renamed) log.info(`已为 ${renamed} 台设备更新友好名称`);
  const merged = store.autoMergeAll();
  if (merged) log.info(`已自动合并 ${merged} 个随机 MAC（同一手机的 2.4G / 5G 私有地址）`);
  const client = new RouterClient(config.router);
  const engine = new StateEngine(store, {
    leaveGraceMs: config.poll.leaveGraceMs,
    unreachableAfter: config.poll.unreachableAfter,
  });
  const poller = new Poller(client, engine, { intervalMs: config.poll.intervalMs });

  const ctx = { store, engine, client, config, publicDir: join(ROOT, 'public'), startedAt: Date.now() };
  const server = createHttpServer(ctx);
  const ws = attachWebSocket(server, { engine, store });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.server.port, config.server.host, resolve);
  });
  log.info(`看板: http://${config.server.host === '0.0.0.0' ? 'localhost' : config.server.host}:${config.server.port}/`);

  poller.start();

  // 每天 04:00 清理过期会话
  const scheduleRetention = () => {
    const next = new Date();
    next.setHours(4, 0, 0, 0);
    if (next <= Date.now()) next.setDate(next.getDate() + 1);
    setTimeout(() => {
      const n = store.pruneSessions(config.store.retentionDays);
      if (n) log.info(`清理过期会话 ${n} 条`);
      scheduleRetention();
    }, next - Date.now()).unref();
  };
  scheduleRetention();

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info(`收到 ${signal}，正在退出`);
    await poller.stop();
    await ws.close();
    await new Promise((r) => server.close(r));
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  log.error(e.message);
  process.exit(1);
});
