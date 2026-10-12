'use strict';
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const CHUNK = 64 * 1024;          // bitta DataChannel xabari
  const BLOCK = 1024 * 1024;        // diskdan o'qish bloki
  const HIGH = 8 * 1024 * 1024;     // jo'natuvchi buferi yuqori chegarasi
  const LOW = 1024 * 1024;
  const RX_PAUSE = 32 * 1024 * 1024; // qabul qiluvchi yozolmay qolsa pauza
  const RX_RESUME = 8 * 1024 * 1024;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------- holat ---------------- */
  const fresh = () => ({
    role: null, ws: null, pc: null, pcP: null, dc: null, code: null,
    items: new Map(), connected: false, running: false,
    remotePaused: false, rxPaused: false, cur: null, dir: null, dirDeclined: false,
    pending: 0, candQueue: [], sigChain: Promise.resolve(), timer: null,
    restarted: false, wake: null, speed: 0, lastBytes: 0, lastT: 0, nextId: 1, ending: false
  });
  let S = fresh();

  /* ---------------- yordamchilar ---------------- */
  const fmtBytes = (n) => {
    if (!isFinite(n) || n < 0) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < 4) { n /= 1024; i++; }
    return (i ? n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2) : String(Math.round(n))) + ' ' + u[i];
  };
  const fmtTime = (s) => {
    if (!isFinite(s) || s < 0) return '—';
    s = Math.round(s);
    if (s < 60) return s + ' s';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' daq ' + (s % 60) + ' s';
    return Math.floor(m / 60) + ' soat ' + (m % 60) + ' daq';
  };
  const safeName = (n) => {
    n = String(n || 'fayl').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').trim();
    if (n.length > 150) { const m = /(\.[A-Za-z0-9]{1,8})$/.exec(n); n = n.slice(0, 140) + (m ? m[1] : ''); }
    return n || 'fayl';
  };
  const icon = (type, name) => {
    if (/^video\//.test(type) || /\.(mp4|mov|mkv|avi|webm)$/i.test(name)) return '🎞️';
    if (/^image\//.test(type) || /\.(jpe?g|png|gif|webp|heic|heif|avif)$/i.test(name)) return '🖼️';
    if (/^audio\//.test(type)) return '🎵';
    return '📄';
  };

  function toast(text, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = text;
    $('#toasts').append(el);
    setTimeout(() => el.remove(), kind === 'err' ? 6500 : 3500);
  }

  function setPhase(p) { document.body.dataset.phase = p; }
  function setStatus(kind, text, sub) {
    $('#session').classList.remove('hidden');
    $('#sessDot').className = 'dot ' + kind;
    $('#sessText').textContent = text;
    $('#sessSub').textContent = sub || '';
  }

  /* ---------------- tablar ---------------- */
  function showTab(name) {
    $$('.tab').forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on);
    });
    $('#tab-send').classList.toggle('hidden', name !== 'send');
    $('#tab-receive').classList.toggle('hidden', name !== 'receive');
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    if (document.body.dataset.phase !== 'idle') { toast('Avval joriy seansni tugating.'); return; }
    stopScan();
    showTab(t.dataset.tab);
  }));

  /* ---------------- fayl qatorlari ---------------- */
  function makeRow(it) {
    const li = document.createElement('li');
    li.className = 'row';
    li.innerHTML = '<div class="thumb"></div><div class="info"><div class="name"></div>' +
      '<div class="meta"><span class="st"></span><span class="sp"></span></div><div class="bar"><i></i></div></div>' +
      '<button class="rbtn save hidden" type="button">Saqlash</button>' +
      '<button class="rbtn x" type="button" title="Bekor qilish" aria-label="Bekor qilish">✕</button>';
    $('.name', li).textContent = it.name;
    const th = $('.thumb', li);
    if (it.file && /^image\/(jpeg|png|gif|webp|avif|bmp)$/.test(it.type)) {
      it.thumbUrl = URL.createObjectURL(it.file);
      const img = new Image();
      img.alt = '';
      img.src = it.thumbUrl;
      th.append(img);
    } else {
      th.textContent = icon(it.type, it.name);
    }
    $('.x', li).addEventListener('click', () => cancelItem(it.id, true));
    $('.save', li).addEventListener('click', () => download(it));
    it.el = li;
    $('#list').append(li);
    $('#transfer').classList.remove('hidden');
    updateRow(it);
  }

  function statusText(it) {
    switch (it.status) {
      case 'queued': return it.announced ? 'Qabul qiluvchi tasdig‘i kutilmoqda' : 'Yuborishga tayyor';
      case 'pending': return 'Qabul qilish kutilmoqda';
      case 'accepted': return 'Navbatda';
      case 'active': return Math.floor(pct(it)) + '%';
      case 'finishing': return 'Yakunlanmoqda…';
      case 'done': return 'Tayyor ✓';
      case 'cancelled': return 'Bekor qilindi';
      case 'error': return it.err || 'Xatolik';
      default: return '';
    }
  }
  const itemDone = (it) => (it.status === 'done' ? it.size : Math.min(it.size, it.done || 0));
  const pct = (it) => (it.size ? (itemDone(it) / it.size) * 100 : 0);

  function updateRow(it) {
    const li = it.el;
    if (!li) return;
    li.className = 'row ' + it.status;
    $('.st', li).textContent = statusText(it);
    $('.sp', li).textContent = fmtBytes(it.size) + (it.status === 'active' ? '' : '');
    $('.bar i', li).style.width = pct(it) + '%';
    const final = ['done', 'cancelled', 'error'].includes(it.status);
    $('.x', li).classList.toggle('hidden', final);
    $('.save', li).classList.toggle('hidden', !(it.status === 'done' && it.result));
  }

  function fail(it, msg) {
    if (it.status === 'done' || it.status === 'cancelled') return;
    it.status = 'error';
    it.err = msg;
    updateRow(it);
  }

  /* ---------------- umumiy statistika ---------------- */
  function stats() {
    let total = 0, done = 0, count = 0, fin = 0;
    for (const it of S.items.values()) {
      if (!it.accepted || it.status === 'cancelled' || it.status === 'error') continue;
      total += it.size; done += itemDone(it); count++;
      if (it.status === 'done') fin++;
    }
    return { total, done, count, fin };
  }
  const isBusy = () => [...S.items.values()].some((i) => ['accepted', 'active', 'finishing'].includes(i.status));

  function tick() {
    const now = performance.now();
    // jo'natuvchida real o'tgan baytlar = yuborilgan - hali bufferda turgan
    if (S.role === 'send' && S.dc) {
      for (const it of S.items.values()) {
        if (it.status === 'active' || it.status === 'finishing') {
          it.done = Math.max(it.done || 0, Math.max(0, (it.sent || 0) - S.dc.bufferedAmount));
        }
      }
    }
    const st = stats();
    if (S.lastT) {
      const dt = (now - S.lastT) / 1000;
      if (dt > 0.2) {
        const inst = Math.max(0, (st.done - S.lastBytes) / dt);
        S.speed = isBusy() ? (S.speed ? S.speed * 0.7 + inst * 0.3 : inst) : 0;
        S.lastBytes = st.done; S.lastT = now;
      }
    } else { S.lastT = now; S.lastBytes = st.done; }

    const p = st.total ? Math.min(100, (st.done / st.total) * 100) : 0;
    $('#ring').style.setProperty('--p', p.toFixed(1));
    $('#pct').textContent = Math.floor(p) + '%';
    $('#stSpeed').textContent = S.speed > 1 ? fmtBytes(S.speed) + '/s' : '—';
    const rem = st.total - st.done;
    $('#stEta').textContent = S.speed > 1 && rem > 0 ? fmtTime(rem / S.speed) : (st.total && rem <= 0 ? 'Tugadi' : '—');
    $('#stBytes').textContent = st.total ? fmtBytes(st.done) + ' / ' + fmtBytes(st.total) : '—';
    $('#stCount').textContent = st.count ? st.fin + ' / ' + st.count : '—';
    $('#sumTitle').textContent = S.role === 'receive' ? 'Qabul qilinmoqda' : 'Yuborilmoqda';

    for (const it of S.items.values()) if (it.status === 'active' || it.status === 'finishing') updateRow(it);

    // ekran o'chib qolmasin
    if (isBusy() && !S.wake && navigator.wakeLock) {
      navigator.wakeLock.request('screen').then((w) => { S.wake = w; w.addEventListener('release', () => { S.wake = null; }); }).catch(() => {});
    } else if (!isBusy() && S.wake) { S.wake.release().catch(() => {}); S.wake = null; }

    // qabul tugmasi
    const pend = [...S.items.values()].some((i) => i.status === 'pending');
    $('#btnAccept').classList.toggle('hidden', !(S.role === 'receive' && pend));
  }
  setInterval(tick, 400);

  window.addEventListener('beforeunload', (e) => {
    if (S.connected && isBusy()) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ---------------- signaling (WebSocket) ---------------- */
  const wsSend = (o) => { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); };
  const sigSend = (data) => wsSend({ t: 'signal', data });

  function openWS() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      let opened = false;
      const to = setTimeout(() => { if (!opened) { try { ws.close(); } catch {} reject(new Error('Server javob bermadi. Birozdan so‘ng qayta urinib ko‘ring.')); } }, 20000);
      ws.onopen = () => { opened = true; clearTimeout(to); S.ws = ws; resolve(ws); };
      ws.onerror = () => { if (!opened) { clearTimeout(to); reject(new Error('Serverga ulanib bo‘lmadi. Internetni tekshiring.')); } };
      ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onWS(m); };
      ws.onclose = () => {
        if (S.ws === ws) {
          S.ws = null;
          if (!S.connected && !S.ending && document.body.dataset.phase !== 'idle') {
            setStatus('err', 'Server bilan aloqa uzildi', 'Seansni tugatib, qaytadan boshlang.');
          }
        }
      };
    });
  }

  const ERR = {
    'not-found': 'Bunday kod topilmadi yoki muddati tugagan. Yuboruvchidan yangi QR-kod so‘rang.',
    full: 'Bu xonaga boshqa qurilma allaqachon ulangan.',
    rate: 'Juda ko‘p urinish. Bir daqiqadan so‘ng qayta urinib ko‘ring.',
    busy: 'Server band. Birozdan so‘ng qayta urinib ko‘ring.',
    expired: 'Xona muddati tugadi. Yangi QR-kod yarating.'
  };

  function onWS(m) {
    switch (m.t) {
      case 'created':
        S.code = m.code;
        showQR(m.code);
        setStatus('wait', 'Qabul qiluvchini kutmoqda…', 'Ikkinchi qurilmada QR-kodni skaner qiling.');
        break;
      case 'joined':
        setStatus('busy', 'Yuboruvchiga ulanmoqda…');
        S.pcP = makePC();
        startConnTimer();
        break;
      case 'peer-joined':
        setStatus('busy', 'Qurilma topildi, ulanmoqda…');
        startHost();
        break;
      case 'signal':
        S.sigChain = S.sigChain.then(() => handleSignal(m.data)).catch((e) => console.warn(e));
        break;
      case 'peer-left':
        if (!S.connected) { fatal('Ikkinchi qurilma ajralib ketdi.'); }
        break;
      case 'error':
        fatal(ERR[m.code] || 'Xatolik yuz berdi.');
        break;
    }
  }

  function fatal(msg) {
    if (S.ending) return;
    clearTimeout(S.timer);
    setStatus('err', msg);
    toast(msg, 'err');
    if (!S.connected) {
      // ulanishgacha bo'lgan xatolikda boshiga qaytamiz
      setTimeout(() => { if (!S.connected) resetAll(true); }, 200);
    }
  }

  /* ---------------- WebRTC ---------------- */
  async function makePC() {
    let ice;
    try { ice = await (await fetch('/api/ice', { cache: 'no-store' })).json(); }
    catch { ice = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }; }
    if (typeof RTCPeerConnection === 'undefined') throw new Error('Brauzeringiz WebRTC ni qo‘llamaydi.');
    const pc = new RTCPeerConnection({ iceServers: ice.iceServers });
    S.pc = pc;
    pc.onicecandidate = (e) => { if (e.candidate) sigSend({ c: e.candidate }); };
    pc.ondatachannel = (e) => setupDC(e.channel);
    const onState = () => {
      const st = pc.connectionState || pc.iceConnectionState;
      if (st === 'failed') connFailed();
      if ((st === 'disconnected' || st === 'closed') && S.connected && isBusy()) {
        toast('Aloqa uzildi.', 'err');
      }
    };
    pc.onconnectionstatechange = onState;
    pc.oniceconnectionstatechange = onState;
    return pc;
  }

  function startConnTimer() {
    clearTimeout(S.timer);
    S.timer = setTimeout(() => { if (!S.connected) connFailed(); }, 30000);
  }

  async function connFailed() {
    if (S.connected || S.ending) return;
    if (S.role === 'send' && !S.restarted && S.pc) {
      S.restarted = true;
      try { await negotiate(true); startConnTimer(); return; } catch {}
    }
    fatal('To‘g‘ridan-to‘g‘ri ulanish o‘rnatilmadi. Tarmoq cheklovi bo‘lishi mumkin (korporativ Wi‑Fi, VPN). Ikkala qurilmani bir xil Wi‑Fi’ga ulab ko‘ring yoki TURN server sozlang.');
  }

  async function startHost() {
    try {
      S.pcP = makePC();
      const pc = await S.pcP;
      setupDC(pc.createDataChannel('quickshare', { ordered: true }));
      startConnTimer();
      await negotiate(false);
    } catch (e) { fatal(e.message || 'Ulanishda xatolik.'); }
  }

  async function negotiate(iceRestart) {
    const pc = S.pc;
    const offer = await pc.createOffer({ iceRestart: !!iceRestart });
    await pc.setLocalDescription(offer);
    sigSend({ sdp: pc.localDescription });
  }

  async function handleSignal(d) {
    if (!d) return;
    const pc = await S.pcP;
    if (!pc || pc.signalingState === 'closed') return;
    if (d.sdp) {
      await pc.setRemoteDescription(d.sdp);
      for (const c of S.candQueue.splice(0)) { try { await pc.addIceCandidate(c); } catch {} }
      if (d.sdp.type === 'offer') {
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        sigSend({ sdp: pc.localDescription });
      }
    } else if (d.c) {
      if (pc.remoteDescription) { try { await pc.addIceCandidate(d.c); } catch {} }
      else S.candQueue.push(d.c);
    }
  }

  async function computeSAS() {
    try {
      if (!crypto.subtle) return null;
      const fp = (sdp) => ((/a=fingerprint:\S+ (\S+)/.exec(sdp || '') || [])[1] || '');
      const a = fp(S.pc.localDescription && S.pc.localDescription.sdp);
      const b = fp(S.pc.remoteDescription && S.pc.remoteDescription.sdp);
      if (!a || !b) return null;
      const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode([a, b].sort().join('|'))));
      const n = ((h[0] << 16) | (h[1] << 8) | h[2]) % 1000000;
      return String(n).padStart(6, '0').replace(/(\d{3})(\d{3})/, '$1 $2');
    } catch { return null; }
  }

  async function connectionKind() {
    try {
      const stats = await S.pc.getStats();
      let pairId = null;
      stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId; });
      let pair = pairId ? stats.get(pairId) : null;
      if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
      const loc = pair && stats.get(pair.localCandidateId);
      const rem = pair && stats.get(pair.remoteCandidateId);
      if (!loc) return '';
      if (loc.candidateType === 'relay' || (rem && rem.candidateType === 'relay')) return 'Server orqali (relay)';
      if (loc.candidateType === 'host' && rem && rem.candidateType === 'host') return 'Bir xil tarmoq ichida';
      return 'To‘g‘ridan-to‘g‘ri';
    } catch { return ''; }
  }

  function setupDC(dc) {
    S.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LOW;
    dc.onopen = async () => {
      S.connected = true;
      clearTimeout(S.timer);
      setPhase('connected');
      $('#linkQR').classList.add('hidden');
      $('#linkIdle').classList.add('hidden');
      const kind = await connectionKind();
      setStatus('ok', 'Ulandi', (kind ? kind + ' · ' : '') + 'shifrlangan kanal');
      const sas = await computeSAS();
      if (sas) { $('#sasCode').textContent = sas; $('#sasBox').classList.remove('hidden'); }
      if (S.role === 'send') sendManifest();
      else setStatus('ok', 'Ulandi', 'Yuboruvchi fayllarni tayyorlamoqda…');
    };
    dc.onclose = () => {
      if (S.ending) return;
      for (const it of S.items.values()) {
        if (['active', 'finishing', 'accepted'].includes(it.status)) fail(it, 'Aloqa uzildi');
        it.dead = true;
      }
      if (S.connected) { setStatus('err', 'Aloqa uzildi', 'Qaytadan ulanish uchun seansni tugating.'); toast('Aloqa uzildi.', 'err'); }
    };
    dc.onerror = () => {};
    dc.onmessage = onMsg;
  }

  const dcOpen = () => S.dc && S.dc.readyState === 'open';
  const dcSend = (o) => { if (dcOpen()) S.dc.send(JSON.stringify(o)); };

  function onMsg(e) {
    if (typeof e.data !== 'string') return onChunk(e.data);
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (S.role === 'send') onSenderMsg(m); else onReceiverMsg(m);
  }

  /* ---------------- JO'NATUVCHI ---------------- */
  const input = $('#fileInput');
  input.addEventListener('change', () => { addFiles([...input.files]); input.value = ''; });
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => addFiles([...(e.dataTransfer.files || [])]));

  function addFiles(list) {
    let added = 0;
    for (const f of list) {
      if (!f.size) { toast('“' + f.name + '” bo‘sh fayl — o‘tkazib yuborildi.', 'err'); continue; }
      const dup = [...S.items.values()].some((i) => i.file && i.name === f.name && i.size === f.size && i.mod === f.lastModified && i.status !== 'cancelled');
      if (dup) continue;
      const id = 'f' + (S.nextId++);
      const it = { id, name: f.name, size: f.size, type: f.type || '', file: f, mod: f.lastModified, status: 'queued', announced: false, accepted: false, done: 0, sent: 0, cancelled: false };
      S.items.set(id, it);
      makeRow(it);
      added++;
    }
    if (added && dcOpen() && S.role === 'send') sendManifest();
  }

  async function createRoom() {
    if (![...S.items.values()].some((i) => i.status === 'queued')) { toast('Avval fayllarni tanlang.', 'err'); return; }
    S.role = 'send';
    document.body.dataset.role = 'send';
    setPhase('waiting');
    setStatus('busy', 'Xona yaratilmoqda…');
    try { await openWS(); wsSend({ t: 'create' }); }
    catch (e) { toast(e.message, 'err'); setStatus('err', e.message); resetRoomOnly(); }
  }
  $('#btnCreate').addEventListener('click', createRoom);

  function drawQR(canvas, text) {
    const qr = qrcode(0, 'M');
    qr.addData(text); qr.make();
    const n = qr.getModuleCount(), scale = 8, margin = 2;
    const size = (n + margin * 2) * scale;
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#0b1020';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
    }
  }

  function showQR(code) {
    const url = location.origin + '/?r=' + code;
    $('#linkIdle').classList.add('hidden');
    $('#linkQR').classList.remove('hidden');
    $('#codeText').textContent = code;
    drawQR($('#qrCanvas'), url);
    S.shareUrl = url;
    if (navigator.share) $('#btnShare').classList.remove('hidden');
  }
  $('#btnCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(S.shareUrl || S.code); toast('Havola nusxalandi', 'ok'); }
    catch { toast('Nusxalab bo‘lmadi. Kodni qo‘lda kiriting: ' + S.code); }
  });
  $('#btnShare').addEventListener('click', () => { navigator.share({ title: 'QuickShare', text: 'Fayl qabul qilish uchun ochang', url: S.shareUrl }).catch(() => {}); });

  function sendManifest() {
    const files = [...S.items.values()].filter((i) => i.status === 'queued' && !i.announced);
    if (!files.length) return;
    dcSend({ t: 'manifest', files: files.map((i) => ({ id: i.id, name: i.name, size: i.size, type: i.type })) });
    files.forEach((i) => { i.announced = true; updateRow(i); });
    setStatus('ok', 'Ulandi', 'Qabul qiluvchi tasdiqlashi kutilmoqda…');
  }

  function onSenderMsg(m) {
    if (m.t === 'accept' && Array.isArray(m.ids)) {
      for (const id of m.ids) {
        const it = S.items.get(id);
        if (it && it.status === 'queued') { it.status = 'accepted'; it.accepted = true; updateRow(it); }
      }
      setStatus('ok', 'Yuborilmoqda…', 'Fayllar asl sifatda uzatilmoqda');
      runQueue();
    } else if (m.t === 'pause') S.remotePaused = true;
    else if (m.t === 'resume') S.remotePaused = false;
    else if (m.t === 'file-ok') {
      const it = S.items.get(m.id);
      if (it && it.status !== 'cancelled') { it.status = 'done'; it.done = it.size; updateRow(it); }
      if (!isBusy()) setStatus('ok', 'Hammasi yuborildi ✓', 'Yana fayl qo‘shishingiz mumkin.');
    } else if (m.t === 'cancel') {
      const it = S.items.get(m.id);
      if (it && !['done', 'cancelled'].includes(it.status)) { it.cancelled = true; it.status = 'cancelled'; updateRow(it); }
    } else if (m.t === 'error') {
      const it = S.items.get(m.id);
      if (it) { it.cancelled = true; fail(it, m.msg || 'Qabul qiluvchida xatolik'); }
    }
  }

  async function runQueue() {
    if (S.running) return;
    S.running = true;
    try {
      for (;;) {
        const it = [...S.items.values()].find((i) => i.status === 'accepted');
        if (!it || !dcOpen()) break;
        await sendFile(it);
      }
    } finally { S.running = false; }
  }

  async function drain(dc) {
    await new Promise((res) => {
      const done = () => { dc.removeEventListener('bufferedamountlow', done); clearTimeout(t); res(); };
      dc.addEventListener('bufferedamountlow', done);
      const t = setTimeout(done, 50);
    });
  }

  async function sendFile(it) {
    const dc = S.dc;
    it.status = 'active'; it.sent = 0; updateRow(it);
    dcSend({ t: 'file-start', id: it.id });
    let off = 0;
    while (off < it.size) {
      if (it.cancelled || !dcOpen()) return;
      while (S.remotePaused && dcOpen() && !it.cancelled) await sleep(60);
      while (dc.bufferedAmount > HIGH && dcOpen() && !it.cancelled) await drain(dc);
      if (it.cancelled || !dcOpen()) return;
      let buf;
      try { buf = await it.file.slice(off, Math.min(off + BLOCK, it.size)).arrayBuffer(); }
      catch {
        fail(it, 'Faylni o‘qib bo‘lmadi (o‘zgargan yoki o‘chirilgan?)');
        dcSend({ t: 'cancel', id: it.id });
        return;
      }
      try {
        for (let p = 0; p < buf.byteLength; p += CHUNK) dc.send(new Uint8Array(buf, p, Math.min(CHUNK, buf.byteLength - p)));
      } catch { fail(it, 'Uzatishda xatolik'); return; }
      off += buf.byteLength;
      it.sent = off;
    }
    if (it.cancelled || !dcOpen()) return;
    it.status = 'finishing'; updateRow(it);
    dcSend({ t: 'file-end', id: it.id, size: it.size });
    while (it.status === 'finishing' && dcOpen()) await sleep(40);
  }

  /* ---------------- QABUL QILUVCHI ---------------- */
  const hasDirPicker = typeof window.showDirectoryPicker === 'function';
  const hasOPFS = !!(navigator.storage && navigator.storage.getDirectory && typeof FileSystemFileHandle !== 'undefined' && FileSystemFileHandle.prototype.createWritable);
  $('#capNote').textContent = hasDirPicker
    ? 'Fayllar tanlangan papkaga to‘g‘ridan-to‘g‘ri yoziladi — hajm cheklanmagan.'
    : hasOPFS
      ? 'Fayllar vaqtincha diskka yoziladi va tugagach yuklab olinadi.'
      : 'Bu brauzerda fayllar xotirada yig‘iladi. Juda katta videolar uchun kompyuterdagi Chrome/Edge tavsiya etiladi.';

  async function joinRoom(code) {
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 6) { toast('Kod noto‘g‘ri. Kamida 6 ta belgi kiriting.', 'err'); return; }
    S.role = 'receive';
    document.body.dataset.role = 'receive';
    setPhase('waiting');
    setStatus('busy', 'Ulanmoqda…');
    try { await openWS(); wsSend({ t: 'join', code }); }
    catch (e) { toast(e.message, 'err'); setStatus('err', e.message); resetRoomOnly(); }
  }

  function parseCode(text) {
    text = String(text || '').trim();
    try { const r = new URL(text).searchParams.get('r'); if (r) return r; } catch {}
    const m = /[?&]r=([A-Za-z0-9]+)/.exec(text);
    return m ? m[1] : text;
  }
  $('#joinForm').addEventListener('submit', (e) => { e.preventDefault(); joinRoom(parseCode($('#codeInput').value)); });

  function onReceiverMsg(m) {
    if (m.t === 'manifest' && Array.isArray(m.files)) {
      let n = 0;
      for (const f of m.files.slice(0, 500)) {
        if (!f || typeof f.id !== 'string' || S.items.has(f.id)) continue;
        const size = Number(f.size);
        if (!Number.isFinite(size) || size <= 0) continue;
        const it = { id: f.id, name: safeName(f.name), size, type: String(f.type || ''), status: 'pending', accepted: false, done: 0, recv: 0, chain: Promise.resolve() };
        S.items.set(it.id, it);
        makeRow(it);
        n++;
      }
      if (n) {
        setStatus('ok', n + ' ta fayl keldi', '“Qabul qilish” tugmasini bosing.');
        toast(n + ' ta fayl yuborilmoqchi. Qabul qilasizmi?', 'ok');
      }
    } else if (m.t === 'file-start') {
      const it = S.items.get(m.id);
      if (!it || it.status !== 'accepted') return;
      S.cur = it.id;
      it.status = 'active'; it.recv = 0; it.done = 0; it.dead = false;
      it.chain = Promise.resolve();
      it.sinkP = makeSink(it);
      it.sinkP.catch((err) => failRx(it, err));
      updateRow(it);
      setStatus('ok', 'Qabul qilinmoqda…', 'Asl sifatda, siqilmasdan');
    } else if (m.t === 'file-end') {
      const it = S.items.get(m.id);
      if (!it || it.status !== 'active') return;
      S.cur = null;
      it.chain = it.chain.then(() => finishRx(it, Number(m.size)));
    } else if (m.t === 'cancel') {
      const it = S.items.get(m.id);
      if (it && !['done', 'cancelled'].includes(it.status)) abortRx(it, 'cancelled');
    }
  }

  function onChunk(buf) {
    const it = S.items.get(S.cur);
    if (!it || it.status !== 'active' || it.dead) return;
    const n = buf.byteLength;
    it.recv += n; it.done = it.recv;
    S.pending += n;
    it.chain = it.chain.then(async () => {
      try { if (!it.dead) { const sink = await it.sinkP; await sink.write(buf); } }
      catch (err) { failRx(it, err); }
      finally { S.pending -= n; flow(); }
    });
    flow();
  }

  function flow() {
    if (!S.rxPaused && S.pending > RX_PAUSE) { S.rxPaused = true; dcSend({ t: 'pause' }); }
    else if (S.rxPaused && S.pending < RX_RESUME) { S.rxPaused = false; dcSend({ t: 'resume' }); }
  }

  function failRx(it, err) {
    if (it.dead) return;
    it.dead = true;
    if (S.cur === it.id) S.cur = null;
    const quota = err && /quota|space|full/i.test(String(err.name + err.message));
    fail(it, quota ? 'Joy yetmadi (disk yoki xotira to‘ldi)' : 'Saqlashda xatolik');
    dcSend({ t: 'error', id: it.id, msg: 'Qabul qiluvchida joy yetmadi yoki yozishda xatolik' });
    Promise.resolve(it.sinkP).then((s) => s && s.abort()).catch(() => {});
  }

  function abortRx(it, status) {
    it.dead = true;
    if (S.cur === it.id) S.cur = null;
    it.status = status;
    updateRow(it);
    const p = it.sinkP;
    if (p) it.chain.then(() => p.then((s) => s.abort())).catch(() => {});
  }

  async function finishRx(it, declared) {
    if (it.dead) return;
    if (it.recv !== it.size || (declared && declared !== it.size)) {
      failRx(it, new Error('size'));
      it.err = 'Hajm mos kelmadi — fayl to‘liq kelmadi';
      updateRow(it);
      return;
    }
    try {
      const sink = await it.sinkP;
      it.result = await sink.close();
      it.status = 'done'; it.done = it.size;
      updateRow(it);
      dcSend({ t: 'file-ok', id: it.id });
      if (it.result) download(it);
      if (!isBusy()) setStatus('ok', 'Hammasi qabul qilindi ✓', 'Fayllar saqlandi.');
    } catch (err) { failRx(it, err); }
  }

```javascript
function download(it) {
  if (!it.result) return;

  const url = URL.createObjectURL(it.result.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeName(it.name);
  document.body.appendChild(a);
  a.click();
  a.remove();

  toast(
    'Yuklash boshlandi! Fayl odatda Downloads papkasiga saqlanadi.',
    'ok'
  );

  setTimeout(() => URL.revokeObjectURL(url), 120000);
}
```

  async function uniqueName(dir, name) {
    const m = /^(.*?)(\.[^.]*)?$/.exec(name);
    const base = m[1], ext = m[2] || '';
    for (let i = 0; i < 500; i++) {
      const cand = i ? base + ' (' + i + ')' + ext : name;
      try { await dir.getFileHandle(cand); } catch (e) { if (e.name === 'NotFoundError') return cand; throw e; }
    }
    return Date.now() + '-' + name;
  }

  async function makeSink(it) {
    const name = safeName(it.name);
    if (S.dir) {
      const fname = await uniqueName(S.dir, name);
      const fh = await S.dir.getFileHandle(fname, { create: true });
      const w = await fh.createWritable();
      return {
        write: (b) => w.write(b),
        close: async () => { await w.close(); return null; },
        abort: async () => { try { await w.abort(); } catch {} try { await S.dir.removeEntry(fname); } catch {} }
      };
    }
    if (hasOPFS) {
      try {
        const root = await navigator.storage.getDirectory();
        const tmp = 'qs-' + it.id + '-' + Date.now();
        const fh = await root.getFileHandle(tmp, { create: true });
        const w = await fh.createWritable();
        return {
          write: (b) => w.write(b),
          close: async () => { await w.close(); return { blob: await fh.getFile() }; },
          abort: async () => { try { await w.abort(); } catch {} try { await root.removeEntry(tmp); } catch {} }
        };
      } catch { /* xotiraga o'tamiz */ }
    }
    const parts = [];
    return {
      write: async (b) => { parts.push(b); },
      close: async () => ({ blob: new Blob(parts, { type: it.type || 'application/octet-stream' }) }),
      abort: async () => { parts.length = 0; }
    };
  }

  async function acceptAll() {
    const ids = [...S.items.values()].filter((i) => i.status === 'pending').map((i) => i.id);
    if (!ids.length) return;
    if (!S.dir && hasDirPicker && !S.dirDeclined) {
      try { S.dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'quickshare' }); }
      catch (e) {
        S.dirDeclined = true;
        toast(e && e.name === 'AbortError' ? 'Papka tanlanmadi — fayllar brauzer orqali yuklab olinadi.' : 'Papkaga yozib bo‘lmadi — fayllar brauzer orqali yuklab olinadi.');
      }
    }
    if (!S.dir && !hasOPFS) {
      const big = [...S.items.values()].filter((i) => ids.includes(i.id)).reduce((a, i) => a + i.size, 0);
      if (big > 1.5 * 1024 * 1024 * 1024 && !confirm('Fayllar katta (' + fmtBytes(big) + ') va bu brauzer ularni xotirada saqlaydi. Xotira yetmasligi mumkin. Davom etaymi?')) return;
    }
    for (const id of ids) { const it = S.items.get(id); it.status = 'accepted'; it.accepted = true; updateRow(it); }
    dcSend({ t: 'accept', ids });
    setStatus('ok', 'Qabul qilinmoqda…');
  }
  $('#btnAccept').addEventListener('click', acceptAll);

  /* ---------------- bekor qilish ---------------- */
  function cancelItem(id, notify) {
    const it = S.items.get(id);
    if (!it || ['done', 'cancelled', 'error'].includes(it.status)) return;
    if (S.role === 'send') {
      it.cancelled = true;
      it.status = 'cancelled';
      updateRow(it);
      if (notify && it.announced) dcSend({ t: 'cancel', id });
      if (it.announced === false && !dcOpen()) { /* hali yuborilmagan — shunchaki o'chiramiz */ }
    } else {
      const wasActive = it.status === 'active';
      if (notify) dcSend({ t: 'cancel', id });
      if (wasActive) abortRx(it, 'cancelled'); else { it.status = 'cancelled'; updateRow(it); }
    }
  }
  $('#btnCancelAll').addEventListener('click', () => {
    const open = [...S.items.values()].filter((i) => !['done', 'cancelled', 'error'].includes(i.status));
    if (!open.length) { toast('Bekor qilinadigan uzatish yo‘q.'); return; }
    open.forEach((i) => cancelItem(i.id, true));
    toast('Uzatish bekor qilindi.');
  });

  /* ---------------- kamera skaneri ---------------- */
  let scan = null;
  async function startScan() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Kamera faqat HTTPS orqali ishlaydi. Kodni qo‘lda kiriting.', 'err'); return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      const video = $('#scanVideo');
      video.srcObject = stream;
      await video.play();
      $('#scanBox').classList.remove('hidden');
      const cv = document.createElement('canvas');
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      scan = { stream, stop: false };
      const loop = () => {
        if (!scan || scan.stop) return;
        if (video.readyState >= 2 && video.videoWidth) {
          const k = Math.min(1, 520 / video.videoWidth);
          cv.width = Math.round(video.videoWidth * k); cv.height = Math.round(video.videoHeight * k);
          ctx.drawImage(video, 0, 0, cv.width, cv.height);
          const img = ctx.getImageData(0, 0, cv.width, cv.height);
          const r = jsQR(img.data, cv.width, cv.height, { inversionAttempts: 'dontInvert' });
          if (r && r.data) {
            const code = parseCode(r.data);
            if (/^[A-Za-z0-9]{6,12}$/.test(code)) { stopScan(); $('#codeInput').value = code; joinRoom(code); return; }
          }
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    } catch (e) {
      toast(e && e.name === 'NotAllowedError' ? 'Kameraga ruxsat berilmadi. Brauzer sozlamalarida ruxsat bering yoki kodni qo‘lda kiriting.' : 'Kamerani ochib bo‘lmadi. Kodni qo‘lda kiriting.', 'err');
    }
  }
  function stopScan() {
    if (scan) { scan.stop = true; scan.stream.getTracks().forEach((t) => t.stop()); scan = null; }
    $('#scanBox').classList.add('hidden');
  }
  $('#btnScan').addEventListener('click', startScan);
  $('#btnScanStop').addEventListener('click', stopScan);

  /* ---------------- tugatish / tozalash ---------------- */
  function resetRoomOnly() {
    try { S.ws && S.ws.close(); } catch {}
    S.ws = null; S.role = null; S.code = null;
    document.body.dataset.role = '';
    setPhase('idle');
    $('#linkQR').classList.add('hidden');
    $('#linkIdle').classList.remove('hidden');
  }

  function resetAll(keepFiles) {
    S.ending = true;
    clearTimeout(S.timer);
    stopScan();
    try { S.dc && S.dc.close(); } catch {}
    try { S.pc && S.pc.close(); } catch {}
    try { S.ws && S.ws.close(); } catch {}
    if (S.wake) { S.wake.release().catch(() => {}); }
    const keep = keepFiles && S.role === 'send' ? [...S.items.values()].filter((i) => i.file && i.status === 'queued') : [];
    for (const it of S.items.values()) { if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl); }
    const dir = S.dir, declined = S.dirDeclined;
    S = fresh();
    S.dir = dir; S.dirDeclined = declined;
    $('#list').textContent = '';
    $('#transfer').classList.add('hidden');
    $('#session').classList.add('hidden');
    $('#sasBox').classList.add('hidden');
    $('#btnAccept').classList.add('hidden');
    $('#linkQR').classList.add('hidden');
    $('#linkIdle').classList.remove('hidden');
    document.body.dataset.role = '';
    setPhase('idle');
    // jo'natuvchi tanlagan, hali yuborilmagan fayllarni saqlab qolamiz
    if (keep.length) {
      for (const it of keep) { it.announced = false; it.status = 'queued'; it.accepted = false; it.done = 0; it.sent = 0; it.cancelled = false; S.items.set(it.id, it); S.nextId = Math.max(S.nextId, parseInt(it.id.slice(1), 10) + 1); makeRow(it); }
    }
  }
  $('#btnEnd').addEventListener('click', () => {
    if (S.connected && isBusy() && !confirm('Uzatish davom etmoqda. Seansni tugatsangizmi?')) return;
    resetAll(false);
  });

  /* ---------------- ishga tushirish ---------------- */
  // eski qolib ketgan vaqtinchalik fayllarni tozalash (OPFS)
  (async () => {
    try {
      if (!navigator.storage || !navigator.storage.getDirectory) return;
      const root = await navigator.storage.getDirectory();
      for await (const [name] of root.entries()) if (name.startsWith('qs-')) { try { await root.removeEntry(name); } catch {} }
    } catch {}
  })();

  const r = new URLSearchParams(location.search).get('r');
  if (r) {
    history.replaceState(null, '', location.pathname);
    showTab('receive');
    $('#codeInput').value = r.toUpperCase();
    joinRoom(r);
  }
})();
