import { normalizeMac } from '../router/client.js';

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function fail(res, status, code, message) {
  json(res, status, { error: { code, message } });
}

async function readJson(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function todayStart(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function isoLocal(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 处理 /api/* 请求。返回 true 表示已处理。
 * @param {{store: import('../store/db.js').Store, engine: import('../state/engine.js').StateEngine, config: object, startedAt: number}} ctx
 */
export async function handleApi(req, res, url, ctx) {
  const { store, engine } = ctx;
  const { pathname, searchParams: qs } = url;
  const m = req.method;

  try {
    if (m === 'GET' && pathname === '/api/state') {
      return json(res, 200, engine.snapshot()), true;
    }

    if (m === 'GET' && pathname === '/api/devices') {
      return json(res, 200, store.listDevices({ q: qs.get('q') ?? '', onlineOnly: qs.get('online') === '1' })), true;
    }

    const devMatch = pathname.match(/^\/api\/devices\/([^/]+)$/);
    if (devMatch) {
      const mac = normalizeMac(decodeURIComponent(devMatch[1]));
      if (m === 'GET') {
        const d = store.getDevice(mac);
        return d ? json(res, 200, d) : fail(res, 404, 'not_found', '设备不存在'), true;
      }
      if (m === 'PATCH') {
        const body = await readJson(req);
        const patch = {};
        if ('customName' in body) patch.customName = body.customName;
        if ('notify' in body) patch.notify = !!body.notify;
        if ('canonicalMac' in body) patch.canonicalMac = body.canonicalMac ? normalizeMac(body.canonicalMac) : null;
        let updated;
        try {
          updated = store.updateDevice(mac, patch);
        } catch (e) {
          return fail(res, 400, 'bad_request', e.message), true;
        }
        if (!updated) return fail(res, 404, 'not_found', '设备不存在'), true;
        // 自己 + 合并到自己的设备，展示名都可能变
        engine.refreshProfile(mac);
        for (const t of engine.tracked.values()) {
          if (t.profile.canonicalMac === mac && t.mac !== mac) engine.refreshProfile(t.mac);
        }
        return json(res, 200, updated), true;
      }
    }

    if (m === 'GET' && pathname === '/api/events') {
      return json(res, 200, store.listEvents({
        limit: qs.get('limit') ?? 50,
        before: qs.get('before') || undefined,
        type: qs.get('type') || undefined,
        mac: qs.get('mac') ? normalizeMac(qs.get('mac')) : undefined,
      })), true;
    }

    if (m === 'GET' && pathname === '/api/sessions') {
      return json(res, 200, store.listSessions({
        mac: qs.get('mac') ? normalizeMac(qs.get('mac')) : undefined,
        from: Number(qs.get('from')) || undefined,
        to: Number(qs.get('to')) || undefined,
        limit: Number(qs.get('limit')) || 200,
      })), true;
    }

    if (m === 'GET' && pathname === '/api/stats/today') {
      return json(res, 200, { ...store.statsToday(todayStart()), online: engine.tracked.size }), true;
    }

    if (m === 'GET' && pathname === '/api/export') {
      const rows = store.exportSessions({ from: Number(qs.get('from')) || undefined, to: Number(qs.get('to')) || undefined });
      const header = ['id', 'mac', 'name', 'ip', 'started_at', 'ended_at', 'duration_seconds', 'start_source', 'end_source'];
      const lines = [header.join(',')];
      for (const r of rows) {
        lines.push([
          r.id, r.mac, r.name, r.ip, isoLocal(r.started_at), isoLocal(r.ended_at),
          r.duration_ms == null ? '' : Math.round(r.duration_ms / 1000), r.start_source, r.end_source,
        ].map(csvCell).join(','));
      }
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="sessions-${isoLocal(Date.now()).slice(0, 10)}.csv"`,
      });
      res.end('﻿' + lines.join('\r\n'));
      return true;
    }

    if (m === 'GET' && pathname === '/api/health') {
      const r = engine.routerState();
      const ok = r.reachable && r.lastPollAt && Date.now() - r.lastPollAt < 60_000;
      return json(res, ok ? 200 : 503, {
        ok, uptimeMs: Date.now() - ctx.startedAt, router: r, online: engine.tracked.size,
      }), true;
    }

    if (m === 'GET' && pathname === '/api/debug/raw') {
      return json(res, 200, ctx.client?.lastRaw ?? null), true;
    }

    if (pathname.startsWith('/api/')) {
      return fail(res, 404, 'not_found', `未知接口 ${m} ${pathname}`), true;
    }
    return false;
  } catch (e) {
    fail(res, 500, 'internal', e.message);
    return true;
  }
}
