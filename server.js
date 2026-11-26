/*
 * กรุงศรีอยุธยา 3D — เซิร์ฟเวอร์ล็อคอิน / สมัครไอดี / เซฟความคืบหน้า
 *
 * วิธีรัน (ต้องมี Node.js 16 ขึ้นไป ไม่ต้องติดตั้งแพ็กเกจเพิ่ม):
 *     node server.js
 * แล้วเปิดเบราว์เซอร์ที่  http://localhost:3000
 * (มือถือในวง Wi-Fi เดียวกันเปิด  http://<IP เครื่อง>:3000)
 *
 * วางไฟล์ rpg.html ไว้โฟลเดอร์เดียวกับไฟล์นี้
 * ข้อมูลผู้เล่นเก็บที่ data/accounts.json  (เปลี่ยนพอร์ตได้ด้วย PORT=8080 node server.js)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const HTML = path.join(__dirname, process.env.GAME_FILE || 'rpg.html');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'accounts.json');
const ID_RE = /^[A-Za-z][A-Za-z0-9]{1,15}_[mf]$/i;
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_BODY = 256 * 1024;

// ---------- ฐานข้อมูลไฟล์ JSON ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { users: {}, sessions: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) { /* ไฟล์ใหม่ */ }
let dirty = false, writing = false;
function persist() {
  dirty = true;
  if (writing) return;
  writing = true;
  setTimeout(() => {
    dirty = false;
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(db), err => {
      if (!err) fs.rename(tmp, DB_FILE, () => { writing = false; if (dirty) persist(); });
      else { writing = false; console.error('บันทึกข้อมูลไม่สำเร็จ', err.message); }
    });
  }, 400);
}
function flushSync() { try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) {} }
process.on('SIGINT', () => { flushSync(); process.exit(0); });
process.on('SIGTERM', () => { flushSync(); process.exit(0); });

// ---------- รหัสผ่าน / เซสชัน ----------
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
function checkPw(pw, u) {
  const a = Buffer.from(hashPw(pw, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function newSession(key) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  for (const t in db.sessions) if (db.sessions[t].exp < now) delete db.sessions[t];
  db.sessions[token] = { key, exp: now + SESSION_MS };
  return token;
}
function userFromToken(token) {
  const s = typeof token === 'string' && db.sessions[token];
  if (!s || s.exp < Date.now()) return null;
  return db.users[s.key] || null;
}

// ---------- กันยิงรหัสสุ่ม ----------
const tries = new Map();
function limited(ip) {
  const now = Date.now(), r = tries.get(ip);
  if (!r || now - r.t > 10 * 60 * 1000) { tries.set(ip, { t: now, n: 1 }); return false; }
  return ++r.n > 40;
}

// ---------- HTTP ----------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};
function send(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CORS));
  res.end(b);
}
function readBody(req) {
  return new Promise((ok, no) => {
    let n = 0; const ch = [];
    req.on('data', c => { n += c.length; if (n > MAX_BODY) { no(new Error('big')); req.destroy(); } else ch.push(c); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(ch).toString('utf8') || '{}')); } catch (e) { no(new Error('json')); } });
    req.on('error', no);
  });
}
const publicUser = u => ({ id: u.id, gender: u.gender });

async function api(req, res, url) {
  const ip = req.socket.remoteAddress || '?';
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method' });
  let b;
  try { b = await readBody(req); } catch (e) { return send(res, 400, { ok: false, error: 'ข้อมูลไม่ถูกต้อง' }); }
  if (!b || typeof b !== 'object') return send(res, 400, { ok: false, error: 'ข้อมูลไม่ถูกต้อง' });

  if (url === '/api/register') {
    if (limited(ip)) return send(res, 429, { ok: false, error: 'ลองบ่อยเกินไป กรุณารอสักครู่' });
    const id = String(b.id || '').trim(), pw = String(b.password || ''), pw2 = String(b.confirm || '');
    if (!ID_RE.test(id)) return send(res, 400, { ok: false, error: 'ไอดีต้องเป็นภาษาอังกฤษ ตามด้วย _m หรือ _f (เช่น somchai_m)' });
    if (pw.length < 4 || pw.length > 64) return send(res, 400, { ok: false, error: 'รหัสผ่านต้องยาว 4–64 ตัวอักษร' });
    if (pw !== pw2) return send(res, 400, { ok: false, error: 'รหัสผ่านทั้งสองช่องไม่ตรงกัน' });
    const key = id.toLowerCase();
    if (db.users[key]) return send(res, 409, { ok: false, error: 'ไอดีนี้ถูกใช้แล้ว ลองชื่ออื่น' });
    const salt = crypto.randomBytes(16).toString('hex');
    const gender = key.endsWith('_f') ? 'f' : 'm';
    const u = db.users[key] = { id: key, gender, salt, hash: hashPw(pw, salt), created: Date.now(), save: null };
    const token = newSession(key);
    persist();
    return send(res, 200, Object.assign({ ok: true, isNew: true, token, save: null }, publicUser(u)));
  }

  if (url === '/api/login') {
    if (limited(ip)) return send(res, 429, { ok: false, error: 'ลองบ่อยเกินไป กรุณารอสักครู่' });
    const key = String(b.id || '').trim().toLowerCase(), pw = String(b.password || '');
    const u = db.users[key];
    if (!u || !checkPw(pw, u)) return send(res, 401, { ok: false, error: 'ไอดีหรือรหัสผ่านไม่ถูกต้อง' });
    const token = newSession(key);
    persist();
    return send(res, 200, Object.assign({ ok: true, token, save: u.save }, publicUser(u)));
  }

  if (url === '/api/save') {
    const u = userFromToken(b.token);
    if (!u) return send(res, 401, { ok: false, error: 'หมดเวลาเข้าสู่ระบบ' });
    const s = b.save;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return send(res, 400, { ok: false, error: 'ข้อมูลเซฟไม่ถูกต้อง' });
    u.save = s; u.saved = Date.now();
    persist();
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { ok: false, error: 'not found' });
}

// ---------- ส่งไฟล์เกม (บีบอัด gzip ครั้งเดียวตอนเปิดเซิร์ฟเวอร์) ----------
let page = null, pageGz = null, pageMtime = 0;
function loadPage() {
  const st = fs.statSync(HTML);
  if (page && st.mtimeMs === pageMtime) return;
  page = fs.readFileSync(HTML);
  pageGz = zlib.gzipSync(page, { level: 6 });
  pageMtime = st.mtimeMs;
  console.log(`โหลด ${path.basename(HTML)} ${(page.length / 1048576).toFixed(1)}MB (gzip ${(pageGz.length / 1048576).toFixed(1)}MB)`);
}
try { loadPage(); } catch (e) { console.error('ไม่พบไฟล์เกม:', HTML); process.exit(1); }

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (url.startsWith('/api/')) return api(req, res, url).catch(() => send(res, 500, { ok: false, error: 'server error' }));
  if (url === '/' || url === '/index.html' || url === '/rpg.html') {
    try { loadPage(); } catch (e) {}
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const h = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' };
    if (gz) h['Content-Encoding'] = 'gzip';
    h['Content-Length'] = (gz ? pageGz : page).length;
    res.writeHead(200, h);
    return res.end(req.method === 'HEAD' ? undefined : (gz ? pageGz : page));
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
});
server.listen(PORT, HOST, () => {
  console.log(`เซิร์ฟเวอร์พร้อมแล้ว →  http://localhost:${PORT}`);
  console.log(`ผู้เล่นที่สมัครแล้ว: ${Object.keys(db.users).length} คน  (ข้อมูลที่ ${DB_FILE})`);
});
