import { createHash } from 'node:crypto';
import { createLogger } from '../logger.js';

const log = createLogger('router');

// 小米路由器固件内置的密码混淆常量，所有 MiWiFi 固件相同
const KEY = 'a2ffa5c9be07488bbb04a3a47d3c5f6a';

export class RouterError extends Error {
  constructor(message, { code, status, retryable = true } = {}) {
    super(message);
    this.name = 'RouterError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function hash(algo, s) {
  return createHash(algo).update(s, 'utf8').digest('hex');
}

/** 按固件加密模式计算登录密码哈希（导出以便单测） */
export function hashPassword(password, nonce, newEncryptMode) {
  const algo = Number(newEncryptMode) === 1 ? 'sha256' : 'sha1';
  return hash(algo, nonce + hash(algo, password + KEY));
}

export function makeNonce(deviceId, now = Date.now(), rand = Math.random()) {
  return `0_${deviceId}_${Math.floor(now / 1000)}_${Math.floor(rand * 10000)}`;
}

/** 大写、冒号分隔 */
export function normalizeMac(mac) {
  return String(mac ?? '').trim().toUpperCase().replace(/-/g, ':');
}

/** 本地管理位：第二个十六进制位为 2/6/A/E 即随机（私有）MAC */
export function isRandomMac(mac) {
  const c = normalizeMac(mac)[1];
  return c === '2' || c === '6' || c === 'A' || c === 'E';
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 将路由器的 type / wifiIndex 归一为 'wired' | '2.4g' | '5g' | null */
export function connTypeOf(item) {
  const t = item?.type;
  const typeName = typeof t === 'object' && t ? String(t.type ?? '') : String(t ?? '');
  const wifiIndex = num(typeof t === 'object' && t ? t.wifiIndex : item?.wifiIndex, 0);
  if (/wire|lan|cable|eth/i.test(typeName)) return 'wired';
  if (wifiIndex === 1) return '2.4g';
  if (wifiIndex === 2) return '5g';
  if (/wifi|wl/i.test(typeName)) return 'wifi';
  return null;
}

/** devicelist.list[] → 内部快照结构 */
export function normalizeDevice(item) {
  const ip0 = Array.isArray(item.ip) && item.ip.length ? item.ip[0] : null;
  const stats = item.statistics ?? {};
  return {
    mac: normalizeMac(item.mac),
    name: String(item.name || item.oname || '').trim() || null,
    ip: ip0?.ip ? String(ip0.ip) : null,
    online: String(item.online) === '1',
    down: num(ip0?.downspeed ?? stats.downspeed),
    up: num(ip0?.upspeed ?? stats.upspeed),
    onlineSec: num(stats.online),
    connType: connTypeOf(item),
    push: item.push === undefined ? null : String(item.push) === '1',
  };
}

export class RouterClient {
  /**
   * @param {{host:string, username:string, password:string, timeoutMs?:number}} opts
   * @param {{fetch?: typeof fetch}} deps
   */
  constructor(opts, deps = {}) {
    this.host = opts.host;
    this.username = opts.username ?? 'admin';
    this.password = opts.password;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.fetch = deps.fetch ?? globalThis.fetch;
    this.stok = null;
    this.loginPromise = null;
    this.loginFailures = 0;
    this.nextLoginAt = 0;
    /** 最近一次原始响应，供 /api/debug/raw 核对字段 */
    this.lastRaw = { devicelist: null, status: null, at: null };
  }

  get base() {
    return `http://${this.host}/cgi-bin/luci`;
  }

  async _request(url, init = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      return await this.fetch(url, { ...init, signal: ctl.signal });
    } catch (e) {
      const msg = e.name === 'AbortError' ? `请求超时 (${this.timeoutMs}ms)` : e.message;
      throw new RouterError(`${msg}: ${url}`, { code: 'network' });
    } finally {
      clearTimeout(timer);
    }
  }

  /** 拉取登录页，取 deviceId 与 newEncryptMode */
  async fetchLoginPage() {
    const res = await this._request(`${this.base}/web`);
    const html = await res.text();
    const deviceId = html.match(/deviceId\s*=\s*['"]([^'"]+)['"]/)?.[1];
    const newEncryptMode = num(html.match(/newEncryptMode\s*=\s*(\d)/)?.[1], 0);
    if (!deviceId) {
      throw new RouterError('登录页中未找到 deviceId，固件可能不受支持', { code: 'unsupported', retryable: false });
    }
    return { deviceId, newEncryptMode };
  }

  /** 登录并缓存 stok。并发调用合并为一次。 */
  login() {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this._login().finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  async _login() {
    const now = Date.now();
    if (now < this.nextLoginAt) {
      throw new RouterError(`登录退避中，${Math.ceil((this.nextLoginAt - now) / 1000)}s 后重试`, { code: 'backoff' });
    }
    try {
      const { deviceId, newEncryptMode } = await this.fetchLoginPage();
      const nonce = makeNonce(deviceId);
      const body = new URLSearchParams({
        username: this.username,
        password: hashPassword(this.password, nonce, newEncryptMode),
        logtype: '2',
        nonce,
      });
      const res = await this._request(`${this.base}/api/xqsystem/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const data = await res.json().catch(() => ({}));
      if (data.code !== 0 || !data.token) {
        const wrongPwd = data.code === 401;
        throw new RouterError(`登录失败: code=${data.code} ${data.msg ?? ''}`.trim(), {
          code: wrongPwd ? 'auth' : 'login',
          retryable: !wrongPwd,
        });
      }
      this.stok = data.token;
      this.loginFailures = 0;
      this.nextLoginAt = 0;
      log.info('登录成功');
      return this.stok;
    } catch (e) {
      this.loginFailures += 1;
      // 1s → 2s → 4s … 封顶 60s；连续 5 次后每 5 分钟一次（避免触发路由器锁定）
      const backoff = this.loginFailures >= 5 ? 5 * 60_000 : Math.min(60_000, 1000 * 2 ** (this.loginFailures - 1));
      this.nextLoginAt = Date.now() + backoff;
      log.warn(`登录失败（第 ${this.loginFailures} 次），${backoff / 1000}s 后重试: ${e.message}`);
      throw e;
    }
  }

  /** 带 stok 的 GET；token 失效自动重登录并重试一次 */
  async api(path, { retry = true } = {}) {
    if (!this.stok) await this.login();
    const url = `${this.base}/;stok=${this.stok}/api/${path}`;
    const res = await this._request(url);
    let data;
    try {
      data = await res.json();
    } catch {
      throw new RouterError(`响应不是 JSON (HTTP ${res.status}): ${path}`, { code: 'bad_response' });
    }
    if (data.code === 401 || /invalid token/i.test(String(data.msg ?? ''))) {
      this.stok = null;
      if (!retry) throw new RouterError('token 失效且重登录后仍失败', { code: 'auth' });
      log.info('token 失效，重新登录');
      await this.login();
      return this.api(path, { retry: false });
    }
    if (data.code !== 0) {
      throw new RouterError(`接口返回错误 code=${data.code} ${data.msg ?? ''}: ${path}`, { code: 'api', status: data.code });
    }
    return data;
  }

  async deviceList() {
    const data = await this.api('misystem/devicelist');
    this.lastRaw.devicelist = data;
    this.lastRaw.at = Date.now();
    const list = Array.isArray(data.list) ? data.list : [];
    return { devices: list.map(normalizeDevice), raw: data };
  }

  async status() {
    const data = await this.api('misystem/status');
    this.lastRaw.status = data;
    const wan = data.wan ?? {};
    return {
      wan: { down: num(wan.downspeed), up: num(wan.upspeed) },
      raw: data,
    };
  }

  /** 一轮轮询需要的全部数据 */
  async snapshot() {
    const [dl, st] = await Promise.all([this.deviceList(), this.status()]);
    return { devices: dl.devices, wan: st.wan };
  }
}
