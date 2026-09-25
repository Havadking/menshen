# 门神（menshen）— 局域网设备在线监控系统总体设计

> 目标路由器：Redmi AX6000（小米官方固件，MiWiFi Luci API）
> 文档版本：v1.0（2026-09-16）
> 配套页面稿：见 `design/`（桌面稿 `Main.dc.html`、手机稿 `Mobile.dc.html`）

---

## 1. 目标与范围

### 1.1 要解决的问题

小米路由器只允许通过米家 App / 小爱音箱查看设备上下线，无法归档历史、无法在电脑上常驻查看。本系统在局域网内部署一个轻量守护进程，周期拉取路由器设备列表，将"谁在线、什么时候来的、什么时候走的、用了多久"持久化到本地 SQLite，并通过 Web 看板实时展示与提醒。

### 1.2 功能范围

| 编号 | 功能 | 说明 |
|---|---|---|
| F1 | 在线状态感知 | 每 3s 轮询路由器，识别设备接入/离开 |
| F2 | 历史归档（持久化） | 每一次连接作为一条会话记录（开始、结束、时长、IP），永久保存在 SQLite，重启不丢 |
| F3 | 设备档案 | 以 MAC 为主键维护设备信息：路由器上报名、自定义名、首次/最近出现时间、连接方式 |
| F4 | 实时看板 | 在线设备表（名称、IP、MAC、在线时长、实时速率）、总览指标、事件时间线 |
| F5 | 即时提醒 | 设备上/下线时 Web 端 Toast，可按设备关闭提醒 |
| F6 | 随机 MAC 处理 | 标记疑似随机 MAC；同主机名的随机 MAC 自动合并（2.4G/5G 分 SSID 时同一手机有两个私有地址），也支持手动合并/取消 |
| F7 | 路由器不可达保护 | 路由器重启/超时时冻结状态，不产生误报离线 |

### 1.3 非目标

- 不做流量审计/抓包，不做家长控制或断网操作（只读）
- 不做多路由器/多用户/权限系统（单实例、单管理员、局域网内使用）
- 不做公网暴露（如需外网访问，走用户自己的内网穿透/VPN）

---

## 2. 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | Node.js ≥ 20 LTS，JavaScript（ESM） | 单进程即可同时承担轮询、HTTP、WebSocket；HTTP 客户端用内置 `fetch` |
| 存储 | SQLite（`better-sqlite3`，WAL 模式） | 零运维、单文件、同步 API 简单可靠；数据量为万级行 |
| HTTP/WS | `node:http` + `ws` | 静态文件与 REST 量小，无需大框架 |
| 前端 | Vue 3（CDN 引入、单 HTML 文件，无构建步骤） | 页面只有一屏，避免 build 工具链；部署时整目录复制即可 |
| 配置 | `config.json` + 环境变量覆盖 | 路由器密码通过 `MIWIFI_PASSWORD` 环境变量注入，不进仓库 |
| 部署 | `pm2` 或 Docker（NAS / 常开 PC） | 一个 `data/` 目录承载数据库，便于备份 |

---

## 3. 系统架构

```
┌────────────────────────────────────────────────────────────────────────┐
│  Redmi AX6000  (192.168.31.1)                                          │
│   /cgi-bin/luci/web                      → deviceId / newEncryptMode   │
│   /cgi-bin/luci/api/xqsystem/login       → stok                        │
│   /cgi-bin/luci/;stok=…/api/misystem/devicelist  → 设备列表(含离线)    │
│   /cgi-bin/luci/;stok=…/api/misystem/status      → WAN 速率/设备速率   │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ HTTP，3s 一轮（串行，上一轮结束后再计时）
┌───────────────────────────────▼────────────────────────────────────────┐
│  menshen         (Node.js 单进程)                                      │
│                                                                        │
│  RouterClient ──► Poller ──► StateEngine ──► Store (SQLite)            │
│   登录/续签       调度       Diff+消抖       devices / sessions / …    │
│   退避重试        超时       不可达冻结                                │
│                                  │                                     │
│                                  ▼                                     │
│                                Hub ──► WebSocket 广播 + REST API       │
│                                        + 静态文件(看板)                │
└───────────────────────────────┬────────────────────────────────────────┘
                                │ ws://host:8080/ws   http://host:8080/
┌───────────────────────────────▼────────────────────────────────────────┐
│  Web 看板 (浏览器)                                                     │
│   总览条 · 在线设备表 · 事件时间线 · Toast · 设备重命名/合并            │
└────────────────────────────────────────────────────────────────────────┘
```

进程内五个模块单向依赖，StateEngine 是唯一持有"当前状态"的地方；Store 只负责落盘，Hub 只负责分发。

---

## 4. 模块设计

### 4.1 RouterClient — 路由器通信

**登录流程（`newEncryptMode = 1`）**

1. `GET /cgi-bin/luci/web`，正则提取页面内 `deviceId`、`newEncryptMode`
2. 生成 `nonce = "0_" + deviceId + "_" + unix秒 + "_" + 4位随机数`
3. 密码哈希：
   - `newEncryptMode == 1`：`sha256(nonce + sha256(password + KEY))`
   - 否则：`sha1(nonce + sha1(password + KEY))`
   - `KEY = "a2ffa5c9be07488bbb04a3a47d3c5f6a"`（固件固定常量）
4. `POST /cgi-bin/luci/api/xqsystem/login`，表单 `username=admin&password=<hash>&logtype=2&nonce=<nonce>`
5. 响应 `{ code: 0, token: "<stok>", url: … }`，缓存 `stok`

**请求规则**

- 所有业务请求携带 `;stok=<stok>` 路径段；单次超时 5s
- 响应 `code == 401` 或 `msg` 含 `Invalid token` → 标记 stok 失效，重新登录后重试一次
- 登录失败退避：1s → 2s → 4s → … 上限 60s；连续失败 5 次后每 5 分钟试一次（路由器有密码错误锁定）
- 每轮拉取两个接口：`devicelist`（设备名/IP/在线标志/在线秒数）和 `status`（WAN 速率）。若实测 `status.dev[]` 只含在线设备且字段够用，可把 `devicelist` 降频到 15s

**`devicelist` 字段映射**（Redmi AX6000 实测，2026-09-16）

| 路由器字段 | 含义 | 本系统用途 |
|---|---|---|
| `list[].mac` | MAC | 主键 |
| `list[].online` | `1` 在线 / `0` 离线 | 入口按此过滤（实测该固件列表只含在线设备，米家 App 的离线列表来自云端） |
| `list[].name` / `oname` | 用户改名 / 原始主机名 | `devices.router_name` |
| `list[].ip[0].ip` | 当前 IP | `devices.last_ip` / `sessions.ip` |
| `list[].ip[0].downspeed` / `upspeed` | 实时速率 B/s | 快照推送 |
| `list[].statistics.online` | 本轮在线秒数 | 重启后反推 `sessions.started_at` |
| `list[].type` | 数字：`0` 有线 / `1` 2.4G / `2` 5G | `devices.conn_type` |
| `list[].parent` | 上级 Mesh 节点 MAC（空 = 直连主路由） | 快照 `parentMac` / `parentName` |
| `list[].push` | 实测恒为 0，不可用 | 忽略；`notify` 默认开启 |
| `list[].isap` | `>0` 表示该设备本身是 Mesh 子路由 | 展示用 |

### 4.2 Poller — 调度

- 不用 `setInterval`；每轮 `await` 完成后 `setTimeout(3000)`，避免路由器慢时请求堆叠
- 每轮产出 `PollResult = { ok: true, devices: Snapshot[], wan } | { ok: false, error }`，交给 StateEngine
- 轮询间隔、超时、失败阈值均来自配置

### 4.3 StateEngine — 差量、消抖与不可达保护

内存状态：`Map<mac, Tracked>`

```
Tracked {
  mac, ip, name, connType, down, up,
  status: 'ONLINE' | 'PENDING_LEAVE',
  sessionId,          // 当前会话（sessions.id）
  startedAt,          // 本轮上线时间 (ms)
  lastSeenAt,         // 最后一次在路由器列表中出现 (ms)
  pendingSince        // 进入离线观察的时间，仅 PENDING_LEAVE
}
```

**每轮处理**

```
PollResult.ok == false
  ├─ 连续失败次数 +1
  ├─ ≥ 3 次 → 进入 UNREACHABLE：广播 ROUTER_STATE {reachable:false}
  └─ 期间不做任何 Diff；所有 PENDING_LEAVE 计时暂停（记录暂停时长，恢复后顺延）
PollResult.ok == true
  ├─ 若之前 UNREACHABLE → 恢复，广播 ROUTER_STATE {reachable:true}
  ├─ 遍历 online=="1" 的设备 (cur)
  │    ├─ 不在 Map            → JOIN：开会话、写 DB、广播 DEVICE_JOIN
  │    ├─ 在 Map 且 ONLINE    → 更新 ip/name/速率/lastSeenAt；ip 或 name 变化则更新 devices
  │    └─ 在 Map 且 PENDING   → 取消离线观察，恢复 ONLINE（不产生事件）
  ├─ 遍历 Map 中不在 cur 的设备
  │    ├─ ONLINE              → 转 PENDING_LEAVE，pendingSince = now
  │    └─ PENDING 且 now - pendingSince ≥ 30s
  │                            → LEAVE：ended_at = lastSeenAt（不是 now），
  │                              duration = lastSeenAt - startedAt，写 DB、广播 DEVICE_LEAVE、移出 Map
  └─ 广播 DEVICE_SYNC（全量快照，含速率）
```

**冷启动 / 重启对齐（warm start）**

1. 启动时读取 `sessions` 中 `ended_at IS NULL` 的会话，以及第一轮轮询结果
2. 设备在线且有未闭合会话 → 默认沿用该会话（不产生 JOIN）。只有同时满足「进程停止时间超过离线缓冲」且「路由器统计的上线时刻（`now - statistics.online`）明显晚于我们最后一次见到设备的时刻」才认定设备在停机期间断开过：闭合旧会话于 `last_seen_at`，按路由器时刻开新会话。注意路由器计数器在设备重新关联（漫游、换频段）时会重置而设备并未离线，所以必须与 `last_seen_at` 比较而不是与会话开始时间比较
3. 设备在线但无未闭合会话 → 按 `statistics.online` 反推 `started_at` 开会话，写 JOIN 事件但标记 `source='warm'`，前端不弹 Toast
4. 设备不在线但有未闭合会话 → 以会话的 `last_seen_at` 作为 `ended_at` 闭合，`source='recover'`
5. 首轮不广播 JOIN/LEAVE Toast，只推 SYNC

### 4.4 Store — 持久化

- 数据库文件 `data/miwifi.db`，`PRAGMA journal_mode=WAL; synchronous=NORMAL`
- 启动时执行 `migrations/*.sql`，用 `PRAGMA user_version` 记版本
- 所有时间字段为 **epoch 毫秒整数**，与 WS/REST 一致，避免时区歧义
- 写入策略：JOIN/LEAVE 即时写；`devices.last_seen_at` 每轮更新但用同一事务批量写
- 保留策略：`sessions` 默认保留 180 天，每天 04:00 清理一次（可配置；设为 0 表示永久）
- 备份：整个 `data/` 目录即完整备份；提供 `GET /api/export?from=&to=` 导出 CSV

### 4.5 Hub — WebSocket 与 REST

- WS 路径 `/ws`；新连接建立后立即下发 `HELLO`（含 ROUTER_STATE + DEVICE_SYNC + 最近 50 条事件）
- 服务端每 30s 发 WebSocket 协议层 ping 帧（浏览器自动回 pong），两次未回则断开；JSON 层的 `PONG` 仅作可选补充
- 广播是"发后即忘"，前端以 SYNC 为准，事件只用于 Toast 和时间线增量
- 静态文件目录 `public/`，看板为 `public/index.html`

---

## 5. 数据模型

```sql
-- 设备档案：一行一个物理 MAC
CREATE TABLE devices (
  mac            TEXT PRIMARY KEY,            -- 大写、冒号分隔 AA:BB:CC:DD:EE:FF
  router_name    TEXT,                        -- 路由器上报名（name/oname），每轮刷新
  custom_name    TEXT,                        -- 用户自定义名，优先展示
  canonical_mac  TEXT REFERENCES devices(mac),-- 合并到哪个逻辑设备；NULL = 自己
  merge_source   TEXT,                        -- 'auto' 自动合并 / 'manual' 用户改过，不再自动处理
  is_random_mac  INTEGER NOT NULL DEFAULT 0,  -- 本地管理位（第2个十六进制位为 2/6/A/E）
  conn_type      TEXT,                        -- 'wired' | '2.4g' | '5g' | NULL
  last_ip        TEXT,
  is_online      INTEGER NOT NULL DEFAULT 0,
  notify         INTEGER NOT NULL DEFAULT 1,  -- 是否弹 Toast
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL
);

-- 连接会话：一行一次"上线→下线"
CREATE TABLE sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  mac            TEXT NOT NULL REFERENCES devices(mac),
  ip             TEXT,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,                     -- NULL = 进行中
  last_seen_at   INTEGER NOT NULL,
  duration_ms    INTEGER,                     -- ended_at - started_at，闭合时计算
  start_source   TEXT NOT NULL DEFAULT 'poll',-- 'poll' | 'warm'
  end_source     TEXT                         -- 'poll' | 'recover' | 'retention'
);
CREATE INDEX idx_sessions_mac_started ON sessions(mac, started_at DESC);
CREATE INDEX idx_sessions_started     ON sessions(started_at DESC);
CREATE INDEX idx_sessions_open        ON sessions(ended_at) WHERE ended_at IS NULL;

-- 键值设置（轮询间隔等运行期可改的项）
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

**常用查询**

```sql
-- 当前在线（含在线时长）
SELECT d.*, s.id AS session_id, s.started_at
FROM devices d JOIN sessions s ON s.mac = d.mac AND s.ended_at IS NULL;

-- 今日出现过的逻辑设备数（按合并后的设备计）
SELECT COUNT(DISTINCT COALESCE(d.canonical_mac, d.mac))
FROM sessions s JOIN devices d ON d.mac = s.mac
WHERE s.started_at >= :todayStartMs OR s.ended_at IS NULL OR s.ended_at >= :todayStartMs;

-- 事件流（JOIN/LEAVE 由会话两端派生，不单独存事件表）
SELECT 'JOIN'  AS type, started_at AS at, mac, ip, NULL AS duration_ms FROM sessions
UNION ALL
SELECT 'LEAVE', ended_at, mac, ip, duration_ms FROM sessions WHERE ended_at IS NOT NULL
ORDER BY at DESC LIMIT :limit;
```

事件不单独建表：一条会话天然对应一个 JOIN 和至多一个 LEAVE，派生查询即可，避免两张表不一致。

---

## 6. 接口定义

### 6.1 REST（`/api/*`，JSON，时间均为 epoch ms）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | 路由器可达状态、WAN 速率、在线设备快照（同 DEVICE_SYNC） |
| GET | `/api/devices` | 全部设备档案（含离线），支持 `?q=` 按名称/IP/MAC 模糊搜 |
| GET | `/api/devices/offline` | 离线设备 + 最近一次会话（离线列表用） |
| GET | `/api/debug/raw` | 最近一次路由器原始响应，用于核对字段 |
| PATCH | `/api/devices/:mac` | 修改 `custom_name`、`notify`、`canonical_mac`（传 `null` 取消合并） |
| GET | `/api/events?limit=50&before=<ms>&type=JOIN|LEAVE&mac=` | 事件时间线分页 |
| GET | `/api/sessions?mac=&from=&to=` | 某设备的会话列表（设备详情用） |
| GET | `/api/stats/today` | 在线数、今日出现设备数、今日事件数 |
| GET | `/api/export?from=&to=` | 会话 CSV 导出 |
| GET | `/api/health` | 进程存活、DB 可写、上次成功轮询时间 |

错误统一 `{ error: { code, message } }`，HTTP 4xx/5xx。

### 6.2 WebSocket（`/ws`）

**服务端 → 客户端**

```jsonc
// 连接建立后第一条
{ "event": "HELLO", "ts": 1773580540000,
  "data": { "router": { "reachable": true, "lastPollAt": 1773580539000 },
            "devices": [ /* 同 DEVICE_SYNC.data.devices */ ],
            "wan": { "down": 1310720, "up": 131072 },
            "events": [ /* 最近 50 条，同 /api/events 元素 */ ] } }

// 每轮轮询后（3s）
{ "event": "DEVICE_SYNC", "ts": 1773580543000,
  "data": { "wan": { "down": 1310720, "up": 131072 },
            "devices": [ { "mac": "6A:B2:1C:88:99:01", "name": "iPhone 15 Pro",
                           "ip": "192.168.31.50", "connType": "5g",
                           "down": 1024, "up": 256,
                           "startedAt": 1773579038000,
                           "pendingLeave": false, "isRandomMac": true,
                           "canonicalMac": null, "notify": true } ] } }

{ "event": "DEVICE_JOIN",  "ts": …, "data": { "mac", "name", "ip", "connType", "sessionId" } }
{ "event": "DEVICE_LEAVE", "ts": …, "data": { "mac", "name", "ip", "durationMs", "sessionId" } }
{ "event": "DEVICE_UPDATE","ts": …, "data": { "mac", "name", "customName", "notify", "canonicalMac" } } // 档案被修改
{ "event": "ROUTER_STATE", "ts": …, "data": { "reachable": false, "failures": 3, "lastPollAt": …, "error": "timeout" } }   // 恢复时附带 downtimeMs
```

JOIN/LEAVE 事件附带 `notify`（设备是否开启提醒），前端据此决定是否弹 Toast。首轮 warm start 只落库不广播 JOIN。

**客户端 → 服务端**：无必需消息；写操作全部走 REST。

---

## 7. 页面设计

> 视觉方向：深色运维看板。高保真稿见 `design/Main.dc.html`（桌面 1440×900）与 `design/Mobile.dc.html`（手机 390×844）。

### 7.1 信息架构

```
看板（单页）
├─ 顶栏        标题 · 路由器连接状态 · WAN 实时速率
├─ 总览指标    在线设备 / 今日出现 / 今日事件 / 最近变化
├─ 在线设备表  状态 · 设备 · IP · MAC · 连接 · 在线时长 · ↓ · ↑ · 操作
├─ 离线设备表  同一面板下方：设备 · 上次 IP · MAC · 连接 · 离线多久 · 上次在线时长
├─ 事件时间线  筛选(全部/上线/离线) · 按日期分组 · 每条含时间、设备、IP、时长
├─ Toast       桌面右下角 / 手机顶部，3s 自动消失，可点击定位到设备行
└─ 设备抽屉    点击设备行展开：重命名 / 提醒开关 / 合并到 … / 最近会话列表
```

### 7.2 桌面布局（≥ 1200px）

- 顶栏 56px：左侧产品名 + 路由器型号；中间状态胶囊（`已连接 · 3s 轮询 · 2s 前`，不可达时变为琥珀色 `路由器不可达 · 已冻结 41s`）；右侧 WAN ↓/↑ 速率，等宽字体
- 指标行 4 个数字块，数值用等宽大字号（28px），副文案 12px
- 主区左右分栏 **2 : 1**（表格 ~900px / 时间线 ~440px），各自独立滚动，页面本身不滚动
- 设备表：行高 48px；状态列用 8px 圆点（绿=在线，琥珀=离线确认中并带秒数倒计时，灰=离线不显示在表中）；名称列下方小字显示路由器原始名；随机 MAC 用 `随机` 小标签；连接列用 `有线 / 5G / 2.4G` 文字标签；速率列右对齐，`0` 显示为淡色 `—`；在线时长每秒递增（前端本地计时，以 `startedAt` 为基准）
- 表头可点击排序（默认按上线时间倒序，新上线在顶）；顶部搜索框按名称/IP/MAC 过滤
- 时间线：按"今天 / 昨天 / 日期"分组；每条一行：时间（等宽）+ 圆点 + `设备名 已连入 · 192.168.31.102` 或 `设备名 已离开 · 在线 2 小时 15 分`；滚到底自动加载更早记录
- Toast：右下角堆叠（避免遮挡指标行），最多 3 条，绿边（上线）/ 红边（离线）；`notify=0` 的设备不弹，但时间线照常记录

### 7.3 手机布局（< 768px）

- 顶栏 + 指标 2×2 网格
- 底部分段控件切换「设备 / 事件」两个列表，列表占满剩余高度
- 设备卡片两行：名称 + 在线时长 / IP + 速率；点击进入抽屉（全屏 sheet）
- Toast 从顶部下滑

### 7.4 状态与空态

| 场景 | 表现 |
|---|---|
| 首次加载 | 骨架屏 800ms 内被 HELLO 替换 |
| WS 断开 | 顶栏状态胶囊变红 `已断开，重连中…`，数据保留但速率停止刷新、时长停止递增 |
| 路由器不可达 | 胶囊琥珀色；设备表保持最后快照并整体降低透明度；时间线插入一条系统事件 |
| 无在线设备 | 表格区域居中文案 `当前没有在线设备` |
| 时间线为空 | `暂无记录，第一条事件会出现在这里` |

### 7.5 视觉规范

- 背景 `#0f1216` / 面板 `#161b22` / 分割线 `#262d37` / 主文字 `#e6e9ef` / 次文字 `#8b95a5`
- 语义色：在线绿 `#5ad27a`、离开红 `#f0716a`、警告琥珀 `#f2b84b`、强调蓝 `#6cb6ff`（链接、选中、排序箭头）
- 字体：正文 `IBM Plex Sans / PingFang SC / Microsoft YaHei`；数字、IP、MAC、时间统一 `JetBrains Mono`
- 圆角 6px；无阴影，用 1px 边框分层；不使用渐变

---

## 8. 配置

`config.json`（环境变量同名大写覆盖，密码只从环境变量读）：

```jsonc
{
  "router": { "host": "192.168.31.1", "username": "admin", "timeoutMs": 5000 },
  "poll":   { "intervalMs": 3000, "leaveGraceMs": 30000, "unreachableAfter": 3 },
  "server": { "host": "0.0.0.0", "port": 8080 },
  "store":  { "path": "./data/miwifi.db", "retentionDays": 180 },
  "log":    { "level": "info" }
}
```

---

## 9. 目录结构

```
miwifi/
├─ src/
│  ├─ index.js            # 启动：加载配置 → Store.migrate → Poller.start → Hub.listen
│  ├─ config.js
│  ├─ router/client.js    # RouterClient
│  ├─ poller.js
│  ├─ state/engine.js     # StateEngine
│  ├─ store/db.js         # Store
│  ├─ store/migrations/001_init.sql
│  └─ hub/{http.js, ws.js, api.js}
├─ public/index.html      # 看板（Vue 3 CDN）
├─ design/                # 页面设计稿
├─ docs/DESIGN.md         # 本文档
├─ data/                  # 运行时数据库（gitignore）
├─ config.json
└─ package.json
```

---

## 10. 已知边界与风险

| 项 | 说明 | 应对 |
|---|---|---|
| 被动离线延迟 | 路由器自身老化 30~90s + 本系统 30s 缓冲，最坏约 2 分钟 | 文档与页面明示"离线确认中"，缓冲时长可配 |
| iOS/Android 随机 MAC | 同一手机在不同 SSID/重连后可能变 MAC | 自动标记 + 手动合并；合并后统计按逻辑设备计 |
| 路由器 API 非公开 | 固件升级可能改字段 | 字段映射集中在 `router/client.js`，入口做 schema 校验，异常时降级为不可达并告警 |
| 密码错误锁定 | 连续登录失败会被路由器限流 | 指数退避，上限 5 分钟 |
| 多个管理会话 | 与米家 App 同时登录 | 实测 AX6000 允许多 stok 并存；若互踢则改为共享一次登录并延长复用 |
| 数据增长 | 抖动设备一天上千行 | 180 天保留 + 索引；单表百万行 SQLite 无压力 |
| 看板无鉴权 | 局域网内任何人可访问 | 默认只监听内网；可配置 Basic Auth |

---

## 11. 实施计划

| 阶段 | 交付 | 验收 |
|---|---|---|
| M0 探针 | `scripts/probe.js`：登录并打印 `devicelist` / `status` 原始 JSON | 确认 4.1 字段映射；测出关 Wi-Fi 后 `online` 翻转耗时 |
| M1 核心 | RouterClient + Poller + StateEngine + Store | 跑 24h 无误报；重启进程会话不断裂；拔路由器电源不产生离线风暴 |
| M2 服务 | Hub：REST + WS + 静态托管 | `wscat` 能收到 HELLO/SYNC/JOIN/LEAVE；REST 全部可用 |
| M3 看板 | `public/index.html` 按第 7 章实现 | 桌面/手机两种布局；Toast、重命名、合并可用 |
| M4 收尾 | 保留策略、CSV 导出、pm2/Docker 配置、README | 一条命令部署 |
