import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logger.js';

const log = createLogger('store');
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

// 设备展示名：合并目标的自定义名 > 自己的自定义名 > 字典友好名 > 路由器上报名 > MAC
const DEVICE_SELECT = `
  SELECT d.*,
         COALESCE(c.custom_name, d.custom_name, d.friendly_name, d.router_name, d.mac) AS display_name
  FROM devices d
  LEFT JOIN devices c ON c.mac = d.canonical_mac
`;

function rowToDevice(r) {
  if (!r) return null;
  return {
    mac: r.mac,
    routerName: r.router_name,
    friendlyName: r.friendly_name,
    customName: r.custom_name,
    name: r.display_name,
    canonicalMac: r.canonical_mac,
    isRandomMac: !!r.is_random_mac,
    connType: r.conn_type,
    lastIp: r.last_ip,
    isOnline: !!r.is_online,
    notify: !!r.notify,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
  };
}

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this._prepare();
  }

  migrate() {
    const current = this.db.pragma('user_version', { simple: true });
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    let version = current;
    for (const f of files) {
      const n = Number(f.slice(0, 3));
      if (n <= current) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db.pragma(`user_version = ${n}`);
      })();
      version = n;
      log.info(`已应用迁移 ${f}`);
    }
    return version;
  }

  _prepare() {
    const db = this.db;
    this.q = {
      getDevice: db.prepare(`${DEVICE_SELECT} WHERE d.mac = ?`),
      insertDevice: db.prepare(`
        INSERT INTO devices (mac, router_name, friendly_name, is_random_mac, conn_type, last_ip, is_online, notify, first_seen_at, last_seen_at)
        VALUES (@mac, @routerName, @friendlyName, @isRandomMac, @connType, @ip, 1, @notify, @now, @now)`),
      touchDevice: db.prepare(`
        UPDATE devices SET router_name = COALESCE(@routerName, router_name),
                           friendly_name = COALESCE(@friendlyName, friendly_name),
                           conn_type = COALESCE(@connType, conn_type),
                           last_ip = COALESCE(@ip, last_ip),
                           is_online = 1, last_seen_at = @now
        WHERE mac = @mac`),
      setOffline: db.prepare(`UPDATE devices SET is_online = 0 WHERE mac = ?`),
      setAllOffline: db.prepare(`UPDATE devices SET is_online = 0`),
      openSession: db.prepare(`
        INSERT INTO sessions (mac, ip, started_at, last_seen_at, start_source)
        VALUES (@mac, @ip, @startedAt, @lastSeenAt, @startSource)`),
      touchSession: db.prepare(`UPDATE sessions SET last_seen_at = @lastSeenAt, ip = COALESCE(@ip, ip) WHERE id = @id`),
      closeSession: db.prepare(`
        UPDATE sessions SET ended_at = @endedAt, duration_ms = @endedAt - started_at, end_source = @endSource
        WHERE id = @id AND ended_at IS NULL`),
      openSessions: db.prepare(`SELECT * FROM sessions WHERE ended_at IS NULL`),
      getSession: db.prepare(`SELECT * FROM sessions WHERE id = ?`),
      getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
      setSetting: db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
      prune: db.prepare(`DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at < ?`),
    };
    this.tx = {
      touchMany: db.transaction((rows) => {
        for (const r of rows) {
          this.q.touchDevice.run({ friendlyName: null, ...r });
          if (r.sessionId) this.q.touchSession.run({ id: r.sessionId, lastSeenAt: r.now, ip: r.ip });
        }
      }),
    };
  }

  // ---------- devices ----------

  getDevice(mac) {
    return rowToDevice(this.q.getDevice.get(mac));
  }

  /** 设备出现在在线列表：不存在则建档，存在则刷新。返回档案。 */
  seenDevice({ mac, routerName, friendlyName = null, connType, ip, isRandomMac, push, now }) {
    const existing = this.q.getDevice.get(mac);
    if (!existing) {
      this.q.insertDevice.run({
        mac, routerName, friendlyName, connType, ip, now,
        isRandomMac: isRandomMac ? 1 : 0,
        notify: push === false ? 0 : 1,
      });
    } else {
      this.q.touchDevice.run({ mac, routerName, friendlyName, connType, ip, now });
    }
    return this.getDevice(mac);
  }

  /** 用字典为全部设备重算 friendly_name（启动时执行一次，字典更新后离线设备也能跟上） */
  backfillFriendlyNames(fn) {
    const rows = this.db.prepare('SELECT mac, router_name, friendly_name FROM devices').all();
    const upd = this.db.prepare('UPDATE devices SET friendly_name = ? WHERE mac = ?');
    let n = 0;
    this.db.transaction(() => {
      for (const r of rows) {
        const f = fn(r.router_name);
        if ((f ?? null) !== (r.friendly_name ?? null)) { upd.run(f, r.mac); n++; }
      }
    })();
    return n;
  }

  touchMany(rows) {
    this.tx.touchMany(rows);
  }

  setDeviceOffline(mac) {
    this.q.setOffline.run(mac);
  }

  setAllOffline() {
    this.q.setAllOffline.run();
  }

  listDevices({ q = '', onlineOnly = false } = {}) {
    const where = [];
    const params = {};
    if (onlineOnly) where.push('d.is_online = 1');
    if (q) {
      where.push(`(d.mac LIKE @q OR d.last_ip LIKE @q OR d.router_name LIKE @q OR d.friendly_name LIKE @q OR d.custom_name LIKE @q OR c.custom_name LIKE @q)`);
      params.q = `%${q}%`;
    }
    const sql = `${DEVICE_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.is_online DESC, d.last_seen_at DESC`;
    return this.db.prepare(sql).all(params).map(rowToDevice);
  }

  /** 修改档案；返回更新后的设备，不存在返回 null */
  updateDevice(mac, patch) {
    const sets = [];
    const params = { mac };
    if ('customName' in patch) {
      sets.push('custom_name = @customName');
      params.customName = patch.customName ? String(patch.customName).trim().slice(0, 64) : null;
    }
    if ('notify' in patch) {
      sets.push('notify = @notify');
      params.notify = patch.notify ? 1 : 0;
    }
    if ('canonicalMac' in patch) {
      const target = patch.canonicalMac ? String(patch.canonicalMac).toUpperCase() : null;
      if (target === mac) throw new Error('不能把设备合并到自己');
      if (target && !this.q.getDevice.get(target)) throw new Error(`合并目标不存在: ${target}`);
      if (target && this.q.getDevice.get(target).canonical_mac) throw new Error('合并目标本身已被合并，请选择最终设备');
      sets.push('canonical_mac = @canonicalMac');
      params.canonicalMac = target;
    }
    if (!sets.length) return this.getDevice(mac);
    const info = this.db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE mac = @mac`).run(params);
    return info.changes ? this.getDevice(mac) : null;
  }

  // ---------- sessions ----------

  openSession({ mac, ip, startedAt, lastSeenAt = startedAt, startSource = 'poll' }) {
    const info = this.q.openSession.run({ mac, ip, startedAt, lastSeenAt, startSource });
    return Number(info.lastInsertRowid);
  }

  closeSession(id, { endedAt, endSource = 'poll' }) {
    this.q.closeSession.run({ id, endedAt, endSource });
    return this.q.getSession.get(id);
  }

  getOpenSessions() {
    return this.q.openSessions.all();
  }

  listSessions({ mac, from, to, limit = 200 } = {}) {
    const where = [];
    const params = { limit };
    if (mac) { where.push('mac = @mac'); params.mac = mac; }
    if (from) { where.push('(ended_at IS NULL OR ended_at >= @from)'); params.from = from; }
    if (to) { where.push('started_at <= @to'); params.to = to; }
    const sql = `SELECT * FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC LIMIT @limit`;
    return this.db.prepare(sql).all(params);
  }

  /** 事件流：由会话两端派生 */
  listEvents({ limit = 50, before, type, mac } = {}) {
    const where = [];
    const params = { limit: Math.min(Number(limit) || 50, 500) };
    if (before) { where.push('e.at < @before'); params.before = Number(before); }
    if (type === 'JOIN' || type === 'LEAVE') { where.push('e.type = @type'); params.type = type; }
    if (mac) { where.push('e.mac = @mac'); params.mac = mac; }
    const sql = `
      SELECT e.*, COALESCE(c.custom_name, d.custom_name, d.friendly_name, d.router_name, d.mac) AS name, d.conn_type
      FROM (
        SELECT id AS session_id, 'JOIN'  AS type, started_at AS at, mac, ip, NULL AS duration_ms, start_source AS source FROM sessions
        UNION ALL
        SELECT id, 'LEAVE', ended_at, mac, ip, duration_ms, end_source FROM sessions WHERE ended_at IS NOT NULL
      ) e
      JOIN devices d ON d.mac = e.mac
      LEFT JOIN devices c ON c.mac = d.canonical_mac
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY e.at DESC, e.type ASC
      LIMIT @limit`;
    return this.db.prepare(sql).all(params).map((r) => ({
      type: r.type,
      at: r.at,
      mac: r.mac,
      name: r.name,
      ip: r.ip,
      connType: r.conn_type,
      durationMs: r.duration_ms,
      sessionId: r.session_id,
      source: r.source,
    }));
  }

  statsToday(todayStartMs) {
    const devices = this.db.prepare(`
      SELECT COUNT(DISTINCT COALESCE(d.canonical_mac, d.mac)) AS n
      FROM sessions s JOIN devices d ON d.mac = s.mac
      WHERE s.ended_at IS NULL OR s.ended_at >= ? OR s.started_at >= ?`).get(todayStartMs, todayStartMs).n;
    const joins = this.db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE started_at >= ?`).get(todayStartMs).n;
    const leaves = this.db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE ended_at >= ?`).get(todayStartMs).n;
    const online = this.db.prepare(`SELECT COUNT(*) AS n FROM devices WHERE is_online = 1`).get().n;
    return { online, devicesToday: devices, joinsToday: joins, leavesToday: leaves, eventsToday: joins + leaves };
  }

  exportSessions({ from, to }) {
    return this.db.prepare(`
      SELECT s.id, s.mac, COALESCE(c.custom_name, d.custom_name, d.friendly_name, d.router_name, d.mac) AS name,
             s.ip, s.started_at, s.ended_at, s.duration_ms, s.start_source, s.end_source
      FROM sessions s JOIN devices d ON d.mac = s.mac LEFT JOIN devices c ON c.mac = d.canonical_mac
      WHERE (@from IS NULL OR s.started_at >= @from) AND (@to IS NULL OR s.started_at <= @to)
      ORDER BY s.started_at ASC`).all({ from: from ?? null, to: to ?? null });
  }

  pruneSessions(retentionDays, now = Date.now()) {
    if (!retentionDays || retentionDays <= 0) return 0;
    const cutoff = now - retentionDays * 86_400_000;
    return this.q.prune.run(cutoff).changes;
  }

  // ---------- settings ----------

  getSetting(key, fallback = null) {
    const r = this.q.getSetting.get(key);
    return r ? r.value : fallback;
  }

  setSetting(key, value) {
    this.q.setSetting.run(key, String(value));
  }

  close() {
    this.db.close();
  }
}
