import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.js';
import { hashPassword, normalizeDevice, connTypeOf } from '../src/router/client.js';

const A = 'AA:BB:CC:00:00:01';
const B = 'AA:BB:CC:00:00:02';

test('事件流由会话派生，包含展示名与时长', () => {
  const store = new Store(':memory:');
  store.seenDevice({ mac: A, routerName: 'phone', now: 1000 });
  const id = store.openSession({ mac: A, ip: '10.0.0.1', startedAt: 1000 });
  store.closeSession(id, { endedAt: 61_000 });
  const ev = store.listEvents({ limit: 10 });
  assert.equal(ev.length, 2);
  assert.equal(ev[0].type, 'LEAVE');
  assert.equal(ev[0].durationMs, 60_000);
  assert.equal(ev[1].type, 'JOIN');
  assert.equal(ev[1].name, 'phone');
  assert.equal(store.listEvents({ type: 'JOIN' }).length, 1);
  assert.equal(store.listEvents({ before: 61_000 }).length, 1);
});

test('自定义名与合并影响展示名；今日设备数按逻辑设备计', () => {
  const store = new Store(':memory:');
  store.seenDevice({ mac: A, routerName: 'iPhone', now: 1000 });
  store.seenDevice({ mac: B, routerName: 'iPhone', now: 1000 });
  store.openSession({ mac: A, ip: null, startedAt: 1000 });
  store.openSession({ mac: B, ip: null, startedAt: 2000 });
  assert.equal(store.statsToday(0).devicesToday, 2);

  store.updateDevice(A, { customName: '小王的手机' });
  store.updateDevice(B, { canonicalMac: A });
  assert.equal(store.getDevice(B).name, '小王的手机');
  assert.equal(store.statsToday(0).devicesToday, 1);

  store.updateDevice(B, { canonicalMac: null });
  assert.equal(store.getDevice(B).name, 'iPhone');
  assert.throws(() => store.updateDevice(A, { canonicalMac: A }));
  assert.throws(() => store.updateDevice(A, { canonicalMac: 'FF:FF:FF:FF:FF:FF' }));
});

test('离线设备列表带最近一次会话', () => {
  const store = new Store(':memory:');
  store.seenDevice({ mac: A, routerName: 'a', now: 1000 });
  const id = store.openSession({ mac: A, ip: '10.0.0.1', startedAt: 1000 });
  store.closeSession(id, { endedAt: 5000 });
  store.setDeviceOffline(A);
  store.seenDevice({ mac: B, routerName: 'b', now: 1000 }); // 在线，不应出现
  const off = store.listOfflineDevices();
  assert.equal(off.length, 1);
  assert.equal(off[0].mac, A);
  assert.equal(off[0].lastDurationMs, 4000);
  assert.equal(off[0].lastEndedAt, 5000);
});

test('保留策略只删除已闭合的过期会话', () => {
  const store = new Store(':memory:');
  store.seenDevice({ mac: A, routerName: 'x', now: 0 });
  const old = store.openSession({ mac: A, ip: null, startedAt: 0 });
  store.closeSession(old, { endedAt: 1000 });
  store.openSession({ mac: A, ip: null, startedAt: 0 });
  const now = 200 * 86_400_000;
  assert.equal(store.pruneSessions(180, now), 1);
  assert.equal(store.getOpenSessions().length, 1);
});

test('登录密码哈希：newEncryptMode=1 用 sha256，否则 sha1', () => {
  const h1 = hashPassword('pw', 'nonce', 1);
  const h0 = hashPassword('pw', 'nonce', 0);
  assert.equal(h1.length, 64);
  assert.equal(h0.length, 40);
});

test('devicelist 归一化', () => {
  const d = normalizeDevice({
    mac: 'aa-bb-cc-dd-ee-ff', name: 'Phone', oname: 'phone-orig', online: '1', push: '0',
    ip: [{ ip: '192.168.31.5', downspeed: '100', upspeed: '20', online: '1' }],
    statistics: { online: '3600', downspeed: '100', upspeed: '20' },
    type: { type: 'wifi', wifiIndex: 2 },
  });
  assert.deepEqual(d, {
    mac: 'AA:BB:CC:DD:EE:FF', name: 'Phone', ip: '192.168.31.5', online: true,
    down: 100, up: 20, onlineSec: 3600, connType: '5g', parentMac: null, isAp: false, push: false,
  });
  // Redmi AX6000 实测：type 为数字，parent 为上级 Mesh 节点
  const real = normalizeDevice({ mac: 'cc:47:40:c1:9c:6a', name: 'Havad', online: 1, type: 2, isap: 0, parent: 'A4:A9:30:CC:AB:58', push: 0,
    ip: [{ ip: '192.168.31.192', online: '53589', active: 1, downspeed: '126049', upspeed: '285791' }], statistics: { online: '53589' } });
  assert.equal(real.connType, '5g');
  assert.equal(real.parentMac, 'A4:A9:30:CC:AB:58');
  assert.equal(real.onlineSec, 53589);
  assert.equal(connTypeOf({ type: 0 }), 'wired');
  assert.equal(connTypeOf({ type: 1 }), '2.4g');
  assert.equal(connTypeOf({ type: { type: 'wired' } }), 'wired');
  assert.equal(connTypeOf({ type: { type: 'wifi', wifiIndex: 1 } }), '2.4g');
  assert.equal(normalizeDevice({ mac: 'x', online: 0 }).online, false);
});

test('随机 MAC 同主机名自动合并：优先有自定义名的，其次最早出现的', () => {
  const store = new Store(':memory:');
  const C = 'AA:BB:CC:00:00:03';
  store.seenDevice({ mac: A, routerName: 'realme-GT5-Pro', isRandomMac: true, now: 1000 });
  store.seenDevice({ mac: B, routerName: 'realme-GT5-Pro', isRandomMac: true, now: 2000 });
  store.seenDevice({ mac: C, routerName: 'realme-GT5-Pro', isRandomMac: true, now: 3000 });
  store.updateDevice(B, { customName: '我的手机' });
  assert.equal(store.autoMergeAll(), 2);
  assert.equal(store.getDevice(A).canonicalMac, B);
  assert.equal(store.getDevice(C).canonicalMac, B);
  assert.equal(store.getDevice(A).name, '我的手机');
  assert.equal(store.getDevice(A).mergeSource, 'auto');
  assert.equal(store.getDevice(B).canonicalMac, null);
});

test('自动合并不处理固定 MAC、通用主机名、长时间同时在线的设备', () => {
  const store = new Store(':memory:');
  const F1 = '00:11:22:00:00:01', F2 = '00:11:22:00:00:02';
  store.seenDevice({ mac: F1, routerName: 'lamp', isRandomMac: false, now: 1000 });
  store.seenDevice({ mac: F2, routerName: 'lamp', isRandomMac: false, now: 2000 });
  store.seenDevice({ mac: A, routerName: 'iPhone', isRandomMac: true, now: 1000 });
  store.seenDevice({ mac: B, routerName: 'iPhone', isRandomMac: true, now: 2000 });
  assert.equal(store.autoMergeAll(), 0);

  // 两部同型号手机：同时在线一小时，不是同一台
  const C = 'AA:BB:CC:00:00:03', D = 'AA:BB:CC:00:00:04';
  store.seenDevice({ mac: C, routerName: 'Redmi-K50', isRandomMac: true, now: 0 });
  store.seenDevice({ mac: D, routerName: 'Redmi-K50', isRandomMac: true, now: 1 });
  store.closeSession(store.openSession({ mac: C, ip: null, startedAt: 0 }), { endedAt: 3_600_000 });
  store.closeSession(store.openSession({ mac: D, ip: null, startedAt: 60_000 }), { endedAt: 3_600_000 });
  assert.equal(store.autoMerge(D), null);

  // 切频段：旧 MAC 离开后新 MAC 才出现，会合并
  const E = 'AA:BB:CC:00:00:05', F = 'AA:BB:CC:00:00:06', G = 'AA:BB:CC:00:00:07';
  store.seenDevice({ mac: E, routerName: 'OPPO-A11', isRandomMac: true, now: 0 });
  store.seenDevice({ mac: F, routerName: 'OPPO-A11', isRandomMac: true, now: 1 });
  store.closeSession(store.openSession({ mac: E, ip: null, startedAt: 0 }), { endedAt: 60_000 });
  store.openSession({ mac: F, ip: null, startedAt: 61_000 });
  assert.equal(store.autoMerge(F), E);
  // 目标组有成员正在线时不合并
  store.seenDevice({ mac: G, routerName: 'OPPO-A11', isRandomMac: true, now: 2 });
  assert.equal(store.autoMerge(G, { busy: new Set([F]) }), null);
});

test('用户取消自动合并后不再自动合并，只改名不算改合并', () => {
  const store = new Store(':memory:');
  store.seenDevice({ mac: A, routerName: 'phone', isRandomMac: true, now: 1000 });
  store.seenDevice({ mac: B, routerName: 'phone', isRandomMac: true, now: 2000 });
  assert.equal(store.autoMerge(B), A);
  store.updateDevice(B, { customName: '手机', canonicalMac: A });
  assert.equal(store.getDevice(B).mergeSource, 'auto');
  store.updateDevice(B, { canonicalMac: null });
  assert.equal(store.getDevice(B).mergeSource, 'manual');
  assert.equal(store.autoMerge(B), null);
  // 被拆出来的设备也不作为别人的目标
  const C = 'AA:BB:CC:00:00:03';
  store.seenDevice({ mac: C, routerName: 'phone', isRandomMac: true, now: 3000 });
  assert.equal(store.autoMerge(C), A);
});
