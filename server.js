'use strict';
/**
 * QuickShare server
 *  - statik fayllarni beradi
 *  - WebRTC signaling (xona kodi orqali ikki qurilmani tanishtiradi)
 *  - fayllar serverga YUKLANMAYDI: ular qurilmalar orasida to'g'ridan-to'g'ri o'tadi
 *
 * Ixtiyoriy muhit o'zgaruvchilari (qiyin tarmoqlar uchun TURN):
 *   TURN_URL   = turn:turn.example.com:3478   (vergul bilan bir nechta)
 *   TURN_USER  = foydalanuvchi
 *   TURN_PASS  = parol
 */
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ROOM_WAIT_MS = 10 * 60 * 1000;      // juft kutish vaqti
const ROOM_MAX_MS = 60 * 60 * 1000;       // xona maksimal yashash vaqti
const MAX_ROOMS = 5000;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // o'xshash belgilarsiz
const CODE_LEN = 8;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self' ws: wss:",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'"
    ].join('; ')
  });
  next();
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.get('/api/ice', (req, res) => {
  const iceServers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
  ];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()).filter(Boolean),
      username: process.env.TURN_USER || '',
      credential: process.env.TURN_PASS || ''
    });
  }
  res.set('Cache-Control', 'no-store').json({ iceServers });
});

// Brauzer kutubxonalari (CDN'ga bog'lanmaslik uchun o'zimizdan beramiz)
const vendor = (name, rel) =>
  app.get('/vendor/' + name, (req, res) =>
    res.sendFile(path.join(__dirname, 'node_modules', rel)));
vendor('qrcode.js', 'qrcode-generator/qrcode.js');
vendor('jsQR.js', 'jsqr/dist/jsQR.js');

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', extensions: ['html'] }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

/** code -> { host, guest, createdAt, joinedAt } */
const rooms = new Map();
/** ip -> [timestamps] */
const hits = new Map();

function rateLimited(ip, kind, limit, windowMs) {
  const key = kind + ':' + ip;
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > limit;
}

function newCode() {
  for (let tries = 0; tries < 10; tries++) {
    const bytes = crypto.randomBytes(CODE_LEN);
    let code = '';
    for (let i = 0; i < CODE_LEN; i++) code += ALPHABET[bytes[i] % ALPHABET.length];
    if (!rooms.has(code)) return code;
  }
  return null;
}

const send = (ws, obj) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
};

function closeRoom(code, reason) {
  const room = rooms.get(code);
  if (!room) return;
  rooms.delete(code);
  for (const ws of [room.host, room.guest]) {
    if (ws) {
      ws.room = null;
      if (reason) send(ws, { t: 'error', code: reason });
    }
  }
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
}

wss.on('connection', (ws, req) => {
  // Faqat o'zimizning saytdan kelgan ulanishlar
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return ws.close(1008, 'origin');
    } catch { return ws.close(1008, 'origin'); }
  }

  ws.ip = clientIp(req);
  ws.isAlive = true;
  ws.room = null;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'create') {
      if (ws.room) return;
      if (rateLimited(ws.ip, 'create', 15, 60_000)) return send(ws, { t: 'error', code: 'rate' });
      if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', code: 'busy' });
      const code = newCode();
      if (!code) return send(ws, { t: 'error', code: 'busy' });
      rooms.set(code, { host: ws, guest: null, createdAt: Date.now() });
      ws.room = code;
      ws.isHost = true;
      return send(ws, { t: 'created', code });
    }

    if (m.t === 'join') {
      if (ws.room) return;
      if (rateLimited(ws.ip, 'join', 20, 60_000)) return send(ws, { t: 'error', code: 'rate' });
      const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const room = rooms.get(code);
      if (!room || !room.host || room.host.readyState !== 1) return send(ws, { t: 'error', code: 'not-found' });
      if (room.guest) return send(ws, { t: 'error', code: 'full' });
      room.guest = ws;
      ws.room = code;
      ws.isHost = false;
      send(ws, { t: 'joined' });
      send(room.host, { t: 'peer-joined' });
      return;
    }

    if (m.t === 'signal') {
      const room = ws.room && rooms.get(ws.room);
      if (!room) return;
      const other = ws.isHost ? room.guest : room.host;
      if (other && m.data && typeof m.data === 'object') send(other, { t: 'signal', data: m.data });
    }
  });

  ws.on('close', () => {
    const code = ws.room;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const other = ws.isHost ? room.guest : room.host;
    if (ws.isHost) {
      closeRoom(code);
      if (other) send(other, { t: 'peer-left' });
    } else {
      room.guest = null;
      send(room.host, { t: 'peer-left' });
    }
  });

  ws.on('error', () => {});
});

// Proxy'lar bo'sh ulanishlarni uzib qo'ymasligi uchun ping + eskirgan xonalarni tozalash
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    if ((!room.guest && now - room.createdAt > ROOM_WAIT_MS) || now - room.createdAt > ROOM_MAX_MS) {
      closeRoom(code, 'expired');
    }
  }
  for (const [k, arr] of hits) {
    const fresh = arr.filter((t) => now - t < 60_000);
    if (fresh.length) hits.set(k, fresh); else hits.delete(k);
  }
}, 25_000);

server.listen(PORT, () => console.log('QuickShare http://localhost:' + PORT));
