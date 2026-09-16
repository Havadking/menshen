// 模拟小米路由器 Luci API，用于无路由器时的联调/演示。
// 用法：node scripts/mock-router.js [port]   然后
//       MIWIFI_ROUTER_HOST=127.0.0.1:9999 MIWIFI_PASSWORD=mock npm start
import { createServer } from 'node:http';

const port = Number(process.argv[2]) || 9999;
const DEVICE_ID = 'MOCKDEVICEID0001';
let stok = null;

const base = [
  { mac: '3C:22:FB:1A:9E:44', name: 'MacBook Pro', oname: 'MacBook-Pro', ip: '192.168.31.20', type: { type: 'wifi', wifiIndex: 2 }, online: 1, since: Date.now() - 6 * 3600e3 },
  { mac: '00:11:32:AB:CD:EF', name: '群晖 NAS', oname: 'DS920plus', ip: '192.168.31.10', type: { type: 'wired' }, online: 1, since: Date.now() - 31 * 86400e3 },
  { mac: '64:09:80:5C:1D:9B', name: '小米电视', oname: 'MiTV-AXSO0', ip: '192.168.31.35', type: { type: 'wifi', wifiIndex: 2 }, online: 1, since: Date.now() - 2 * 3600e3 },
  { mac: 'F4:F5:DB:3E:60:12', name: '小爱音箱 Pro', oname: 'xiaoai-speaker', ip: '192.168.31.66', type: { type: 'wifi', wifiIndex: 1 }, online: 1, since: Date.now() - 12 * 86400e3 },
  { mac: '6A:B2:1C:88:99:01', name: 'iPhone 15 Pro', oname: 'iPhone', ip: '192.168.31.102', type: { type: 'wifi', wifiIndex: 2 }, online: 0, since: 0 },
  { mac: '98:B6:E9:44:A1:C3', name: 'Switch', oname: 'Nintendo', ip: '192.168.31.57', type: { type: 'wifi', wifiIndex: 2 }, online: 0, since: 0 },
  { mac: 'D2:41:7E:0B:5C:A8', name: 'Redmi K70', oname: 'Redmi-K70', ip: '192.168.31.119', type: { type: 'wifi', wifiIndex: 1 }, online: 0, since: 0 },
];

// 随机让某台设备上/下线，模拟真实抖动
setInterval(() => {
  const d = base[Math.floor(Math.random() * base.length)];
  if (d.online) {
    if (Math.random() < 0.3) { d.online = 0; d.since = 0; console.log(`[mock] ${d.name} 离线`); }
  } else if (Math.random() < 0.6) {
    d.online = 1; d.since = Date.now(); console.log(`[mock] ${d.name} 上线`);
  }
}, 20_000);

const rnd = (max) => Math.floor(Math.random() * max);
const deviceList = () => ({
  code: 0,
  list: base.map((d) => ({
    mac: d.mac, name: d.name, oname: d.oname, online: String(d.online), push: '1',
    type: d.type, authority: { wan: 1, pridisk: 0, admin: 1, lan: 0 },
    ip: [{ ip: d.ip, online: String(d.online), active: d.online, downspeed: String(d.online ? rnd(2e6) : 0), upspeed: String(d.online ? rnd(2e5) : 0) }],
    statistics: { online: String(d.online ? Math.floor((Date.now() - d.since) / 1000) : 0), downspeed: '0', upspeed: '0' },
  })),
});
const status = () => ({
  code: 0,
  wan: { downspeed: String(rnd(15e6)), upspeed: String(rnd(2e6)), maxdownloadspeed: '0', maxuploadspeed: '0' },
  cpu: { load: 12 }, mem: { usage: 0.4 },
  dev: base.filter((d) => d.online).map((d) => ({ mac: d.mac, devname: d.name, online: '1' })),
});

const json = (res, body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/cgi-bin/luci/web') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<html><script>var deviceId = '${DEVICE_ID}'; var newEncryptMode = 1;</script></html>`);
  }
  if (p === '/cgi-bin/luci/api/xqsystem/login' && req.method === 'POST') {
    let body = ''; for await (const c of req) body += c;
    const f = new URLSearchParams(body);
    if (!f.get('nonce')?.startsWith(`0_${DEVICE_ID}_`) || f.get('password')?.length !== 64) return json(res, { code: 401, msg: '密码错误' });
    stok = Math.random().toString(16).slice(2, 18);
    console.log('[mock] 登录成功 stok =', stok);
    return json(res, { code: 0, token: stok, url: `/cgi-bin/luci/;stok=${stok}/web/home` });
  }
  const m = p.match(/^\/cgi-bin\/luci\/;stok=([^/]+)\/api\/(.+)$/);
  if (m) {
    if (m[1] !== stok) return json(res, { code: 401, msg: 'Invalid token' });
    if (m[2] === 'misystem/devicelist') return json(res, deviceList());
    if (m[2] === 'misystem/status') return json(res, status());
    return json(res, { code: 1, msg: 'unknown api' });
  }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1', () => console.log(`[mock] 模拟路由器 http://127.0.0.1:${port}`));
