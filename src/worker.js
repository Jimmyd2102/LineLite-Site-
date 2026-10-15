// Line Lite site Worker
// - Serves the static site from /public (Cloudflare static assets)
// - POST /api/apply  -> saves a job application to D1
// - POST /api/bid    -> saves a client bid request to D1
// - GET  /admin      -> password-protected list of submissions (+ CSV export)
// - Optional: emails a notification for each submission if RESEND_API_KEY is set

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    location TEXT,
    position TEXT,
    experience_years TEXT,
    drivers_license TEXT,
    start_date TEXT,
    experience TEXT,
    notes TEXT,
    willing_to_travel INTEGER NOT NULL DEFAULT 0,
    work_authorized INTEGER NOT NULL DEFAULT 0,
    consent INTEGER NOT NULL DEFAULT 0,
    ip TEXT,
    user_agent TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS bid_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    company TEXT NOT NULL,
    company_type TEXT,
    contact_name TEXT NOT NULL,
    title TEXT,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    work_types TEXT,
    project_location TEXT,
    scope_size TEXT,
    start_timing TEXT,
    duration TEXT,
    prints_ready TEXT,
    crews_needed TEXT,
    details TEXT,
    referral TEXT,
    consent INTEGER NOT NULL DEFAULT 0,
    ip TEXT,
    user_agent TEXT
  )`,
];

const FORMS = {
  apply: {
    table: 'applications',
    label: 'Job application',
    required: ['full_name', 'email', 'phone', 'location', 'position'],
    mustBeTrue: { work_authorized: 'Please confirm you are authorized to work in the U.S.', consent: 'Please check the consent box.' },
    text: ['full_name', 'email', 'phone', 'location', 'position', 'experience_years', 'drivers_license', 'start_date', 'experience', 'notes'],
    bool: ['willing_to_travel', 'work_authorized', 'consent'],
    list: [],
    title: (d) => `New application: ${d.full_name} (${d.position || 'position n/a'})`,
  },
  bid: {
    table: 'bid_requests',
    label: 'Bid request',
    required: ['company', 'contact_name', 'email', 'phone', 'project_location', 'details'],
    mustBeTrue: { consent: 'Please check the consent box.' },
    text: ['company', 'company_type', 'contact_name', 'title', 'email', 'phone', 'project_location', 'scope_size', 'start_timing', 'duration', 'prints_ready', 'crews_needed', 'details', 'referral'],
    bool: ['consent'],
    list: ['work_types'],
    title: (d) => `New bid request: ${d.company} (${d.project_location || 'location n/a'})`,
  },
};

const FIELD_NAMES = {
  full_name: 'name', contact_name: 'name', email: 'email', phone: 'phone', location: 'city & state',
  position: 'position', company: 'company name', project_location: 'project location', details: 'project details',
};

let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql))).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

function clean(value, max = 6000) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\u0000/g, '').trim().slice(0, max);
}

async function handleSubmit(kind, request, env, ctx) {
  const cfg = FORMS[kind];

  // Only accept posts from our own pages
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return json({ ok: false, error: 'Bad origin' }, 403);
  }

  let data;
  try {
    data = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid form data' }, 400);
  }
  if (!data || typeof data !== 'object') return json({ ok: false, error: 'Invalid form data' }, 400);

  // Bots: filled the hidden field, or submitted faster than a human could
  if (clean(data.website) || (typeof data._elapsed_ms === 'number' && data._elapsed_ms < 2500)) {
    return json({ ok: true });
  }

  const row = {};
  for (const f of cfg.text) row[f] = clean(data[f]);
  for (const f of cfg.bool) row[f] = data[f] === true || data[f] === 'on' || data[f] === 'true' ? 1 : 0;
  for (const f of cfg.list) {
    const arr = Array.isArray(data[f]) ? data[f] : data[f] ? [data[f]] : [];
    row[f] = arr.map((v) => clean(v, 100)).filter(Boolean).join(', ');
  }

  for (const f of cfg.required) {
    if (!row[f]) return json({ ok: false, error: `Please fill in your ${FIELD_NAMES[f] || f}` }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) {
    return json({ ok: false, error: 'Please enter a valid email address' }, 400);
  }
  for (const [f, msg] of Object.entries(cfg.mustBeTrue)) {
    if (!row[f]) return json({ ok: false, error: msg }, 400);
  }
  if (kind === 'bid' && !row.work_types) {
    return json({ ok: false, error: 'Please pick at least one type of work' }, 400);
  }

  row.ip = request.headers.get('cf-connecting-ip') || '';
  row.user_agent = clean(request.headers.get('user-agent'), 300);

  try {
    await ensureSchema(env);
    const cols = Object.keys(row);
    const sql = `INSERT INTO ${cfg.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    const result = await env.DB.prepare(sql).bind(...cols.map((c) => row[c])).run();
    row.id = result.meta && result.meta.last_row_id;
  } catch (err) {
    console.error('D1 insert failed', err);
    return json({ ok: false, error: 'Server error' }, 500);
  }

  if (env.RESEND_API_KEY && env.NOTIFY_TO) {
    ctx.waitUntil(sendNotification(env, cfg, row, request).catch((err) => console.error('Email failed', err)));
  }

  return json({ ok: true });
}

// ── Email notification (optional, via Resend) ──
async function sendNotification(env, cfg, row, request) {
  const skip = new Set(['ip', 'user_agent', 'id']);
  const lines = Object.entries(row)
    .filter(([k]) => !skip.has(k))
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666;vertical-align:top;white-space:nowrap">${esc(labelize(k))}</td><td style="padding:4px 0">${esc(v === 1 ? 'Yes' : v === 0 ? 'No' : v).replace(/\n/g, '<br>')}</td></tr>`)
    .join('');
  const adminUrl = new URL('/admin', request.url).toString();
  const html = `<h2 style="font-family:sans-serif">${esc(cfg.label)}</h2><table style="font-family:sans-serif;font-size:14px">${lines}</table><p style="font-family:sans-serif"><a href="${adminUrl}">View all submissions</a></p>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.NOTIFY_FROM || 'Line Lite Website <onboarding@resend.dev>',
      to: env.NOTIFY_TO.split(',').map((s) => s.trim()),
      reply_to: row.email,
      subject: cfg.title(row),
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

// ── Admin ──
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const BOOL_FIELDS = new Set(['willing_to_travel', 'work_authorized', 'consent']);
function fmtTime(t) {
  if (!t) return '';
  const d = new Date(String(t).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return t;
  return d.toLocaleString('en-US', { timeZone: 'America/Indianapolis', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET';
}
function fmtVal(k, v) {
  if (BOOL_FIELDS.has(k)) return v ? 'Yes' : 'No';
  if (k === 'created_at') return fmtTime(v);
  return v;
}
function labelize(k) {
  return k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function checkAuth(request, env) {
  if (!env.ADMIN_PASSWORD) return 'disabled';
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded = '';
  try { decoded = atob(header.slice(6)); } catch { return false; }
  const pass = decoded.slice(decoded.indexOf(':') + 1);
  return timingSafeEqual(pass, env.ADMIN_PASSWORD);
}

async function handleAdmin(request, env, url) {
  const auth = checkAuth(request, env);
  if (auth === 'disabled') {
    return new Response('Admin is turned off. Add an ADMIN_PASSWORD secret to this Worker in Cloudflare to turn it on.', { status: 503 });
  }
  if (!auth) {
    return new Response('Login required', {
      status: 401,
      headers: { 'www-authenticate': 'Basic realm="Line Lite admin", charset="UTF-8"' },
    });
  }

  await ensureSchema(env);

  if (url.pathname === '/admin/export') {
    const kind = url.searchParams.get('type') === 'bid' ? 'bid' : 'apply';
    const { results } = await env.DB.prepare(`SELECT * FROM ${FORMS[kind].table} ORDER BY id DESC`).all();
    const cols = results.length ? Object.keys(results[0]) : [];
    const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.join(','), ...results.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="linelite-${kind === 'bid' ? 'bid-requests' : 'applications'}.csv"`,
        'cache-control': 'no-store',
      },
    });
  }

  const tab = url.searchParams.get('tab') === 'bid' ? 'bid' : 'apply';
  const [apps, bids] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM applications').first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM bid_requests').first(),
  ]);
  const { results } = await env.DB.prepare(`SELECT * FROM ${FORMS[tab].table} ORDER BY id DESC LIMIT 500`).all();

  const summary = tab === 'apply'
    ? (r) => [r.full_name, r.position, r.location, r.phone, r.email]
    : (r) => [r.company, r.contact_name, r.project_location, r.work_types, r.phone, r.email];
  const heads = tab === 'apply'
    ? ['Name', 'Position', 'Location', 'Phone', 'Email']
    : ['Company', 'Contact', 'Location', 'Work', 'Phone', 'Email'];

  const rows = results.map((r) => {
    const detail = Object.entries(r)
      .filter(([k]) => !['id'].includes(k))
      .map(([k, v]) => `<div class="kv"><span>${esc(labelize(k))}</span><p>${esc(fmtVal(k, v))}</p></div>`)
      .join('');
    return `<details><summary><span class="date">${esc(fmtTime(r.created_at))}</span>${summary(r)
      .map((v) => `<span>${esc(v)}</span>`)
      .join('')}</summary><div class="detail">${detail}</div></details>`;
  }).join('');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Submissions | Line Lite</title><link rel="icon" href="/favicon.ico"><meta name="robots" content="noindex">
<style>
:root{--pink:#e8006f;--cyan:#00b4d8;--dark:#12131a;--dark2:#1a1b25;--line:rgba(255,255,255,.09)}
*{box-sizing:border-box}body{margin:0;background:var(--dark);color:#fff;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
header{display:flex;align-items:center;gap:12px;padding:16px;border-bottom:3px solid var(--pink)}
header img{width:36px;height:36px}header b{font-size:18px;letter-spacing:.5px;text-transform:uppercase}
main{max-width:1200px;margin:0 auto;padding:20px 16px 60px}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;align-items:center}
.tabs a{color:#fff;text-decoration:none;padding:8px 14px;border:1px solid var(--line);border-radius:3px}
.tabs a.on{background:var(--pink);border-color:var(--pink)}.tabs .csv{margin-left:auto;color:var(--cyan);border-color:rgba(0,180,216,.4)}
.head,summary{display:grid;grid-template-columns:175px repeat(${heads.length},minmax(0,1fr));gap:12px;padding:10px 12px}
.head{color:#9a9aaa;font-size:12px;text-transform:uppercase;letter-spacing:1px}
details{border-top:1px solid var(--line)}summary{cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}
summary:hover{background:var(--dark2)}summary span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.date{color:#9a9aaa}
.detail{background:var(--dark2);padding:12px 16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px 24px}
.kv span{color:#9a9aaa;font-size:12px;text-transform:uppercase;letter-spacing:1px}.kv p{margin:2px 0 0;white-space:pre-wrap;word-break:break-word}
.empty{color:#9a9aaa;padding:30px 12px}
@media(max-width:800px){.head{display:none}summary{grid-template-columns:1fr}summary span:nth-child(n+5){display:none}}
</style></head><body>
<header><img src="/img/logo.png" alt=""><b>Line Lite · Submissions</b></header>
<main>
<div class="tabs">
<a href="/admin?tab=apply" class="${tab === 'apply' ? 'on' : ''}">Job applications (${apps.n})</a>
<a href="/admin?tab=bid" class="${tab === 'bid' ? 'on' : ''}">Bid requests (${bids.n})</a>
<a class="csv" href="/admin/export?type=${tab}">Download CSV</a>
</div>
<div class="head"><span>Received</span>${heads.map((h) => `<span>${h}</span>`).join('')}</div>
${rows || '<div class="empty">Nothing here yet.</div>'}
</main></body></html>`;
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // Never handle passwords or form data over plain http
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }

    // Old Wix URLs
    if (path === '/apply-today') return Response.redirect(new URL('/apply', url).toString(), 301);

    if (path === '/api/apply' || path === '/api/bid') {
      if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
      return handleSubmit(path === '/api/apply' ? 'apply' : 'bid', request, env, ctx);
    }

    if (path === '/admin' || path === '/admin/export') {
      try {
        return await handleAdmin(request, env, url);
      } catch (err) {
        console.error('Admin error', err);
        return new Response('Something went wrong loading submissions. Check that the D1 database is bound as DB.', { status: 500 });
      }
    }

    return env.ASSETS.fetch(request);
  },
};
