import { EventEmitter } from 'node:events';
import { isRandomMac } from '../router/client.js';
import { friendlyName } from '../router/names.js';
import { createLogger } from '../logger.js';

const log = createLogger('state');

// warm start 时，路由器统计的上线时间（now - statistics.online）有几秒到几十秒误差，
// 只有它明显晚于我们最后一次见到设备的时刻，才认定设备在进程停止期间断开过。
const WARM_RESTART_TOLERANCE_MS = 60_000;

/**
 * 差量检测 + 消抖 + 路由器不可达保护。
 * 事件：'join' | 'leave' | 'sync' | 'router' | 'update'
 */
export class StateEngine extends EventEmitter {
  /**
   * @param {import('../store/db.js').Store} store
   * @param {{leaveGraceMs?:number, unreachableAfter?:number, now?:()=>number}} opts
   */
  constructor(store, opts = {}) {
    super();
    this.store = store;
    this.leaveGraceMs = opts.leaveGraceMs ?? 30_000;
    this.unreachableAfter = opts.unreachableAfter ?? 3;
    this.now = opts.now ?? Date.now;

    /** @type {Map<string, object>} mac → Tracked */
    this.tracked = new Map();
    this.started = false;
    this.reachable = true;
    this.failures = 0;
    this.unreachableSince = null;
    this.lastError = null;
    this.lastPollAt = null;
    this.wan = { down: 0, up: 0 };
  }

  // ---------- 入口 ----------

  /** @param {{ok:true, devices:object[], wan:{down:number,up:number}} | {ok:false, error:Error}} result */
  handlePoll(result) {
    const now = this.now();
    if (!result.ok) return this._onFailure(result.error, now);

    const wasUnreachable = !this.reachable;
    if (this.failures > 0 || wasUnreachable) this._onRecover(now);
    this.lastPollAt = now;
    this.wan = result.wan ?? this.wan;

    const online = result.devices.filter((d) => d.online && d.mac);
    if (!this.started) {
      this._warmStart(online, now);
      this.started = true;
    } else {
      this._diff(online, now);
    }
    this.emit('sync', this.snapshot());
  }

  // ---------- 不可达 ----------

  _onFailure(error, now) {
    this.failures += 1;
    this.lastError = error?.message ?? String(error);
    if (this.reachable && this.failures >= this.unreachableAfter) {
      this.reachable = false;
      this.unreachableSince = now;
      log.warn(`路由器不可达（连续失败 ${this.failures} 次）：${this.lastError}`);
      this.emit('router', this.routerState());
    }
  }

  _onRecover(now) {
    const downtime = this.unreachableSince ? now - this.unreachableSince : 0;
    if (!this.reachable) {
      // 不可达期间离线观察计时暂停：把 pendingSince 顺延
      for (const t of this.tracked.values()) {
        if (t.status === 'PENDING_LEAVE') t.pendingSince += downtime;
      }
      this.reachable = true;
      log.info(`路由器恢复可达，中断 ${Math.round(downtime / 1000)}s`);
    }
    this.failures = 0;
    this.lastError = null;
    this.unreachableSince = null;
    if (downtime) this.emit('router', { ...this.routerState(), downtimeMs: downtime });
  }

  // ---------- 冷启动 ----------

  _warmStart(online, now) {
    const openByMac = new Map(this.store.getOpenSessions().map((s) => [s.mac, s]));
    this.store.setAllOffline();

    for (const d of online) {
      const s = openByMac.get(d.mac);
      openByMac.delete(d.mac);
      const routerStart = d.onlineSec > 0 ? now - d.onlineSec * 1000 : null;

      if (s) {
        // 进程停止的时间不超过离线缓冲：等同于一次正常轮询间隔，直接沿用会话。
        // 停止较久时，看路由器计数器：它说的上线时刻若早于我们最后一次见到设备，
        // 说明中间没断（计数器在我们监控期间重置过也算没断）；明显晚于才算断开过。
        const gap = now - s.last_seen_at;
        const rejoined = gap > this.leaveGraceMs && routerStart && routerStart - s.last_seen_at > WARM_RESTART_TOLERANCE_MS;
        if (!rejoined) {
          this._track(d, now, { sessionId: s.id, startedAt: s.started_at, profile: this._profile(d, now) });
          continue;
        }
        // 设备在进程停止期间离开又回来：旧会话闭合在最后一次见到的时刻，新会话从路由器给的时刻开始
        this.store.closeSession(s.id, { endedAt: s.last_seen_at, endSource: 'recover' });
      }
      // 首轮只落库不广播：避免进程重启时看板弹一排 Toast
      this._join(d, now, { startedAt: routerStart ?? now, source: 'warm', silent: true });
    }

    for (const s of openByMac.values()) {
      this.store.closeSession(s.id, { endedAt: s.last_seen_at, endSource: 'recover' });
      log.info(`补闭合会话 #${s.id} ${s.mac}`);
    }
    log.info(`warm start：在线 ${this.tracked.size} 台，补闭合 ${openByMac.size} 条会话`);
  }

  // ---------- 差量 ----------

  _diff(online, now) {
    const seen = new Set();
    const touch = [];

    for (const d of online) {
      seen.add(d.mac);
      const t = this.tracked.get(d.mac);
      if (!t) {
        this._join(d, now, { startedAt: now, source: 'poll' });
        continue;
      }
      if (t.status === 'PENDING_LEAVE') {
        t.status = 'ONLINE';
        t.pendingSince = null;
      }
      const nameChanged = d.name && d.name !== t.routerName;
      Object.assign(t, { ip: d.ip ?? t.ip, routerName: d.name ?? t.routerName, connType: d.connType ?? t.connType, parentMac: d.parentMac, down: d.down, up: d.up, lastSeenAt: now });
      touch.push({ mac: d.mac, routerName: d.name, friendlyName: nameChanged ? friendlyName(d.name) : null, connType: d.connType, ip: d.ip, now, sessionId: t.sessionId });
      if (nameChanged) this.refreshProfile(d.mac);
    }
    if (touch.length) this.store.touchMany(touch);

    for (const t of this.tracked.values()) {
      if (seen.has(t.mac)) continue;
      if (t.status === 'ONLINE') {
        t.status = 'PENDING_LEAVE';
        t.pendingSince = now;
        t.down = 0;
        t.up = 0;
      } else if (now - t.pendingSince >= this.leaveGraceMs) {
        this._leave(t);
      }
    }
  }

  /** 建档/刷新档案（必须先于开会话，外键约束） */
  _profile(d, now) {
    return this.store.seenDevice({
      mac: d.mac, routerName: d.name, friendlyName: friendlyName(d.name), connType: d.connType, ip: d.ip,
      isRandomMac: isRandomMac(d.mac), now,
    });
  }

  _track(d, now, { sessionId, startedAt, profile }) {
    const t = {
      mac: d.mac,
      ip: d.ip,
      routerName: d.name,
      connType: d.connType,
      parentMac: d.parentMac,
      down: d.down,
      up: d.up,
      status: 'ONLINE',
      sessionId,
      startedAt,
      lastSeenAt: now,
      pendingSince: null,
      profile,
    };
    this.tracked.set(d.mac, t);
    this.store.touchMany([{ mac: d.mac, routerName: d.name, connType: d.connType, ip: d.ip, now, sessionId }]);
    return t;
  }

  _join(d, now, { startedAt, source, silent = false }) {
    const profile = this._profile(d, now);
    const sessionId = this.store.openSession({ mac: d.mac, ip: d.ip, startedAt, lastSeenAt: now, startSource: source });
    const t = this._track(d, now, { sessionId, startedAt, profile });
    this._autoMerge(t);
    // 同一逻辑设备的另一个 MAC 还在（比如手机从 2.4G 切到 5G），只是换了个口，不弹提醒
    const handoff = this._hasPeer(t, () => true);
    const ev = {
      mac: d.mac, name: t.profile.name, ip: d.ip, connType: d.connType,
      sessionId, ts: startedAt, source, notify: t.profile.notify && !handoff,
    };
    log.info(`JOIN  ${ev.name} (${d.mac}) ${d.ip ?? ''} [${source}]`);
    if (!silent) this.emit('join', ev);
    return t;
  }

  _leave(t) {
    const endedAt = t.lastSeenAt;
    this.store.closeSession(t.sessionId, { endedAt, endSource: 'poll' });
    this.store.setDeviceOffline(t.mac);
    this.tracked.delete(t.mac);
    const handoff = this._hasPeer(t, (p) => p.status === 'ONLINE');
    const ev = {
      mac: t.mac, name: t.profile.name, ip: t.ip, connType: t.connType,
      sessionId: t.sessionId, durationMs: Math.max(0, endedAt - t.startedAt), ts: endedAt, notify: t.profile.notify && !handoff,
    };
    log.info(`LEAVE ${ev.name} (${t.mac}) 在线 ${Math.round(ev.durationMs / 1000)}s`);
    this.emit('leave', ev);
    // 新 MAC 上线时旧 MAC 还没从路由器列表里消失，当时没合并成；旧的走了再试一次
    for (const p of this.tracked.values()) {
      if (p.routerName && p.routerName === t.routerName && !p.profile.canonicalMac) this._autoMerge(p);
    }
  }

  // ---------- 自动合并 ----------

  /** 按主机名把随机 MAC 并入同一逻辑设备（规则见 Store#autoMerge）；目标组有成员正在线时不合并 */
  _autoMerge(t) {
    if (!t.profile.isRandomMac || t.profile.canonicalMac) return;
    const busy = new Set();
    for (const p of this.tracked.values()) if (p !== t && p.status === 'ONLINE') busy.add(p.mac);
    if (this.store.autoMerge(t.mac, { busy })) this.refreshProfile(t.mac);
  }

  /** 同一逻辑设备的其他 MAC 中是否有满足条件的 */
  _hasPeer(t, pred) {
    const key = t.profile.canonicalMac ?? t.mac;
    for (const p of this.tracked.values()) {
      if (p !== t && (p.profile.canonicalMac ?? p.mac) === key && pred(p)) return true;
    }
    return false;
  }

  // ---------- 档案 ----------

  /** 档案（自定义名/合并/提醒）在库中变了，刷新内存副本并广播 */
  refreshProfile(mac) {
    const profile = this.store.getDevice(mac);
    const t = this.tracked.get(mac);
    if (t && profile) t.profile = profile;
    if (profile) this.emit('update', profile);
    return profile;
  }

  // ---------- 快照 ----------

  routerState() {
    return { reachable: this.reachable, failures: this.failures, lastPollAt: this.lastPollAt, error: this.lastError };
  }

  snapshot() {
    const devices = [...this.tracked.values()].map((t) => ({
      mac: t.mac,
      name: t.profile.name,
      customName: t.profile.customName,
      routerName: t.routerName,
      friendlyName: t.profile.friendlyName,
      ip: t.ip,
      connType: t.connType,
      parentMac: t.parentMac,
      parentName: t.parentMac ? (this.tracked.get(t.parentMac)?.profile.name ?? null) : null,
      down: t.down,
      up: t.up,
      startedAt: t.startedAt,
      sessionId: t.sessionId,
      pendingLeave: t.status === 'PENDING_LEAVE',
      pendingSince: t.pendingSince,
      isRandomMac: t.profile.isRandomMac,
      canonicalMac: t.profile.canonicalMac,
      notify: t.profile.notify,
    }));
    devices.sort((a, b) => b.startedAt - a.startedAt);
    return { router: this.routerState(), wan: this.wan, devices, leaveGraceMs: this.leaveGraceMs };
  }
}
