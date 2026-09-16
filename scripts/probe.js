// M0 探针：登录路由器，打印 devicelist / status 的原始 JSON 与归一化结果，用于核对字段映射。
// 用法：MIWIFI_PASSWORD=xxx node scripts/probe.js [--raw] [--watch]
import { loadConfig } from '../src/config.js';
import { RouterClient } from '../src/router/client.js';

const args = new Set(process.argv.slice(2));
const config = loadConfig();
const client = new RouterClient(config.router);

function fmtSpeed(b) {
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB/s';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB/s';
  return b + ' B/s';
}

async function once() {
  const t0 = Date.now();
  const dl = await client.deviceList();
  const st = await client.status();
  const ms = Date.now() - t0;

  if (args.has('--raw')) {
    console.log('===== devicelist raw =====');
    console.log(JSON.stringify(dl.raw, null, 2));
    console.log('===== status raw =====');
    console.log(JSON.stringify(st.raw, null, 2));
  }

  const online = dl.devices.filter((d) => d.online);
  console.log(`\n[${new Date().toLocaleTimeString()}] 耗时 ${ms}ms · 列表 ${dl.devices.length} 台 · 在线 ${online.length} 台 · WAN ↓${fmtSpeed(st.wan.down)} ↑${fmtSpeed(st.wan.up)}`);
  console.table(online.map((d) => ({
    name: d.name, ip: d.ip, mac: d.mac, conn: d.connType, onlineSec: d.onlineSec,
    down: fmtSpeed(d.down), up: fmtSpeed(d.up), push: d.push,
  })));

  // 字段核对提示
  const sample = dl.raw.list?.[0];
  if (sample && !args.has('--raw')) {
    console.log('devicelist.list[0] 顶层字段:', Object.keys(sample).join(', '));
    console.log('  type =', JSON.stringify(sample.type), ' statistics =', JSON.stringify(sample.statistics));
    console.log('status 顶层字段:', Object.keys(st.raw).join(', '));
    if (Array.isArray(st.raw.dev)) console.log(`  status.dev[] ${st.raw.dev.length} 项，字段:`, Object.keys(st.raw.dev[0] ?? {}).join(', '));
  }
}

try {
  await client.login();
  await once();
  if (args.has('--watch')) {
    setInterval(() => once().catch((e) => console.error('轮询失败:', e.message)), config.poll.intervalMs);
  }
} catch (e) {
  console.error('失败:', e.message);
  process.exit(1);
}
