// แชตคนใกล้ตัว สมุทรสงคราม - เซิร์ฟเวอร์ Node.js (ไม่ต้องติดตั้งแพ็กเกจเพิ่ม, Node 18+)
// คนทั่วไปเข้าได้โดยไม่ต้องล็อกอิน | มีห้องแชต, กระซิบส่วนตัว, รูป/เสียง, รูปโปรไฟล์, เจ้าของ (ชื่อแดง) + แบน
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || ''; // รหัสเจ้าของ ตั้งใน Environment (อย่างน้อย 12 ตัวอักษร)
const DIR = process.env.DATA_DIR || __dirname;
const STATE = path.join(DIR, 'state.json');
const MAX_MSGS = 80, MAX_DMS = 1000, BAN_MS = 100 * 60 * 1000;
const RATE_MS = 1200;
const ROOMS = ['general', 'checkpoint']; // แชตทั่วไป, ตรวจสอบด่านตรวจในจังหวัด

let store = { general: [], checkpoint: [] };
let users = {}; // id -> { h: แฮชของ key, pv: เวอร์ชันรูปโปรไฟล์, p: รูปโปรไฟล์ base64 }
let bans = {}; // id -> เวลาที่แบนหมด
try {
  const x = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  for (const r of ROOMS) if (x.store && Array.isArray(x.store[r])) store[r] = x.store[r].filter((m) => m.k === 't');
  users = x.users || {};
  bans = x.bans || {};
} catch (e) {}

const media = new Map(); // mid -> { mime, buf }
const people = new Map(); // id -> { n, d, ts, o }
let dms = [];
const clients = new Set();
const conns = new Map(); // id -> Set(res)
const lastSent = new Map();

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const idOk = (s) => typeof s === 'string' && /^[a-z0-9]{8,40}$/.test(s);
const keyOk = (s) => typeof s === 'string' && /^[A-Za-z0-9]{16,64}$/.test(s);
const validD = (d) => Number.isInteger(d) && d >= 0 && d <= 2;

function auth(id, key) {
  if (!idOk(id) || !keyOk(key)) return null;
  const h = sha(key), u = users[id];
  if (!u) { users[id] = { h, pv: 0 }; saveSoon(); return users[id]; }
  return same(u.h, h) ? u : null;
}
const isAdmin = (req) => ADMIN_KEY.length >= 12 && typeof req.headers['x-admin'] === 'string' && same(req.headers['x-admin'], ADMIN_KEY);
const banLeft = (id) => { const t = bans[id] || 0; return t > Date.now() ? t : 0; };
function activeBans() { const o = {}, now = Date.now(); for (const k in bans) if (bans[k] > now) o[k] = bans[k]; return o; }

const DURL = /^data:((?:image\/(?:png|jpe?g|webp|gif))|(?:audio\/(?:webm|ogg|mp4|mpeg|aac|x-m4a|wav)))((?:;[a-z0-9=.\-]+)*);base64,([A-Za-z0-9+\/=]+)$/i;
function putMedia(data, kind) {
  const m = DURL.exec(String(data || ''));
  if (!m) return null;
  if (kind === 'i' && !m[1].toLowerCase().startsWith('image/')) return null;
  if (kind === 'v' && !m[1].toLowerCase().startsWith('audio/')) return null;
  const buf = Buffer.from(m[3], 'base64');
  if (!buf.length || buf.length > (kind === 'i' ? 220000 : 200000)) return null;
  const mid = crypto.randomBytes(12).toString('hex');
  media.set(mid, { mime: m[1] + m[2], buf });
  return mid;
}
function trim(arr, max) { while (arr.length > max) { const o = arr.shift(); if (o.mid) media.delete(o.mid); } }

function sse(res, ev, data) { res.write('event: ' + ev + '\ndata: ' + JSON.stringify(data) + '\n\n'); }
function bcast(ev, data) { for (const c of clients) sse(c, ev, data); }
function toUser(id, ev, data) { const s = conns.get(id); if (s) for (const c of s) sse(c, ev, data); }
function peopleList() {
  const now = Date.now();
  for (const [k, v] of people) if (now - v.ts > 90000) people.delete(k);
  return [...people].map(([id, v]) => ({ id, n: v.n, d: v.d, o: v.o ? 1 : 0, pv: (users[id] && users[id].pv) || 0 }));
}

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const s = { store: { general: store.general.filter((m) => m.k === 't'), checkpoint: store.checkpoint.filter((m) => m.k === 't') }, users, bans: activeBans() };
    fs.writeFile(STATE, JSON.stringify(s), () => {});
  }, 2000);
}

function readBody(req) {
  return new Promise((ok, no) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 420000) { req.destroy(); no(); } });
    req.on('end', () => { try { ok(JSON.parse(b)); } catch (e) { no(); } });
  });
}
const ipOf = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
function rateOk(req, id) {
  const now = Date.now(), k1 = 'ip:' + ipOf(req), k2 = 'id:' + id;
  if (now - (lastSent.get(k1) || 0) < RATE_MS || now - (lastSent.get(k2) || 0) < RATE_MS) return false;
  lastSent.set(k1, now); lastSent.set(k2, now);
  return true;
}

// ตรวจและประกอบข้อความ (ใช้ร่วมกันทั้งห้องสาธารณะและกระซิบ)
function build(b, adm) {
  const n = clean(b.n, 12);
  const k = b.k === 'i' || b.k === 'v' ? b.k : 't';
  let t = clean(b.t, 200);
  if (!n || (k === 't' && !t)) return null;
  const m = { n, ts: Date.now(), k };
  if (k === 't') m.t = t;
  else {
    const mid = putMedia(b.data, k);
    if (!mid) return null;
    m.mid = mid;
    m.t = k === 'i' ? '🖼️ รูปภาพ' : '🎙️ ข้อความเสียง';
    if (k === 'v') m.dur = Math.max(1, Math.min(15, Math.round(+b.dur || 1)));
  }
  if (adm) m.o = 1;
  return m;
}

const CSP = "default-src 'self'; img-src 'self' data:; media-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'";

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const url = u.pathname;

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, buf) => {
      if (err) { res.writeHead(500); return res.end('index.html not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' });
      res.end(buf);
    });
    return;
  }

  if (req.method === 'GET' && url === '/events') {
    const id = u.searchParams.get('id'), key = u.searchParams.get('key');
    if (!auth(id, key)) { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    const mine = dms.filter((m) => m.a === id || m.b === id).slice(-300);
    sse(res, 'init', { msgs: store, people: peopleList(), dms: mine, bans: activeBans() });
    clients.add(res);
    if (!conns.has(id)) conns.set(id, new Set());
    conns.get(id).add(res);
    req.on('close', () => { clients.delete(res); const s = conns.get(id); if (s) { s.delete(res); if (!s.size) conns.delete(id); } });
    return;
  }

  if (req.method === 'GET' && url.startsWith('/m/')) {
    const m = media.get(url.slice(3));
    if (!m) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': m.mime, 'Content-Length': m.buf.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' });
    return res.end(m.buf);
  }

  if (req.method === 'GET' && url.startsWith('/a/')) {
    const us = users[url.slice(3)];
    if (!us || !us.p) { res.writeHead(404); return res.end(); }
    const buf = Buffer.from(us.p, 'base64');
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=31536000' });
    return res.end(buf);
  }

  if (req.method === 'POST' && url.startsWith('/api/')) {
    let b;
    try { b = await readBody(req); } catch (e) { return json(res, 400, { ok: false }); }
    const adm = isAdmin(req);

    if (url === '/api/ban') { // เฉพาะเจ้าของ
      if (!adm) return json(res, 403, { ok: false });
      const who = clean(b.who, 40);
      if (!idOk(who) || !users[who]) return json(res, 400, { ok: false });
      if (b.unban) delete bans[who]; else bans[who] = Date.now() + BAN_MS;
      saveSoon();
      bcast('bans', activeBans());
      return json(res, 200, { ok: true });
    }

    if (!auth(b.id, b.key)) return json(res, 401, { ok: false });

    if (url === '/api/presence') {
      const n = clean(b.n, 12);
      if (!n || !validD(b.d)) return json(res, 400, { ok: false });
      people.set(b.id, { n, d: b.d, ts: Date.now(), o: adm });
      bcast('people', peopleList());
      return json(res, 200, { ok: true, admin: adm });
    }

    if (url === '/api/avatar') {
      const m = /^data:image\/jpeg;base64,([A-Za-z0-9+\/=]+)$/.exec(String(b.pic || ''));
      if (!m || m[1].length > 60000) return json(res, 400, { ok: false });
      users[b.id].p = m[1];
      users[b.id].pv = (users[b.id].pv || 0) + 1;
      saveSoon();
      bcast('people', peopleList());
      return json(res, 200, { ok: true });
    }

    if (url === '/api/send' || url === '/api/dm') {
      const left = adm ? 0 : banLeft(b.id);
      if (left) return json(res, 403, { ok: false, error: 'banned', until: left });
      const isDm = url === '/api/dm';
      const r = clean(b.r, 20), to = clean(b.to, 40);
      if (isDm ? (!idOk(to) || !users[to] || to === b.id) : (!ROOMS.includes(r) || !validD(b.d))) return json(res, 400, { ok: false });
      if (!rateOk(req, b.id)) return json(res, 429, { ok: false });
      const m = build(b, adm);
      if (!m) return json(res, 400, { ok: false });
      if (isDm) {
        m.a = b.id; m.an = m.n; m.b = to; delete m.n;
        dms.push(m);
        trim(dms, MAX_DMS);
        toUser(m.a, 'dm', m);
        toUser(to, 'dm', m);
      } else {
        m.u = b.id; m.d = b.d; m.r = r;
        store[r].push(m);
        trim(store[r], MAX_MSGS);
        saveSoon();
        bcast('msg', m);
      }
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { ok: false });
  }

  res.writeHead(404); res.end('Not found');
});

setInterval(() => { bcast('people', peopleList()); for (const c of clients) c.write(': ping\n\n'); }, 20000);
setInterval(() => { const x = Date.now() - 60000; for (const [k, v] of lastSent) if (v < x) lastSent.delete(k); }, 60000);

server.listen(PORT, () => {
  console.log('เปิดที่ http://localhost:' + PORT);
  if (ADMIN_KEY.length < 12) console.log('คำเตือน: ยังไม่ได้ตั้ง ADMIN_KEY (อย่างน้อย 12 ตัวอักษร) จึงยังไม่มีบัญชีเจ้าของ/แบนไม่ได้');
});
