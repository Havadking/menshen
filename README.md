# MiWiFi Monitor

Redmi AX6000（小米路由器）局域网设备在线状态监控：每 3 秒轮询路由器 → 差量检测 + 30s 消抖 → SQLite 持久化每一次连接会话 → WebSocket 实时看板与上下线提醒。

设计文档见 [docs/DESIGN.md](docs/DESIGN.md)，页面设计稿见 `design/`。

## 运行

要求 Node.js ≥ 20。

```bash
npm install
```

路由器管理员密码只通过环境变量传入，不写进任何文件：

```bash
# PowerShell
$env:MIWIFI_PASSWORD = "路由器管理密码"; npm start

# bash
MIWIFI_PASSWORD=路由器管理密码 npm start
```

打开 http://localhost:8080/ 即可。其余配置在 [config.json](config.json)，每一项都可用同名环境变量覆盖（`MIWIFI_ROUTER_HOST`、`MIWIFI_POLL_INTERVAL_MS`、`MIWIFI_SERVER_PORT`、`MIWIFI_STORE_PATH` …，见 `src/config.js`）。

## 第一次接入：先跑探针

固件字段以实测为准。先用探针确认登录能通、字段映射正确：

```bash
MIWIFI_PASSWORD=xxx npm run probe            # 打印在线设备表与字段名
MIWIFI_PASSWORD=xxx npm run probe -- --raw   # 打印 devicelist / status 原始 JSON
MIWIFI_PASSWORD=xxx npm run probe -- --watch # 每 3 秒刷新，用来测关 Wi-Fi 后 online 翻转要多久
```

重点核对 `devicelist.list[].online`、`statistics.online`、`type`/`wifiIndex` 三项；映射逻辑集中在 `src/router/client.js` 的 `normalizeDevice()`。

## 没有路由器时的演示模式

```bash
node scripts/mock-router.js 9999
MIWIFI_ROUTER_HOST=127.0.0.1:9999 MIWIFI_PASSWORD=mock npm start
```

模拟路由器会随机让设备上下线。

## 目录

```
src/
  index.js            启动入口
  config.js           配置加载（config.json + 环境变量）
  router/client.js    登录 / stok 续签 / devicelist、status 拉取与归一化
  poller.js           串行轮询调度
  state/engine.js     差量检测、离线消抖、不可达冻结、重启对齐
  store/db.js         SQLite（devices / sessions / settings）
  hub/http.js         静态文件 + REST
  hub/api.js          REST 接口
  hub/ws.js           WebSocket 广播
public/index.html     看板（Vue 3，单文件）
scripts/probe.js      路由器探针
scripts/mock-router.js 模拟路由器
test/                 node --test 单元测试
data/                 运行时数据库（已 gitignore）
```

## 接口速查

| | |
|---|---|
| `GET /api/state` | 当前快照（路由器状态、WAN 速率、在线设备） |
| `GET /api/devices?q=` | 设备档案；`PATCH /api/devices/:mac` 改 `customName` / `notify` / `canonicalMac` |
| `GET /api/events?limit=&before=&type=&mac=` | 事件时间线 |
| `GET /api/sessions?mac=&from=&to=` | 会话列表 |
| `GET /api/stats/today` | 今日统计 |
| `GET /api/export?from=&to=` | 会话 CSV |
| `GET /api/health` | 健康检查（路由器不可达时返回 503） |
| `ws://host:8080/ws` | `HELLO` → `DEVICE_SYNC` / `DEVICE_JOIN` / `DEVICE_LEAVE` / `DEVICE_UPDATE` / `ROUTER_STATE` |

## 测试

```bash
npm test
```

## 部署

`data/` 目录即全部状态，备份它就够了。长期运行建议 pm2：

```bash
MIWIFI_PASSWORD=xxx pm2 start src/index.js --name miwifi-monitor
```
