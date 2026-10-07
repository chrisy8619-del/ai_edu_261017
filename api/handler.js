// Live backend for the keynote (word cloud, poll, quiz, slide follow).
// Storage: Upstash Redis REST (env set automatically when Upstash is connected in Vercel).
// Find the Upstash REST credentials whatever prefix Vercel gave them (KV_, STORAGE_, UPSTASH_REDIS_ ...)
function findEnv(suffixes) {
  for (const sfx of suffixes) {
    for (const k of Object.keys(process.env)) {
      if (k.endsWith(sfx) && !/READ_ONLY/.test(k) && process.env[k]) return process.env[k];
    }
  }
  return '';
}
const R_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || findEnv(['_REST_API_URL', '_REDIS_REST_URL']);
const R_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || findEnv(['_REST_API_TOKEN', '_REDIS_REST_TOKEN']);
const ADMIN = process.env.ADMIN_KEY || '';
const crypto = require('crypto');
let KEY_HASH = ''; try { KEY_HASH = require('./_key.js'); } catch (e) { }   // written by deploy.ps1 (sha256 of presenter key)
const sha = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex');

async function redis(cmds) {
  const r = await fetch(R_URL.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + R_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  const j = await r.json();
  return j.map((x) => (x && 'result' in x ? x.result : null));
}
const pairs = (arr) => { const o = {}; for (let i = 0; arr && i < arr.length; i += 2) o[arr[i]] = arr[i + 1]; return o; };
let stageCache = { v: '', t: 0 };

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const send = (o, code = 200) => res.status(code).json(o);
  const p = String((req.query && req.query.p) || '').replace(/^\/+/, '');
  const path = '/api/' + p;
  const method = req.method;
  const given = req.headers['x-admin-key'] || '';
  const admin = !!given && (KEY_HASH ? sha(given) === KEY_HASH : (!!ADMIN && given === ADMIN));
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const origin = proto + '://' + req.headers.host;
  const storage = !!(R_URL && R_TOKEN);

  try {
    if (path === '/api/wifi') return send({ ssid: '', pass: '', auth: 'cloud' });
    if (!storage) {
      if (path === '/api/info') return send({ q: '', vote: '', lan: false, cloud: true, storage: false, admin, adminSet: !!(KEY_HASH || ADMIN) });
      return send({ error: 'storage not connected' }, 503);
    }
    const needAdmin = () => { if (!admin) { send({ error: 'presenter only' }, 403); return true; } return false; };

    // ---- slide follow
    if (path === '/api/stage' && method === 'GET') {
      if (Date.now() - stageCache.t > 1000) { const [v] = await redis([['GET', 'kn:stage']]); stageCache = { v: v || '', t: Date.now() }; }
      return send({ stage: stageCache.v });
    }
    if (path === '/api/stage' && method === 'POST') {
      if (needAdmin()) return;
      const s = String(body.stage || '').slice(0, 40);
      await redis([['SET', 'kn:stage', s]]); stageCache = { v: s, t: Date.now() };
      return send({ ok: true });
    }

    // ---- icebreaker word cloud
    if (path === '/api/info') {
      const [q] = await redis([['GET', 'kn:ice:q']]);
      return send({ q: q || '', vote: origin + '/live', lan: true, cloud: true, storage: true, admin, adminSet: !!(KEY_HASH || ADMIN) });
    }
    if (path === '/api/words' && method === 'GET') {
      const [q, cnt, lab, total] = await redis([['GET', 'kn:ice:q'], ['HGETALL', 'kn:ice:count'], ['HGETALL', 'kn:ice:label'], ['GET', 'kn:ice:total']]);
      const c = pairs(cnt), l = pairs(lab);
      return send({ q: q || '', total: +total || 0, words: Object.keys(c).map((k) => ({ w: l[k] || k, c: +c[k] })) });
    }
    if (path === '/api/words' && method === 'POST') {
      const w = String(body.w || '').trim().replace(/\s+/g, ' ');
      if (w.length < 1 || [...w].length > 20) return send({ error: 'bad' }, 400);
      const k = w.toLowerCase().replace(/\s/g, '');
      await redis([['HINCRBY', 'kn:ice:count', k, 1], ['HSETNX', 'kn:ice:label', k, w], ['INCR', 'kn:ice:total']]);
      return send({ ok: true });
    }
    if (path === '/api/config' && method === 'POST') {
      if (needAdmin()) return;
      if (body.q) await redis([['SET', 'kn:ice:q', String(body.q).slice(0, 120)]]);
      return send({ ok: true });
    }
    if (path === '/api/reset' && method === 'POST') {
      if (needAdmin()) return;
      await redis([['DEL', 'kn:ice:count', 'kn:ice:label', 'kn:ice:total']]);
      return send({ ok: true });
    }

    // ---- poll / quiz  (?id=poll | quiz)
    if (path.startsWith('/api/poll')) {
      const id = /^[a-z0-9]{1,16}$/.test(String(req.query.id || '')) ? String(req.query.id) : 'poll';
      const K = 'kn:poll:' + id;
      if (path === '/api/poll' && method === 'GET') {
        const [cfgS, votes, rev] = await redis([['GET', K + ':cfg'], ['HGETALL', K + ':votes'], ['GET', K + ':reveal']]);
        const cfg = cfgS ? JSON.parse(cfgS) : { q: '', options: [], answer: -1 };
        const v = pairs(votes); const n = cfg.options.length; const counts = new Array(n).fill(0);
        Object.values(v).forEach((x) => { x = +x; if (x >= 0 && x < n) counts[x]++; });
        const reveal = rev === '1';
        return send({ q: cfg.q, options: cfg.options, counts, total: Object.keys(v).length, answer: reveal ? cfg.answer : -1, reveal });
      }
      if (path === '/api/poll' && method === 'POST') {
        const dev = String(body.id || ''); const i = Number.isInteger(body.i) ? body.i : parseInt(body.i, 10);
        const [cfgS, rev] = await redis([['GET', K + ':cfg'], ['GET', K + ':reveal']]);
        const cfg = cfgS ? JSON.parse(cfgS) : { options: [] };
        if (rev === '1' || dev.length < 4 || dev.length > 64 || !(i >= 0 && i < cfg.options.length)) return send({ error: 'bad' }, 400);
        await redis([['HSET', K + ':votes', dev, String(i)]]);
        return send({ ok: true });
      }
      if (path === '/api/poll/config' && method === 'POST') {
        if (needAdmin()) return;
        const opts = (Array.isArray(body.options) ? body.options : []).map((s) => String(s).slice(0, 80)).slice(0, 8);
        const [cfgS] = await redis([['GET', K + ':cfg']]);
        const old = cfgS ? JSON.parse(cfgS) : { options: [] };
        const cfg = { q: String(body.q || old.q || '').slice(0, 120), options: opts, answer: Number.isInteger(body.answer) ? body.answer : (old.answer ?? -1) };
        const cmds = [['SET', K + ':cfg', JSON.stringify(cfg)]];
        if (opts.join('|') !== (old.options || []).join('|')) cmds.push(['DEL', K + ':votes', K + ':reveal']);
        await redis(cmds);
        return send({ ok: true });
      }
      if (path === '/api/poll/reveal' && method === 'POST') {
        if (needAdmin()) return;
        await redis([['SET', K + ':reveal', body.show ? '1' : '0']]);
        return send({ ok: true });
      }
      if (path === '/api/poll/reset' && method === 'POST') {
        if (needAdmin()) return;
        await redis([['DEL', K + ':votes', K + ':reveal']]);
        return send({ ok: true });
      }
    }
    return send({ error: 'not found' }, 404);
  } catch (e) {
    return send({ error: 'server', detail: String(e.message || e) }, 500);
  }
};
