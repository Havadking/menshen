import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULTS = {
  router: { host: '192.168.31.1', username: 'admin', timeoutMs: 5000 },
  poll: { intervalMs: 3000, leaveGraceMs: 30000, unreachableAfter: 3 },
  server: { host: '0.0.0.0', port: 8080 },
  store: { path: './data/miwifi.db', retentionDays: 180 },
  log: { level: 'info' },
  names: {},
};

// 环境变量覆盖：MIWIFI_ROUTER_HOST、MIWIFI_POLL_INTERVAL_MS、MIWIFI_SERVER_PORT ...
// 密码只从 MIWIFI_PASSWORD 读取，不进配置文件。
const ENV_MAP = {
  MIWIFI_ROUTER_HOST: ['router', 'host'],
  MIWIFI_ROUTER_USERNAME: ['router', 'username'],
  MIWIFI_ROUTER_TIMEOUT_MS: ['router', 'timeoutMs'],
  MIWIFI_POLL_INTERVAL_MS: ['poll', 'intervalMs'],
  MIWIFI_POLL_LEAVE_GRACE_MS: ['poll', 'leaveGraceMs'],
  MIWIFI_POLL_UNREACHABLE_AFTER: ['poll', 'unreachableAfter'],
  MIWIFI_SERVER_HOST: ['server', 'host'],
  MIWIFI_SERVER_PORT: ['server', 'port'],
  MIWIFI_STORE_PATH: ['store', 'path'],
  MIWIFI_STORE_RETENTION_DAYS: ['store', 'retentionDays'],
  MIWIFI_LOG_LEVEL: ['log', 'level'],
};

export function loadConfig(file = 'config.json', env = process.env) {
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(readFileSync(resolve(file), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  const cfg = {};
  for (const section of Object.keys(DEFAULTS)) {
    cfg[section] = { ...DEFAULTS[section], ...(fileCfg[section] ?? {}) };
  }

  for (const [name, [section, key]] of Object.entries(ENV_MAP)) {
    if (env[name] === undefined || env[name] === '') continue;
    const cur = cfg[section][key];
    cfg[section][key] = typeof cur === 'number' ? Number(env[name]) : env[name];
  }

  cfg.router.password = env.MIWIFI_PASSWORD ?? '';
  if (!cfg.router.password) {
    throw new Error('缺少路由器密码：请设置环境变量 MIWIFI_PASSWORD');
  }
  return cfg;
}
