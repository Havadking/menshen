# 门神 · menshen

> 守在家门口，记下谁来了、谁走了、待了多久。

小米路由器（Redmi AX6000）局域网设备上下线监控看板。每 3 秒轮询路由器，把每台设备的每一次"上线 → 离开"作为一条会话永久记录到本地 SQLite，并通过 WebSocket 实时推送到一个深色的 Web 看板：当前在线设备、实时速率、离线设备、历史事件时间线、上下线 Toast 提醒。

米家 App 只能看当前在线列表，小爱音箱只会念一句"xx 已连接"，都留不下记录。门神把这些信息从路由器接口里拿出来，自己存、自己看。

## 功能

- **实时在线列表**：名称、IP、MAC、接入方式（有线 / 2.4G / 5G）、经由哪个 Mesh 节点、在线时长（每秒递增）、实时上下行速率
- **离线设备列表**：离线多久、上次 IP、上次在线时长，一眼看出谁刚走
- **历史归档**：每次连接一条会话记录，重启不丢；可按设备查最近会话，可导出 CSV
- **事件时间线**：按天分组，滚动加载更早记录；可筛选上线 / 离开
- **即时提醒**：设备上下线时看板弹 Toast（3 秒自动消失，点击定位到设备行），可按设备关闭
- **设备档案**：自定义名称；内置米家产品名字典把 `yeelink-light-lamp22_mibt89F6` 翻成"米家智能显示器挂灯1S"；随机 MAC 自动标记，可把多个 MAC 合并成一台逻辑设备
- **稳**：离线 30 秒消抖（手机休眠不误报）、路由器重启 / 超时时冻结状态不产生离线风暴、进程重启后接续未结束的会话
- **轻**：Node.js 单进程 + SQLite 单文件，无外部服务，前端零构建，部署就是复制目录

## 快速开始

需要 Node.js ≥ 20，路由器为小米官方固件（在 Redmi AX6000 上实测；其他型号的字段差异见[常见问题](#常见问题)）。

```bash
git clone https://github.com/Havadking/menshen.git
cd menshen
npm install
```

路由器管理员密码只通过环境变量传入，不写进任何文件：

```bash
# PowerShell
$env:MIWIFI_PASSWORD = "路由器管理密码"; npm start

# bash / zsh
MIWIFI_PASSWORD=路由器管理密码 npm start
```

打开 http://localhost:8080/ 。同一局域网内的手机、平板也能访问（换成运行机器的 IP）。

### 第一次接入建议先跑探针

小米固件的接口没有公开文档，字段以实测为准。探针会登录路由器并打印设备表和原始字段名：

```bash
MIWIFI_PASSWORD=xxx npm run probe            # 在线设备表 + 字段名
MIWIFI_PASSWORD=xxx npm run probe -- --raw   # devicelist / status 原始 JSON
MIWIFI_PASSWORD=xxx npm run probe -- --watch # 每 3 秒刷新，用来测关 Wi-Fi 后多久显示离线
```

服务运行中也可以访问 `GET /api/debug/raw` 查看最近一次原始响应。

### 没有路由器也能试

```bash
node scripts/mock-router.js 9999
MIWIFI_ROUTER_HOST=127.0.0.1:9999 MIWIFI_PASSWORD=mock npm start
```

模拟路由器会随机让设备上下线，方便看效果或改前端。

## 配置

[config.json](config.json)：

```jsonc
{
  "router": { "host": "192.168.31.1", "username": "admin", "timeoutMs": 5000 },
  "poll":   { "intervalMs": 3000, "leaveGraceMs": 30000, "unreachableAfter": 3 },
  "server": { "host": "0.0.0.0", "port": 8080 },
  "store":  { "path": "./data/miwifi.db", "retentionDays": 180 },
  "log":    { "level": "info" },
  "names":  {}
}
```

| 项 | 说明 | 环境变量 |
|---|---|---|
| `router.host` | 路由器地址 | `MIWIFI_ROUTER_HOST` |
| `router.username` | 管理员用户名，一般是 `admin` | `MIWIFI_ROUTER_USERNAME` |
| `router.timeoutMs` | 单次请求超时 | `MIWIFI_ROUTER_TIMEOUT_MS` |
| — | 管理员密码（**只能**用环境变量） | `MIWIFI_PASSWORD` |
| `poll.intervalMs` | 轮询间隔。别低于 2 秒，路由器 CPU 吃不消 | `MIWIFI_POLL_INTERVAL_MS` |
| `poll.leaveGraceMs` | 设备从列表消失多久才算离线。手机休眠会短暂掉线，30 秒比较稳 | `MIWIFI_POLL_LEAVE_GRACE_MS` |
| `poll.unreachableAfter` | 连续几次轮询失败视为路由器不可达 | `MIWIFI_POLL_UNREACHABLE_AFTER` |
| `server.host` / `port` | 看板监听地址 | `MIWIFI_SERVER_HOST` / `MIWIFI_SERVER_PORT` |
| `store.path` | SQLite 文件位置 | `MIWIFI_STORE_PATH` |
| `store.retentionDays` | 会话保留天数，`0` 永久 | `MIWIFI_STORE_RETENTION_DAYS` |
| `log.level` | `debug` / `info` / `warn` / `error` | `MIWIFI_LOG_LEVEL` |
| `names` | 设备名字典覆盖，见下 | — |

环境变量优先级高于 `config.json`。也可以用 `MIWIFI_CONFIG=/path/to/config.json` 指定配置文件位置。

### 设备名称从哪来

路由器只给主机名（`yeelink-light-lamp27_mibt1B83`、`MiAiSoundbox-L05C`），米家 App 里的产品名是小米云端翻译的，路由器本地拿不到。门神按下面的优先级决定显示名：

1. 你在看板抽屉里填的**自定义名称**（合并过的设备跟随目标设备）
2. 内置字典翻译的**友好名**（[src/router/names.js](src/router/names.js) 收录了常见米家 / Yeelight 型号，欢迎补充）
3. 路由器上报的主机名
4. MAC

字典可在 `config.json` 的 `names` 里覆盖或补充，键是 miot 型号或主机名：

```json
"names": {
  "yeelink.light.lamp22": "书房挂灯",
  "MiWiFi-RD03": "客厅子路由",
  "Havad": "我的笔记本"
}
```

### 随机 MAC

iOS / Android 的"私有地址"功能会让同一台手机每次以不同 MAC 出现。门神按本地管理位自动标出「随机」，你可以在抽屉里把它们**合并**到同一台逻辑设备：统计按逻辑设备计，展示名跟随目标设备，历史记录仍按原始 MAC 保存。

私有地址是按网络生成的，2.4G 和 5G 分成两个 SSID 时，同一部手机在两个频段会有两个 MAC。门神会**自动合并**这种情况：两个都是随机 MAC、路由器上报的主机名相同（`iPhone` 这类通用名除外），且历史上没有长时间同时在线（累计超过 10 分钟就当作两部同型号手机）。合并目标优先选有自定义名称的，其次选最早出现的；手机在两个频段之间切换时不再弹"离开 / 连入"提醒。认错了在抽屉里改成「不合并」即可，之后不会再自动合并这台设备。

## 工作原理

```
Redmi AX6000 ──HTTP 3s──▶ RouterClient ▶ Poller ▶ StateEngine ▶ Store(SQLite)
                              登录/续签      串行调度   差量+消抖      devices/sessions
                                                          │
                                                          ▼
                                                     Hub ──WS/REST──▶ 看板
```

- **登录**：`GET /cgi-bin/luci/web` 取 `deviceId` 与 `newEncryptMode`，按固件要求做 sha256（或旧固件 sha1）哈希后 `POST /api/xqsystem/login` 拿 `stok`；token 失效自动重登，失败指数退避（最长 5 分钟，避免触发路由器锁定）
- **拉取**：每轮 `misystem/devicelist`（设备、IP、在线秒数、速率）+ `misystem/status`（WAN 速率）
- **差量**：内存里维护 `Map<mac, 状态>`。新出现 → `JOIN`；消失 → 进入离线观察，`leaveGraceMs` 内回来就当没走，超时才 `LEAVE`，离开时间取最后一次见到的时刻而不是确认时刻
- **不可达保护**：连续 N 次拉取失败进入冻结，不做任何判定，离线观察计时暂停；恢复后顺延
- **重启对齐**：启动时读取库中未结束的会话，设备仍在线就接着算；只有进程停了较久、且路由器统计的上线时刻晚于我们最后一次见到设备时，才认定它在停机期间断开过
- **持久化**：一次连接一条 `sessions` 记录（开始、结束、时长、IP）；事件时间线由会话两端派生，不另存事件表；SQLite WAL 模式，时间统一 epoch 毫秒

细节见 [docs/DESIGN.md](docs/DESIGN.md)，页面设计稿在 [design/](design/)。

### 关于延迟

- 设备**主动**断开（关 Wi-Fi、飞行模式）：路由器几秒内感知，加 30 秒消抖，约半分钟后显示离开
- 设备**被动**离开（走出覆盖范围、没电）：受路由器自身老化时间限制，再加消抖，最坏约 2 分钟
- 上线：3 秒内

## 接口

所有时间为 epoch 毫秒；错误统一返回 `{ "error": { "code", "message" } }`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | 当前快照：路由器状态、WAN 速率、在线设备（含速率、在线时长起点、是否离线确认中） |
| GET | `/api/devices?q=&online=1` | 设备档案，`q` 按名称 / IP / MAC 模糊搜 |
| GET | `/api/devices/offline` | 离线设备 + 最近一次会话 |
| GET | `/api/devices/:mac` | 单台设备档案 |
| PATCH | `/api/devices/:mac` | 修改 `customName`、`notify`、`canonicalMac`（`null` 取消合并） |
| GET | `/api/events?limit=50&before=&type=JOIN\|LEAVE&mac=` | 事件时间线，`before` 分页 |
| GET | `/api/sessions?mac=&from=&to=&limit=` | 会话列表 |
| GET | `/api/stats/today` | 今日在线数、出现设备数、上下线次数 |
| GET | `/api/export?from=&to=` | 会话导出 CSV（Excel 可直接打开） |
| GET | `/api/health` | 健康检查，路由器不可达或超过 60 秒没成功轮询返回 503 |
| GET | `/api/debug/raw` | 最近一次路由器原始响应 |

WebSocket `ws://host:8080/ws`，消息格式 `{ "event", "ts", "data" }`：

| 事件 | 时机 | data |
|---|---|---|
| `HELLO` | 连接建立 | 快照 + 最近 50 条事件 |
| `DEVICE_SYNC` | 每轮轮询后 | 全量快照（前端以此为准） |
| `DEVICE_JOIN` / `DEVICE_LEAVE` | 上线 / 确认离线 | `mac, name, ip, connType, sessionId, notify`，LEAVE 另有 `durationMs` |
| `DEVICE_UPDATE` | 档案被修改 | 设备档案 |
| `ROUTER_STATE` | 路由器不可达 / 恢复 | `reachable, failures, error, downtimeMs` |

## 数据与备份

`data/` 目录就是全部状态（`miwifi.db` 及 WAL 文件），备份它就够了。表结构在 [src/store/migrations/](src/store/migrations/)，升级时自动迁移。想用 SQL 直接查：

```sql
-- 某台设备最近 10 次连接
SELECT datetime(started_at/1000,'unixepoch','localtime') AS 上线,
       datetime(ended_at/1000,'unixepoch','localtime')   AS 离开,
       duration_ms/60000 AS 分钟
FROM sessions WHERE mac = 'CC:47:40:C1:9C:6A' ORDER BY started_at DESC LIMIT 10;
```

## 长期运行

**pm2**（Windows / Linux / macOS 通用）：

```bash
npm i -g pm2
MIWIFI_PASSWORD=xxx pm2 start src/index.js --name menshen
pm2 save && pm2 startup   # 开机自启
```

**Windows 任务计划程序**：新建任务，触发器"登录时"，操作 `node.exe`，参数 `src\index.js`，起始于项目目录。任务计划程序不能直接设环境变量，把 `MIWIFI_PASSWORD` 设为用户级环境变量即可。

**NAS / Docker**：直接用 `node:22` 镜像挂载项目目录运行 `npm start`，把 `data/` 映射出来即可。

看板本身没有登录鉴权，默认只应在局域网内访问；如需外网访问请走 VPN / 内网穿透，或在前面加一层反向代理做认证。

## 常见问题

**登录失败 `code=401`** — 密码错误。注意是路由器管理密码，不是 Wi-Fi 密码。连续失败会指数退避，最长 5 分钟一次，改完密码重启服务即可。

**看板显示"路由器不可达"** — 连续 3 次拉取失败。检查 `router.host`、路由器是否在重启、运行机器是否和路由器在同一网段。期间不会产生任何离线记录，恢复后自动继续。

**其他型号的小米路由器能用吗** — 登录流程和接口路径在小米各型号上基本一致，但 `devicelist` 字段可能有差异。先跑 `npm run probe -- --raw`，重点看 `list[].online`、`list[].type`、`statistics.online` 三个字段，映射逻辑集中在 [src/router/client.js](src/router/client.js) 的 `normalizeDevice()` / `connTypeOf()`，改这一处就够。

**米家 App 里的"离线设备"这里没有** — App 的离线列表来自小米云端，路由器本地接口只返回在线设备。门神的离线列表记录的是它运行以来见过、现在不在线的设备。

**设备明明在线却显示离线确认中** — 那是消抖窗口：设备刚从路由器列表里消失，30 秒内回来就恢复正常，不会记录事件。

**为什么不用路由器的推送功能** — `devicelist` 里的 `push` 字段实测恒为 0，路由器侧的"上线提醒"开关不可读，所以提醒开关由门神自己维护。

## 项目结构

```
src/
  index.js               启动：配置 → 数据库迁移 → 轮询 → HTTP/WS
  config.js              config.json + 环境变量
  router/client.js       登录、stok 续签、devicelist / status 拉取与归一化
  router/names.js        主机名 → 米家产品名字典
  poller.js              串行轮询调度
  state/engine.js        差量检测、离线消抖、不可达冻结、重启对齐
  store/db.js            SQLite 访问层
  store/migrations/      建表与升级脚本
  hub/http.js            静态文件 + 路由
  hub/api.js             REST 接口
  hub/ws.js              WebSocket 广播
public/index.html        看板（Vue 3 单文件，无构建）
scripts/probe.js         路由器探针
scripts/mock-router.js   模拟路由器
test/                    单元测试（node --test）
docs/DESIGN.md           总体设计文档
design/                  页面设计稿
```

## 开发

```bash
npm test                          # 单元测试
MIWIFI_LOG_LEVEL=debug npm start  # 详细日志
```

前端是纯静态文件，改完刷新浏览器即可，不用重启服务。

## 许可

[MIT](LICENSE)
