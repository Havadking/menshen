import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.js';
import { StateEngine } from '../src/state/engine.js';

function dev(mac, extra = {}) {
  return { mac, name: `dev-${mac.slice(-2)}`, ip: `192.168.31.${parseInt(mac.slice(-2), 16)}`, online: true, down: 0, up: 0, onlineSec: 0, connType: '5g', push: null, ...extra };
}

function setup({ leaveGraceMs = 30_000, unreachableAfter = 3 } = {}) {
  const store = new Store(':memory:');
  let now = 1_000_000;
  const clock = { now: () => now, tick: (ms) => { now += ms; } };
  const engine = new StateEngine(store, { leaveGraceMs, unreachableAfter, now: clock.now });
  const events = [];
  for (const e of ['join', 'leave', 'router', 'update']) engine.on(e, (d) => events.push({ e, ...d }));
  const ok = (devices, wan = { down: 0, up: 0 }) => engine.handlePoll({ ok: true, devices, wan });
  const fail = () => engine.handlePoll({ ok: false, error: new Error('timeout') });
  return { store, engine, events, clock, ok, fail };
}

const A = 'AA:BB:CC:00:00:01';
const B = 'AA:BB:CC:00:00:02';

test('首轮为 warm start：不广播 JOIN，但会建档开会话', () => {
  const { store, engine, events, ok } = setup();
  ok([dev(A), dev(B)]);
  assert.equal(events.length, 0);
  assert.equal(engine.tracked.size, 2);
  assert.equal(store.getOpenSessions().length, 2);
  assert.equal(store.getDevice(A).isOnline, true);
});

test('warm start 用路由器在线秒数反推会话起点', () => {
  const { store, clock, ok } = setup();
  ok([dev(A, { onlineSec: 600 })]);
  const s = store.getOpenSessions()[0];
  assert.equal(s.started_at, clock.now() - 600_000);
  assert.equal(s.start_source, 'warm');
});

test('warm start 沿用库中未闭合会话，补闭合已消失设备的会话', () => {
  const store = new Store(':memory:');
  const t0 = 1_000_000;
  store.seenDevice({ mac: A, routerName: 'a', now: t0 - 5000 });
  const sidA = store.openSession({ mac: A, ip: '1.1.1.1', startedAt: t0 - 5000, lastSeenAt: t0 - 3000 });
  store.seenDevice({ mac: B, routerName: 'b', now: t0 - 5000 });
  const sidB = store.openSession({ mac: B, ip: '2.2.2.2', startedAt: t0 - 9000, lastSeenAt: t0 - 3000 });

  const engine = new StateEngine(store, { now: () => t0 });
  engine.handlePoll({ ok: true, devices: [dev(A, { onlineSec: 5 })], wan: {} });

  assert.equal(engine.tracked.get(A).sessionId, sidA);
  const closedB = store.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sidB);
  assert.equal(closedB.ended_at, t0 - 3000);
  assert.equal(closedB.end_source, 'recover');
  assert.equal(store.getDevice(B).isOnline, false);
});

test('新设备出现触发 JOIN 并写会话', () => {
  const { store, events, clock, ok } = setup();
  ok([dev(A)]);
  clock.tick(3000);
  ok([dev(A), dev(B)]);
  assert.equal(events.length, 1);
  assert.equal(events[0].e, 'join');
  assert.equal(events[0].mac, B);
  assert.equal(events[0].ts, clock.now());
  assert.equal(store.getOpenSessions().length, 2);
});

test('设备消失后 30s 内恢复不产生事件', () => {
  const { events, engine, clock, ok } = setup();
  ok([dev(A)]);
  clock.tick(3000); ok([]);
  assert.equal(engine.tracked.get(A).status, 'PENDING_LEAVE');
  clock.tick(20_000); ok([dev(A)]);
  assert.equal(engine.tracked.get(A).status, 'ONLINE');
  assert.equal(events.length, 0);
});

test('设备消失超过缓冲时间后 LEAVE，时间取最后一次见到', () => {
  const { store, events, clock, ok } = setup();
  ok([dev(A)]);
  clock.tick(3000); ok([dev(A)]);
  const lastSeen = clock.now();
  clock.tick(3000); ok([]);                 // 进入观察
  clock.tick(29_000); ok([]);               // 29s：未到
  assert.equal(events.length, 0);
  clock.tick(3000); ok([]);                 // 32s：确认离线
  assert.equal(events.length, 1);
  assert.equal(events[0].e, 'leave');
  assert.equal(events[0].ts, lastSeen);
  const s = store.db.prepare('SELECT * FROM sessions WHERE mac = ?').get(A);
  assert.equal(s.ended_at, lastSeen);
  assert.equal(s.duration_ms, lastSeen - s.started_at);
  assert.equal(store.getDevice(A).isOnline, false);
});

test('连续失败进入不可达，期间不判离线，恢复后计时顺延', () => {
  const { events, engine, clock, ok, fail } = setup();
  ok([dev(A)]);
  clock.tick(3000); ok([]);                 // A 进入观察 (pendingSince = t)
  clock.tick(3000); fail();
  clock.tick(3000); fail();
  clock.tick(3000); fail();                 // 第 3 次 → 不可达
  assert.equal(engine.reachable, false);
  assert.equal(events.filter((e) => e.e === 'router').length, 1);
  clock.tick(60_000); fail();               // 不可达期间不产生 LEAVE
  assert.equal(events.filter((e) => e.e === 'leave').length, 0);
  clock.tick(3000); ok([]);                 // 恢复；pendingSince 顺延了约 69s，此时观察计时 ≈ 6s
  assert.equal(engine.reachable, true);
  assert.equal(events.filter((e) => e.e === 'leave').length, 0);
  clock.tick(30_000); ok([]);               // 顺延后再过 30s 才离线
  assert.equal(events.filter((e) => e.e === 'leave').length, 1);
});

test('快照包含速率、待离线标记与档案信息', () => {
  const { store, engine, clock, ok } = setup();
  ok([dev(A, { down: 1024, up: 10 })]);
  store.updateDevice(A, { customName: '我的手机', notify: false });
  engine.refreshProfile(A);
  const snap = engine.snapshot();
  assert.equal(snap.devices[0].name, '我的手机');
  assert.equal(snap.devices[0].notify, false);
  assert.equal(snap.devices[0].down, 1024);
  clock.tick(3000); ok([]);
  assert.equal(engine.snapshot().devices[0].pendingLeave, true);
});

test('随机 MAC 会被标记', () => {
  const { store, ok } = setup();
  ok([dev('6A:11:22:33:44:55'), dev('00:11:22:33:44:56')]);
  assert.equal(store.getDevice('6A:11:22:33:44:55').isRandomMac, true);
  assert.equal(store.getDevice('00:11:22:33:44:56').isRandomMac, false);
});
