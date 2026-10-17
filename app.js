/* Walk Companion: GPS-guided walk notes. Plain JavaScript, no build step. */
(function () {
  'use strict';
  const CFG = window.WALK_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('wc.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('wc.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  };
  const params = new URLSearchParams(location.search);

  const S = {
    route: null, cum: [], stops: [], mains: [],
    view: params.get('view') === 'walker' ? 'walker' : LS.get('view', 'leader'),
    viewLocked: params.get('view') === 'walker',
    progressKm: null, lastIdx: null, lateral: null, fix: null,
    shown: new Set(), displayIdx: null, follow: true,
    practice: false, watchId: null, history: [],
    walkStart: null, map: null, meMarker: null, accCircle: null, mapFollow: true,
    settings: {
      autoRead: LS.get('autoRead', false), chime: LS.get('chime', true), wakeLock: LS.get('wakeLock', false),
      radius: LS.get('radius', 60), rate: LS.get('rate', 1.0), osKey: LS.get('osKey', CFG.OS_MAPS_KEY || '')
    },
    wakeSentinel: null
  };

  /* ---------- geometry ---------- */
  const R = 6371000, rad = Math.PI / 180;
  function dist(a, b) { // [lat,lon]
    const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function projectOnSeg(p, a, b) { // returns {t, d} in metres, local flat approx
    const k = Math.cos(a[0] * rad);
    const ax = a[1] * k * rad * R, ay = a[0] * rad * R, bx = b[1] * k * rad * R, by = b[0] * rad * R;
    const px = p[1] * k * rad * R, py = p[0] * rad * R;
    const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
    let t = L2 ? ((px - ax) * vx + (py - ay) * vy) / L2 : 0; t = Math.max(0, Math.min(1, t));
    const qx = ax + t * vx, qy = ay + t * vy;
    return { t, d: Math.hypot(px - qx, py - qy) };
  }
  function snap(p) {
    const tr = S.route.track, n = tr.length;
    const evalRange = (i0, i1) => {
      let best = null;
      for (let i = Math.max(0, i0); i < Math.min(n - 1, i1); i++) {
        const r = projectOnSeg(p, tr[i], tr[i + 1]);
        const km = S.cum[i] + r.t * (S.cum[i + 1] - S.cum[i]);
        if (!best || r.d < best.d) best = { i, d: r.d, km };
      }
      return best;
    };
    if (S.lastIdx !== null) {
      const local = evalRange(S.lastIdx - 25, S.lastIdx + 140);
      if (local && local.d < 120) return local;
    }
    // global: gather near-best candidates, prefer the one nearest previous progress (or the earliest)
    const cands = [];
    for (let i = 0; i < n - 1; i++) {
      const r = projectOnSeg(p, tr[i], tr[i + 1]);
      cands.push({ i, d: r.d, km: S.cum[i] + r.t * (S.cum[i + 1] - S.cum[i]) });
    }
    const minD = Math.min(...cands.map(c => c.d));
    const near = cands.filter(c => c.d <= minD + 30);
    const ref = S.progressKm === null ? 0 : S.progressKm;
    near.sort((a, b) => Math.abs(a.km - ref) - Math.abs(b.km - ref));
    return near[0];
  }
  function pointAtKm(km) {
    const c = S.cum, tr = S.route.track;
    if (km <= 0) return tr[0];
    for (let i = 0; i < c.length - 1; i++) {
      if (c[i + 1] >= km) {
        const t = (km - c[i]) / ((c[i + 1] - c[i]) || 1);
        return [tr[i][0] + t * (tr[i + 1][0] - tr[i][0]), tr[i][1] + t * (tr[i + 1][1] - tr[i][1])];
      }
    }
    return tr[tr.length - 1];
  }

  /* ---------- formatting ---------- */
  const fmtKm = (km) => km < 1 ? Math.round(km * 1000 / 10) * 10 + ' m' : km.toFixed(1) + ' km';
  const fmtMin = (m) => m < 60 ? Math.round(m) + ' min' : Math.floor(m / 60) + ' h ' + Math.round(m % 60) + ' min';
  const hhmm = (d) => d.toTimeString().slice(0, 5).replace(':', '.');
  function toast(msg, ms = 3500) { const t = $('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms); }

  /* ---------- loading ---------- */
  async function loadJSON(url) { const r = await fetch(url, { cache: 'no-cache' }); if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); }
  async function init() {
    applyView();
    let index;
    try { index = await loadJSON('routes/index.json'); } catch (e) { $('routeTitle').textContent = 'Could not load routes'; return; }
    const sel = $('routeSelect');
    index.routes.forEach(r => { const o = document.createElement('option'); o.value = r.id; o.textContent = r.title; sel.appendChild(o); });
    const wanted = params.get('route') || LS.get('routeId', index.routes[0].id);
    const entry = index.routes.find(r => r.id === wanted) || index.routes[0];
    sel.value = entry.id;
    sel.onchange = () => { LS.set('routeId', sel.value); location.search = '?route=' + sel.value + (S.viewLocked ? '&view=walker' : ''); };
    await loadRoute(entry);
    bindUI();
    registerSW();
  }
  async function loadRoute(entry) {
    S.route = await loadJSON(entry.file);
    LS.set('routeId', S.route.id);
    const tr = S.route.track; S.cum = [0];
    for (let i = 1; i < tr.length; i++) S.cum.push(S.cum[i - 1] + dist(tr[i - 1], tr[i]) / 1000);
    S.stops = S.route.stops.slice().sort((a, b) => a.km - b.km);
    S.mains = S.stops.filter(s => s.kind === 'main');
    S.shown = new Set(LS.get('shown.' + S.route.id, []));
    S.walkStart = LS.get('start.' + S.route.id, null);
    $('routeTitle').textContent = S.route.title;
    $('routeSub').textContent = S.route.subtitle || '';
    $('practiceSlider').max = S.cum[S.cum.length - 1].toFixed(2);
    $('aboutText').textContent = `Walk Companion ${CFG.APP_VERSION || ''}. ${S.route.credits || ''} Map: Contains OS data © Crown copyright and database rights ${new Date().getFullYear()}. Your location stays on this phone.`;
    renderStopList(); renderPlan(); renderNotes(); updateStatus();
    showStop(0, 'Start');
    offlineHint();
  }

  /* ---------- view ---------- */
  function applyView() {
    document.body.classList.toggle('walker', S.view === 'walker');
    $('viewToggle').textContent = S.view === 'walker' ? 'Walker' : 'Leader';
    $('viewToggle').classList.toggle('hidden', S.viewLocked);
  }

  /* ---------- GPS ---------- */
  function startGps() {
    if (!('geolocation' in navigator)) { toast('This phone does not offer GPS to the browser.'); return; }
    stopPractice();
    if (S.watchId !== null) return;
    S.watchId = navigator.geolocation.watchPosition(onFix, onGpsError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
    $('startGps').textContent = 'GPS on';
    $('startPanel').classList.add('hidden');
    if (!S.walkStart && isWalkDay()) { /* absolute plan times used */ }
    requestWake();
    unlockAudio();
  }
  function onGpsError(e) {
    $('gpsStatus').className = 'gps off'; $('gpsStatus').textContent = e.code === 1 ? 'GPS blocked' : 'No GPS fix';
    if (e.code === 1) toast('Location permission was refused. Allow location for this site in Chrome settings.', 6000);
  }
  function onFix(pos) {
    const p = [pos.coords.latitude, pos.coords.longitude], acc = pos.coords.accuracy || 999;
    $('gpsStatus').className = 'gps ' + (acc <= 25 ? 'good' : 'weak');
    $('gpsStatus').textContent = 'GPS ±' + Math.round(acc) + ' m';
    if (acc > 120) return; // too vague to trust
    handlePosition(p, acc, pos.timestamp || Date.now());
  }
  function handlePosition(p, acc, ts) {
    S.fix = { p, acc, ts };
    $('startPanel').classList.add('hidden');
    const s = snap(p);
    S.lastIdx = s.i; S.lateral = s.d;
    const prev = S.progressKm;
    S.progressKm = s.km;
    S.history.push({ ts, km: s.km }); while (S.history.length && ts - S.history[0].ts > 6 * 60000) S.history.shift();
    if (S.practice && prev !== null && s.km < prev - 0.05) { // moving backwards in practice: allow re-triggering
      S.stops.forEach(st => { if (st.km > s.km) S.shown.delete(st.id); });
    }
    checkArrivals(p);
    updateStatus(); updateMapMe(); markListProgress();
    if (S.follow) followDisplay();
  }

  /* ---------- arrivals ---------- */
  function checkArrivals(p) {
    const radiusM = S.settings.radius;
    for (const st of S.stops) {
      if (S.shown.has(st.id)) continue;
      const dTrig = dist(p, [st.tlat, st.tlon]);
      const passed = S.progressKm > st.km + 0.12 && S.progressKm - st.km < 1.5;
      // trigger by position, but only for stops near our progress (the route passes Stoke twice)
      if (dTrig <= radiusM && Math.abs(S.progressKm - st.km) < 0.3) { arrive(st); }
      else if (passed) { S.shown.add(st.id); }
    }
    LS.set('shown.' + S.route.id, [...S.shown]);
  }
  function arrive(st) {
    S.shown.add(st.id);
    if (st.kind === 'main') {
      if (S.follow) showStop(S.stops.indexOf(st), 'Here');
      if (S.settings.chime) { chime(); if (navigator.vibrate) navigator.vibrate([200, 100, 200]); }
      if (S.settings.autoRead) speak(st);
      if (!S.follow) toast('Arrived: ' + st.name);
    } else {
      if (S.settings.chime && navigator.vibrate) navigator.vibrate(120);
      toast('Nearby: ' + st.name);
    }
  }

  /* ---------- display ---------- */
  function nextMainIdx(km) { return S.stops.findIndex(s => s.kind === 'main' && s.km >= km - 0.03 && !S.shown.has(s.id)); }
  function followDisplay() {
    if (S.progressKm === null) return;
    // most recently arrived main stop within 250 m behind us, else the next one
    const recent = S.mains.filter(s => S.shown.has(s.id) && s.km <= S.progressKm + 0.1 && S.progressKm - s.km < 0.25);
    let idx, badge;
    if (recent.length) { idx = S.stops.indexOf(recent[recent.length - 1]); badge = 'Here'; }
    else { idx = nextMainIdx(S.progressKm); badge = 'Next'; if (idx < 0) { idx = S.stops.length - 1; badge = 'Finish'; } }
    if (idx !== S.displayIdx) showStop(idx, badge); else updateDistance();
  }
  function showStop(idx, badge) {
    if (idx < 0 || idx >= S.stops.length) return;
    S.displayIdx = idx; const st = S.stops[idx];
    $('stopCard').classList.remove('hidden');
    $('stopBadge').textContent = badge || (st.kind === 'main' ? 'Stop' : 'Point');
    $('stopBadge').className = 'badge' + (badge === 'Here' ? ' here' : '');
    $('stopType').textContent = st.type || '';
    $('stopName').textContent = st.name;
    $('stopDetail').textContent = [st.km.toFixed(1) + ' km', st.grid, st.off > 30 ? st.off + ' m off route' : ''].filter(Boolean).join(' · ');
    $('stopTalk').textContent = st.talk || '';
    const bg = $('stopBackground'); bg.innerHTML = st.background || ''; bg.classList.add('hidden');
    $('bgBtn').classList.toggle('hidden', !st.background);
    $('bgBtn').textContent = 'Background';
    updateDistance(); renderNearby(st); markListProgress();
  }
  function updateDistance() {
    const st = S.stops[S.displayIdx]; if (!st) return;
    if (S.progressKm === null) { $('stopDistance').textContent = ''; return; }
    const dKm = st.km - S.progressKm;
    if (dKm > 0.04) {
      const pace = paceKmh();
      $('stopDistance').textContent = `${fmtKm(dKm)} along the route · about ${fmtMin(dKm / pace * 60)}`;
    } else if (dKm > -0.15) { $('stopDistance').textContent = 'You are here'; }
    else { $('stopDistance').textContent = `${fmtKm(-dKm)} behind you`; }
  }
  function renderNearby(st) {
    const list = S.stops.filter(s => s !== st && s.kind === 'minor' && Math.abs(s.km - st.km) < 0.3);
    $('nearby').classList.toggle('hidden', !list.length);
    const ul = $('nearbyList'); ul.innerHTML = '';
    list.forEach(s => { const li = document.createElement('li'); li.innerHTML = `<strong></strong> <span class="hint"></span><br><span></span>`;
      li.querySelector('strong').textContent = s.name; li.querySelector('.hint').textContent = s.off > 30 ? `(${s.off} m off route)` : '';
      li.querySelector('span:last-child').textContent = s.talk; ul.appendChild(li); });
  }
  function paceKmh() {
    const h = S.history; if (h.length < 2) return 4;
    const dt = (h[h.length - 1].ts - h[0].ts) / 3600000, dk = h[h.length - 1].km - h[0].km;
    if (dt < 2 / 60) return 4;
    const v = dk / dt; return v > 1.5 && v < 7 ? v : 4;
  }

  /* ---------- schedule ---------- */
  const tmin = (t) => { const [h, m] = t.split(/[:.]/).map(Number); return h * 60 + m; };
  function isWalkDay() { return S.route && S.route.date === new Date().toISOString().slice(0, 10); }
  // Planned time window [early, late] in minutes at a given km. Rows sharing a km (arrive/leave) form a dwell window.
  function plannedWindowAtKm(km) {
    const dp = S.route.dayplan; if (!dp || !dp.length) return null;
    const near = dp.filter(r => Math.abs(r.km - km) < 0.05);
    if (near.length) return [tmin(near[0].time), tmin(near[near.length - 1].time)];
    if (km <= dp[0].km) return [tmin(dp[0].time), tmin(dp[0].time)];
    let A = dp[0], B = dp[dp.length - 1];
    for (const r of dp) { if (r.km <= km) A = r; }
    B = dp.find(r => r.km > km) || dp[dp.length - 1];
    if (B.km <= A.km) return [tmin(B.time), tmin(B.time)];
    const t = tmin(A.time) + (km - A.km) / (B.km - A.km) * (tmin(B.time) - tmin(A.time));
    return [t, t];
  }
  function scheduleDelta() { // minutes ahead (+) or behind (-)
    if (S.progressKm === null) return null;
    const win = plannedWindowAtKm(S.progressKm); if (win === null) return null;
    const now = new Date(); let actual;
    if (S.walkStart) actual = tmin(S.route.dayplan[0].time) + (Date.now() - S.walkStart) / 60000;
    else if (isWalkDay()) actual = now.getHours() * 60 + now.getMinutes();
    else return null;
    if (actual < win[0]) return win[0] - actual;
    if (actual > win[1]) return win[1] - actual;
    return 0;
  }
  function updateStatus() {
    const total = S.cum.length ? S.cum[S.cum.length - 1] : 0;
    $('progressText').textContent = `${(S.progressKm || 0).toFixed(1)} / ${total.toFixed(1)} km`;
    const d = scheduleDelta();
    $('scheduleText').textContent = d === null ? '' : Math.abs(d) < 5 ? 'On time' : d > 0 ? `${Math.round(d)} min ahead` : `${Math.round(-d)} min behind`;
    renderPlanProgress();
  }

  /* ---------- speech & sound ---------- */
  let audioCtx = null;
  function unlockAudio() { try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) { /* no audio */ } }
  function chime() {
    try { unlockAudio(); const t0 = audioCtx.currentTime;
      [[660, 0], [880, 0.18]].forEach(([f, dt]) => { const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.frequency.value = f; o.type = 'sine'; g.gain.setValueAtTime(0.0001, t0 + dt); g.gain.exponentialRampToValueAtTime(0.25, t0 + dt + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.35); o.connect(g).connect(audioCtx.destination); o.start(t0 + dt); o.stop(t0 + dt + 0.4); });
    } catch (e) { /* ignore */ }
  }
  function speak(st) {
    if (!('speechSynthesis' in window)) { toast('Reading aloud is not available on this phone.'); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(st.name + '. ' + (st.talk || ''));
    u.lang = 'en-GB'; u.rate = S.settings.rate;
    const v = speechSynthesis.getVoices().find(v => v.lang === 'en-GB') || speechSynthesis.getVoices().find(v => /^en/.test(v.lang));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  }

  /* ---------- wake lock ---------- */
  async function requestWake() {
    if (!S.settings.wakeLock || !('wakeLock' in navigator)) return;
    try { S.wakeSentinel = await navigator.wakeLock.request('screen'); } catch (e) { /* refused */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.watchId !== null) requestWake(); });

  /* ---------- practice ---------- */
  function startPractice() {
    S.practice = true; $('practicePanel').classList.remove('hidden'); $('startPanel').classList.add('hidden');
    $('gpsStatus').className = 'gps weak'; $('gpsStatus').textContent = 'Practice';
    if (S.watchId !== null) { navigator.geolocation.clearWatch(S.watchId); S.watchId = null; }
    S.lastIdx = null; S.progressKm = null; S.shown.clear(); S.history = [];
    unlockAudio(); practiceMove(parseFloat($('practiceSlider').value));
  }
  function stopPractice() { if (!S.practice) return; S.practice = false; $('practicePanel').classList.add('hidden'); S.shown.clear(); S.progressKm = null; S.lastIdx = null; }
  function practiceMove(km) {
    $('practiceKm').textContent = km.toFixed(2) + ' km';
    handlePosition(pointAtKm(km), 5, Date.now());
  }

  /* ---------- lists ---------- */
  function renderStopList() {
    const box = $('stopList'); box.innerHTML = '';
    let lastStage = null;
    S.stops.forEach((st, i) => {
      if (st.kind === 'minor' && S.view === 'walker' && st.type === 'Navigation') return;
      const stage = (S.route.stages || []).find(s => st.km >= s.km_from - 0.05 && st.km <= s.km_to + 0.05);
      if (stage && stage.n !== lastStage) { lastStage = stage.n; const h = document.createElement('div'); h.className = 'stage-h'; h.textContent = `Stage ${stage.n}: ${stage.title}`; box.appendChild(h); }
      const b = document.createElement('button'); b.className = 'stopitem ' + st.kind; b.dataset.idx = i;
      b.innerHTML = '<span class="km"></span><span class="nm"></span>';
      b.querySelector('.km').textContent = st.km.toFixed(1);
      b.querySelector('.nm').textContent = st.name + (st.off > 100 ? ` (${st.off} m off)` : '');
      b.onclick = () => { S.follow = false; showStop(i, st.kind === 'main' ? 'Stop' : 'Point'); switchTab('now'); };
      box.appendChild(b);
    });
  }
  function markListProgress() {
    document.querySelectorAll('.stopitem').forEach(b => {
      const st = S.stops[+b.dataset.idx];
      b.classList.toggle('done', S.progressKm !== null && st.km < S.progressKm - 0.1);
      b.classList.toggle('current', +b.dataset.idx === S.displayIdx);
    });
  }
  function renderPlan() {
    const dp = S.route.dayplan || [];
    const rows = dp.map((r, i) => `<tr data-i="${i}"><td>${r.time.replace(':', '.')}</td><td>${r.km.toFixed(1)}</td><td></td></tr>`).join('');
    $('planTable').innerHTML = `<table><thead><tr><th>Time</th><th>km</th><th>Where</th></tr></thead><tbody>${rows}</tbody></table>`;
    dp.forEach((r, i) => { $('planTable').querySelector(`tr[data-i="${i}"] td:last-child`).textContent = r.label; });
    const sun = S.route.sunset ? ` Sunset ${S.route.sunset.replace(':', '.')}.` : '';
    $('planHint').textContent = (isWalkDay() ? 'Today is the walk day, so ahead/behind uses the clock.' : 'Not the walk day: tap the button at the real start to track ahead/behind.') + sun;
  }
  function renderPlanProgress() {
    if (!S.route) return; const km = S.progressKm;
    document.querySelectorAll('#planTable tbody tr').forEach(tr => {
      const r = S.route.dayplan[+tr.dataset.i];
      tr.classList.toggle('past', km !== null && r.km < km - 0.1);
    });
  }
  function renderNotes() {
    const idx = $('notesIndex'), body = $('notesBody'); idx.innerHTML = '<h2>Leader notes</h2>'; body.innerHTML = '';
    (S.route.leader || []).forEach(sec => {
      const b = document.createElement('button'); b.className = 'btn small'; b.textContent = sec.title; b.style.margin = '4px 6px 4px 0';
      b.onclick = () => document.getElementById('note-' + sec.id).scrollIntoView({ behavior: 'smooth' });
      idx.appendChild(b);
      const c = document.createElement('div'); c.className = 'card notes'; c.id = 'note-' + sec.id;
      c.innerHTML = `<h2></h2>` + sec.html; c.querySelector('h2').textContent = sec.title; body.appendChild(c);
    });
  }

  /* ---------- map ---------- */
  const typeColour = { History: '#b5542f', Shipwreck: '#8b2b3a', Geology: '#2f7d4a', Folklore: '#8a4bb0', Facilities: '#55626b', Navigation: '#1f6f8b', Viewpoint: '#c48a12' };
  function tileUrl() { return S.settings.osKey ? `https://api.os.uk/maps/raster/v1/zxy/Outdoor_3857/{z}/{x}/{y}.png?key=${encodeURIComponent(S.settings.osKey)}` : null; }
  function ensureMap() {
    if (S.map) { setTimeout(() => S.map.invalidateSize(), 50); return; }
    S.map = L.map('map', { zoomControl: true, maxZoom: 18, minZoom: 10 });
    const url = tileUrl();
    // Free fallback: OpenStreetMap standard tiles (no key). Tiles are cached as they are viewed, never bulk-downloaded.
    const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxNativeZoom: 19, maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' });
    if (url) {
      const os = L.tileLayer(url, { maxNativeZoom: 16, maxZoom: 18, minZoom: 7, attribution: `Contains OS data &copy; Crown copyright and database rights ${new Date().getFullYear()}` }).addTo(S.map);
      L.control.layers({ 'OS map': os, 'OpenStreetMap': osm }, null, { position: 'topright' }).addTo(S.map);
      $('mapNote').textContent = '';
    } else {
      osm.addTo(S.map);
      $('mapNote').textContent = 'OpenStreetMap: needs signal, keeps areas you have viewed.';
    }
    const line = L.polyline(S.route.track, { color: '#5a3fb0', weight: 5, opacity: 0.85 }).addTo(S.map);
    S.map.fitBounds(line.getBounds(), { padding: [20, 20] });
    S.stops.forEach((st, i) => {
      const m = L.circleMarker([st.lat, st.lon], { radius: st.kind === 'main' ? 8 : 5, color: '#fff', weight: 2, fillColor: typeColour[st.type] || '#444', fillOpacity: 1 }).addTo(S.map);
      const div = document.createElement('div'); div.innerHTML = '<strong></strong><br><span class="hint"></span><br>';
      div.querySelector('strong').textContent = st.name; div.querySelector('.hint').textContent = `${st.km.toFixed(1)} km · ${st.type}`;
      const btn = document.createElement('button'); btn.className = 'btn small'; btn.textContent = 'Open notes';
      btn.onclick = () => { S.follow = false; showStop(i, 'Stop'); switchTab('now'); }; div.appendChild(btn);
      m.bindPopup(div);
    });
    L.marker(S.route.track[0], { title: 'Start' }).addTo(S.map).bindPopup('Start and finish');
    S.map.on('dragstart', () => { S.mapFollow = false; });
    setTimeout(() => S.map.invalidateSize(), 50);
    updateMapMe();
  }
  function updateMapMe() {
    if (!S.map || !S.fix) return;
    const p = S.fix.p;
    if (!S.meMarker) {
      S.meMarker = L.marker(p, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 }).addTo(S.map);
      S.accCircle = L.circle(p, { radius: S.fix.acc, color: '#2a7de1', weight: 1, fillOpacity: 0.08 }).addTo(S.map);
    } else { S.meMarker.setLatLng(p); S.accCircle.setLatLng(p).setRadius(S.fix.acc); }
    if (S.mapFollow) S.map.panTo(p, { animate: true });
  }

  /* ---------- offline ---------- */
  function lon2x(lon, z) { return Math.floor((lon + 180) / 360 * 2 ** z); }
  function lat2y(lat, z) { const r = lat * rad; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); }
  async function downloadOffline() {
    const out = $('dlProgress');
    if (!('caches' in window)) { out.textContent = 'This browser cannot save files for offline use.'; return; }
    if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch (e) { /* ignore */ } }
    // app shell and route data
    out.textContent = 'Saving app and walk notes…';
    try {
      const reg = await navigator.serviceWorker?.ready;
      const data = await caches.open('wc-data-v1');
      await data.addAll(['routes/index.json', ...[...document.getElementById('routeSelect').options].map(o => `routes/${o.value}.json`)]);
      if (reg && reg.active) reg.active.postMessage({ type: 'precache' });
    } catch (e) { out.textContent = 'Could not save the walk notes: ' + e.message; return; }
    const key = S.settings.osKey;
    if (!key) { out.textContent = 'App and walk notes saved. Without an OS key the map is OpenStreetMap, which cannot be saved in bulk. To keep it for offline, open the Map tab now and zoom in along the whole route: the areas you view are kept on this phone.'; LS.set('offlineSaved.' + S.route.id, new Date().toISOString()); offlineHint(); return; }
    const [s, w, n, e] = S.route.bbox; const pad = 0.01;
    const zmin = CFG.OFFLINE_MIN_ZOOM || 12, zmax = CFG.OFFLINE_MAX_ZOOM || 16;
    const list = [];
    for (let z = zmin; z <= zmax; z++) {
      for (let x = lon2x(w - pad, z); x <= lon2x(e + pad, z); x++)
        for (let y = lat2y(n + pad, z); y <= lat2y(s - pad, z); y++) list.push([z, x, y]);
    }
    const cache = await caches.open('wc-tiles-v1');
    let done = 0, failed = 0;
    const worker = async () => {
      while (list.length) {
        const [z, x, y] = list.shift();
        const clean = `https://api.os.uk/maps/raster/v1/zxy/Outdoor_3857/${z}/${x}/${y}.png`;
        try {
          if (!(await cache.match(clean))) {
            const r = await fetch(clean + '?key=' + encodeURIComponent(key));
            if (r.ok) await cache.put(clean, r); else failed++;
          }
        } catch (err) { failed++; }
        done++; if (done % 10 === 0) out.textContent = `Saving map tiles: ${done} done${failed ? `, ${failed} failed` : ''}…`;
      }
    };
    const total = list.length;
    await Promise.all([worker(), worker(), worker(), worker()]);
    out.textContent = failed ? `Saved ${total - failed} of ${total} map tiles. ${failed} failed: check the key and try again.` : `All set: app, walk notes and ${total} map tiles saved on this phone.`;
    LS.set('offlineSaved.' + S.route.id, new Date().toISOString());
    offlineHint();
  }
  function offlineHint() {
    const t = LS.get('offlineSaved.' + (S.route && S.route.id), null);
    $('offlineHint').textContent = t ? `Saved for offline on ${new Date(t).toLocaleDateString('en-GB')}.` : 'Before the walk: Settings → Save walk and map for offline.';
  }
  function registerSW() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* not available */ });
  }

  /* ---------- tabs & UI ---------- */
  function switchTab(name) {
    document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
    if (name === 'map') ensureMap();
  }
  function bindUI() {
    document.querySelectorAll('.tabbar button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
    $('viewToggle').onclick = () => { S.view = S.view === 'leader' ? 'walker' : 'leader'; LS.set('view', S.view); applyView(); renderStopList(); markListProgress(); };
    $('startGps').onclick = startGps;
    $('practiceBtn').onclick = startPractice;
    $('practiceOff').onclick = () => { stopPractice(); $('startPanel').classList.remove('hidden'); $('gpsStatus').className = 'gps off'; $('gpsStatus').textContent = 'GPS off'; };
    $('practiceSlider').oninput = (e) => practiceMove(parseFloat(e.target.value));
    $('readBtn').onclick = () => { unlockAudio(); const st = S.stops[S.displayIdx]; if (st) speak(st); };
    $('bgBtn').onclick = () => { const bg = $('stopBackground'); bg.classList.toggle('hidden'); $('bgBtn').textContent = bg.classList.contains('hidden') ? 'Background' : 'Hide background'; };
    $('prevStop').onclick = () => { S.follow = false; const i = findMain(S.displayIdx, -1); if (i >= 0) showStop(i, 'Stop'); };
    $('nextStop').onclick = () => { S.follow = false; const i = findMain(S.displayIdx, +1); if (i >= 0) showStop(i, 'Stop'); };
    $('followBtn').onclick = () => { S.follow = true; S.displayIdx = null; followDisplay(); if (S.progressKm === null) showStop(0, 'Start'); };
    $('centreMe').onclick = () => { S.mapFollow = true; if (S.fix && S.map) S.map.setView(S.fix.p, Math.max(S.map.getZoom(), 15)); };
    $('markStart').onclick = () => { S.walkStart = Date.now(); LS.set('start.' + S.route.id, S.walkStart); toast('Walk start set to ' + hhmm(new Date())); updateStatus(); };
    // settings
    const st = S.settings;
    $('autoRead').checked = st.autoRead; $('chime').checked = st.chime; $('wakeLock').checked = st.wakeLock;
    $('radius').value = st.radius; $('radiusVal').textContent = st.radius; $('rate').value = st.rate; $('rateVal').textContent = (+st.rate).toFixed(2);
    $('osKey').value = st.osKey || '';
    $('autoRead').onchange = (e) => { st.autoRead = e.target.checked; LS.set('autoRead', st.autoRead); };
    $('chime').onchange = (e) => { st.chime = e.target.checked; LS.set('chime', st.chime); };
    $('wakeLock').onchange = (e) => { st.wakeLock = e.target.checked; LS.set('wakeLock', st.wakeLock); if (st.wakeLock) requestWake(); };
    $('radius').oninput = (e) => { st.radius = +e.target.value; $('radiusVal').textContent = st.radius; LS.set('radius', st.radius); };
    $('rate').oninput = (e) => { st.rate = +e.target.value; $('rateVal').textContent = st.rate.toFixed(2); LS.set('rate', st.rate); };
    $('osKey').onchange = (e) => { st.osKey = e.target.value.trim(); LS.set('osKey', st.osKey); toast('Map key saved. Reopen the Map tab to load the map.'); if (S.map) { S.map.remove(); S.map = null; S.meMarker = null; } };
    $('downloadMap').onclick = downloadOffline;
    setInterval(() => { updateStatus(); if (S.follow) updateDistance(); }, 30000);
  }
  function findMain(from, dir) { let i = (from === null ? 0 : from) + dir; while (i >= 0 && i < S.stops.length) { if (S.stops[i].kind === 'main') return i; i += dir; } return -1; }

  // test hook for automated checks
  window.__wc = { S, handlePosition, pointAtKm };
  init();
})();
