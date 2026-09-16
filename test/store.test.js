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
    down: 100, up: 20, onlineSec: 3600, connType: '5g', push: false,
  });
  assert.equal(connTypeOf({ type: { type: 'wired' } }), 'wired');
  assert.equal(connTypeOf({ type: { type: 'wifi', wifiIndex: 1 } }), '2.4g');
  assert.equal(normalizeDevice({ mac: 'x', online: 0 }).online, false);
});
