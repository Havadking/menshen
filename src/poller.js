import { createLogger } from './logger.js';

const log = createLogger('poller');

/**
 * 串行轮询：上一轮结束后再计时，避免路由器慢时请求堆叠。
 */
export class Poller {
  /**
   * @param {import('./router/client.js').RouterClient} client
   * @param {import('./state/engine.js').StateEngine} engine
   * @param {{intervalMs?:number}} opts
   */
  constructor(client, engine, opts = {}) {
    this.client = client;
    this.engine = engine;
    this.intervalMs = opts.intervalMs ?? 3000;
    this.timer = null;
    this.running = false;
    this.inFlight = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    log.info(`开始轮询，间隔 ${this.intervalMs}ms`);
    this._tick();
  }

  async stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.inFlight) await this.inFlight.catch(() => {});
  }

  /** 立即执行一轮（可 await），供测试与手动触发 */
  async pollOnce() {
    let result;
    try {
      const snap = await this.client.snapshot();
      result = { ok: true, devices: snap.devices, wan: snap.wan };
    } catch (error) {
      log.debug(`轮询失败: ${error.message}`);
      result = { ok: false, error };
    }
    this.engine.handlePoll(result);
    return result;
  }

  async _tick() {
    if (!this.running) return;
    this.inFlight = this.pollOnce();
    try {
      await this.inFlight;
    } catch (e) {
      log.error('轮询处理异常', e);
    } finally {
      this.inFlight = null;
      if (this.running) this.timer = setTimeout(() => this._tick(), this.intervalMs);
    }
  }
}
