import { test } from 'node:test';
import assert from 'node:assert/strict';
import { friendlyName, miotModelOf, setNameOverrides } from '../src/router/names.js';

test('miot 主机名解析与字典翻译', () => {
  assert.equal(miotModelOf('yeelink-light-lamp22_mibt89F6'), 'yeelink.light.lamp22');
  assert.equal(friendlyName('yeelink-light-lamp22_mibt89F6'), '米家智能显示器挂灯1S');
  assert.equal(friendlyName('yeelink-light-lamp27_mibt1B83'), '米家台灯1S 增强版');
  assert.equal(friendlyName('MiAiSoundbox-L05C'), '小米小爱音箱Play 增强版');
  assert.equal(friendlyName('MiWiFi-RD03'), '小米路由器 RD03');
  assert.equal(friendlyName('Havad'), null);
  assert.equal(friendlyName('unknown-vendor-x1_miio12345'), null);
});

test('config.names 覆盖内置字典', () => {
  setNameOverrides({ 'yeelink.light.lamp22': '书房挂灯', 'Havad': '我的笔记本' });
  assert.equal(friendlyName('yeelink-light-lamp22_mibt89F6'), '书房挂灯');
  assert.equal(friendlyName('havad'), '我的笔记本');
  setNameOverrides({});
  assert.equal(friendlyName('Havad'), null);
});
