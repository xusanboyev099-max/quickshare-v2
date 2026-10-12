# QuickShare 2.0

Fayllarni (rasm, video, istalgan fayl) siqmasdan, qurilmalar orasida to'g'ridan-to'g'ri (WebRTC) uzatish.

## Ishga tushirish
```
npm install
npm start        # http://localhost:3000
```

## Render'ga joylash
- Build command: `npm install`
- Start command: `npm start`
- Sayt HTTPS bo'lishi shart (kamera va WebRTC uchun) — Render buni avtomatik beradi.

## Qiyin tarmoqlar uchun TURN (ixtiyoriy)
Muhit o'zgaruvchilari: `TURN_URL` (masalan `turn:turn.example.com:3478`), `TURN_USER`, `TURN_PASS`.

## Fayl tuzilishi
- `server.js` — statik fayllar + signaling (WebSocket), tezlik cheklovi, xavfsizlik sarlavhalari
- `public/index.html`, `public/style.css`, `public/app.js` — interfeys va uzatish mantig'i
