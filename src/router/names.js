// 路由器只给主机名（yeelink-light-lamp22_mibt89F6 / MiAiSoundbox-L05C），
// 米家 App 里的产品名来自小米云端，这里用一张可扩展的字典把常见型号翻成中文。
// 用户可在 config.json 的 "names" 里追加：键为 miot 型号（yeelink.light.lamp22）或主机名。

const MODEL_NAMES = {
  'yeelink.light.lamp22': '米家智能显示器挂灯1S',
  'yeelink.light.lamp15': '米家显示器挂灯',
  'yeelink.light.lamp27': '米家台灯1S 增强版',
  'yeelink.light.lamp4': '米家台灯1S',
  'yeelink.light.lamp1': '米家台灯',
  'yeelink.light.ceiling1': 'Yeelight 吸顶灯',
  'yeelink.light.color1': 'Yeelight 彩光灯泡',
  'xiaomi.wifispeaker.l05c': '小米小爱音箱Play 增强版',
  'xiaomi.wifispeaker.l05b': '小爱音箱Play',
  'xiaomi.wifispeaker.l06a': '小爱音箱',
  'xiaomi.wifispeaker.lx06': '小爱音箱Pro',
  'xiaomi.wifispeaker.l09a': '小爱音箱Play',
  'xiaomi.wifispeaker.x08a': '小米AI音箱',
  'zhimi.airpurifier.mb3': '米家空气净化器 3',
  'zhimi.airpurifier.mb4': '米家空气净化器 3C',
  'zhimi.airpurifier.va1': '米家空气净化器 Pro H',
  'zhimi.humidifier.ca4': '智米加湿器',
  'chuangmi.plug.m1': '米家智能插座',
  'chuangmi.camera.ipc019': '小米摄像头',
  'isa.camera.hlc6': '小米智能摄像机 云台版',
  'roborock.vacuum.s5': '石头扫地机器人',
  'dreame.vacuum.p2008': '追觅扫地机器人',
  'lumi.gateway.mgl03': '米家多模网关',
  'lumi.gateway.mcn001': '米家多模网关 2',
  'xiaomi.aircondition.mc1': '米家空调',
  'viomi.fridge.x4': '云米冰箱',
};

const HOST_PATTERNS = [
  [/^MiAiSoundbox-L05C$/i, '小米小爱音箱Play 增强版'],
  [/^MiAiSoundbox-L05B$/i, '小爱音箱Play'],
  [/^MiAiSoundbox-LX06$/i, '小爱音箱Pro'],
  [/^MiAiSoundbox-L06A$/i, '小爱音箱'],
  [/^MiAiSoundbox-(\w+)$/i, (m) => `小爱音箱 ${m[1]}`],
  [/^MiWiFi-(\w+)$/i, (m) => `小米路由器 ${m[1]}`],
  [/^Redmi-Router-(\w+)$/i, (m) => `Redmi 路由器 ${m[1]}`],
  [/^MiTV-(\w+)$/i, (m) => `小米电视 ${m[1]}`],
  [/^xiaomi-(\w+)-(\w+)$/i, (m) => `小米 ${m[1]}`],
];

let overrides = {};

/** 载入 config.json 的 names 段：{ "yeelink.light.lamp22": "...", "MiAiSoundbox-L05C": "..." } */
export function setNameOverrides(map) {
  overrides = {};
  for (const [k, v] of Object.entries(map ?? {})) if (v) overrides[k.toLowerCase()] = String(v);
}

/** 从 miot 主机名解析型号：yeelink-light-lamp22_mibt89F6 → yeelink.light.lamp22 */
export function miotModelOf(hostname) {
  const m = String(hostname ?? '').match(/^([a-z0-9]+)-([a-z0-9]+)-([a-z0-9]+)(?:-([a-z0-9]+))?_mi[a-z]*[0-9a-f]+$/i);
  if (!m) return null;
  return [m[1], m[2], m[3], m[4]].filter(Boolean).join('.').toLowerCase();
}

/** 主机名 → 友好名；无法识别返回 null（调用方回退到主机名） */
export function friendlyName(hostname) {
  const h = String(hostname ?? '').trim();
  if (!h) return null;
  if (overrides[h.toLowerCase()]) return overrides[h.toLowerCase()];
  const model = miotModelOf(h);
  if (model) {
    if (overrides[model]) return overrides[model];
    if (MODEL_NAMES[model]) return MODEL_NAMES[model];
    // 去掉尾部序列号，至少比原主机名可读
    return null;
  }
  for (const [re, name] of HOST_PATTERNS) {
    const m = h.match(re);
    if (m) return typeof name === 'function' ? name(m) : name;
  }
  return null;
}
