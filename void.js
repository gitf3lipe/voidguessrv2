(function () {
  'use strict';

  let autoGuess = false;
  let lastKey = '';
  let capCount = 0;
  let currentLat = null;
  let currentLng = null;
  let guessTimer = null;
  let isGuessing = false;

  function scanAllIframes() {
    for (const f of document.querySelectorAll('iframe')) {
      const src = f.src || f.getAttribute('src') || '';
      if (!src.includes('location=')) continue;
      const m = src.match(/[?&]location=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
      if (!m) continue;
      const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
      if (!isNaN(lat) && !isNaN(lng)) return { lat: lat.toFixed(6), lng: lng.toFixed(6) };
    }
    return null;
  }

  async function reverseGeocode(lat, lng) {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`, { headers: { 'Accept-Language': 'en' } });
      const d = await r.json();
      return {
        street: [d.address?.road, d.address?.house_number].filter(Boolean).join(' ') || null,
        city: d.address?.city || d.address?.town || d.address?.village || d.address?.county || null,
        country: d.address?.country || null,
        countryCode: d.address?.country_code?.toUpperCase() || null,
      };
    } catch { return null; }
  }

  function getMapInfo() {
    const container = document.querySelector('.leaflet-container');
    if (!container) return null;
    const pane = container.querySelector('.leaflet-map-pane');
    if (!pane) return null;
    const pt = pane.style.transform.match(/translate3d\((-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px/);
    if (!pt) return null;
    let tileData = null;
    for (const t of container.querySelectorAll('.leaflet-tile')) {
      const sm = t.src.match(/[?&]x=(\d+)&y=(\d+)&z=(\d+)/);
      const tm = t.style.transform.match(/translate3d\((-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px/);
      if (sm && tm) { tileData = { tileX: parseInt(sm[1]), tileY: parseInt(sm[2]), zoom: parseInt(sm[3]), pixX: parseFloat(tm[1]), pixY: parseFloat(tm[2]) }; break; }
    }
    if (!tileData) return null;
    return { paneX: parseFloat(pt[1]), paneY: parseFloat(pt[2]), tileData, container };
  }

  function latLngToPixel(lat, lng) {
    const info = getMapInfo();
    if (!info) return null;
    const { paneX, paneY, tileData, container } = info;
    const TILE = 256, n = Math.pow(2, tileData.zoom);
    const latRad = lat * Math.PI / 180;
    const gx = (lng + 180) / 360 * n;
    const gy = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
    const cx = tileData.pixX + (gx * TILE - tileData.tileX * TILE) + paneX;
    const cy = tileData.pixY + (gy * TILE - tileData.tileY * TILE) + paneY;
    const rect = container.getBoundingClientRect();
    const margin = 10;
    const clampX = Math.max(margin, Math.min(rect.width - margin, cx));
    const clampY = Math.max(margin, Math.min(rect.height - margin, cy));
    return { containerX: clampX, containerY: clampY, clientX: rect.left + clampX, clientY: rect.top + clampY, container, rect };
  }

  let cur = null;
  function moveCursor(x, y) {
    if (!cur) { cur = document.createElement('div'); cur.style.cssText = 'position:fixed;width:1px;height:1px;pointer-events:none;z-index:2147483646;'; document.body.appendChild(cur); }
    cur.style.left = x + 'px'; cur.style.top = y + 'px';
    const el = document.elementFromPoint(x, y);
    if (el) el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
  }

  async function expandMap() {
    const c = document.querySelector('.leaflet-container');
    if (!c) return;
    const r = c.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    moveCursor(cx, cy);
    let el = c;
    while (el && el !== document.body) {
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: cx, clientY: cy }));
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, clientX: cx, clientY: cy }));
      el = el.parentElement;
    }
    await sleep(800);
  }

  function fullClick(el, clientX, clientY, offsetX, offsetY) {
    const o = { bubbles: true, cancelable: true, clientX, clientY, offsetX: offsetX ?? clientX, offsetY: offsetY ?? clientY, button: 0, buttons: 1 };
    el.dispatchEvent(new MouseEvent('pointerdown', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  }

  // Click a button by its element ID, polling until it appears or timeout
  async function waitAndClickById(id, timeoutMs = 4000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = document.getElementById(id);
      if (el && !el.disabled && el.offsetParent !== null) {
        const r = el.getBoundingClientRect();
        if (r.width > 0) {
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          moveCursor(cx, cy);
          await sleep(60);
          fullClick(el, cx, cy);
          el.click();
          console.log(`[VoidGuessr] Clicked #${id}`);
          return true;
        }
      }
      await sleep(150);
    }
    console.log(`[VoidGuessr] Element #${id} not found within ${timeoutMs}ms`);
    return false;
  }

  async function runAutoGuess(lat, lng, manual = false) {
    if (!manual && !autoGuess) return;
    if (isGuessing) return;
    isGuessing = true;
    try {
      lat = parseFloat(lat); lng = parseFloat(lng);

      setStatus('🗺 Expanding map...', 'good');
      await expandMap();
      if (!manual && !autoGuess) return;

      setStatus('📍 Placing pin...', 'good');
      await sleep(100);
      const px = latLngToPixel(lat, lng);
      if (!px) { setStatus('⚠ No map tiles', 'warn'); return; }

      moveCursor(px.clientX, px.clientY);
      await sleep(80);
      if (!manual && !autoGuess) return;

      fullClick(px.container, px.clientX, px.clientY, px.containerX, px.containerY);
      setStatus('✓ Pin placed — waiting for Confirm...', 'good');

      await sleep(400);
      if (!manual && !autoGuess) return;

      // Click confirmButton
      setStatus('🔍 Clicking Confirm button...', 'good');
      const confirmed = await waitAndClickById('confirmButton', 5000);
      if (!confirmed) {
        setStatus('⚠ confirmButton never appeared', 'warn');
        return;
      }

      setStatus('✓ Confirmed! Waiting for results...', 'good');

      // Click nextRound
      await sleep(500);
      if (!manual && !autoGuess) return;

      setStatus('🔍 Clicking Next Round...', 'good');
      const nexted = await waitAndClickById('nextRound', 8000);
      if (nexted) {
        setStatus('✓ Next round started!', 'good');
      } else {
        setStatus('⚠ nextRound button never appeared', 'warn');
      }

    } catch(e) {
      setStatus('⚠ ' + e.message, 'warn');
      console.error('[VoidGuessr]', e);
    } finally {
      isGuessing = false;
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function setStatus(msg, type = '') {
    const el = document.getElementById('vg13s');
    if (!el) return;
    el.textContent = msg; el.className = type;
  }

  function tick() {
    const loc = scanAllIframes();
    if (!loc) return;
    const key = `${loc.lat},${loc.lng}`;
    if (key === lastKey) return;
    lastKey = key; currentLat = loc.lat; currentLng = loc.lng;
    capCount++; isGuessing = false;
    updateUI({ ...loc, loading: true });
    if (autoGuess) {
      clearTimeout(guessTimer);
      guessTimer = setTimeout(() => { if (autoGuess) runAutoGuess(currentLat, currentLng); }, 1500);
    }
    reverseGeocode(loc.lat, loc.lng).then(geo => { if (geo) updateUI({ lat: loc.lat, lng: loc.lng, ...geo, loading: false }); });
  }

  setInterval(tick, 300);

  function flagEmoji(code) {
    if (!code || code.length !== 2) return '🌍';
    return String.fromCodePoint(...[...code.toUpperCase()].map(c => 0x1F1E6 - 65 + c.charCodeAt(0)));
  }

  function injectUI() {
    if (document.getElementById('vg13')) return;
    const s = document.createElement('style');
    s.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@900&display=swap');
      #vg13{position:fixed;top:18px;right:18px;z-index:2147483647;width:315px;
        background:#080010;border:1px solid #7700ee;border-radius:12px;
        box-shadow:0 0 30px #6600cc44,inset 0 0 40px #11002244;
        font-family:'Share Tech Mono',monospace;color:#d9aaff;}
      #vg13.min #vg13b{display:none}
      #vg13h{background:linear-gradient(135deg,#150030,#280060,#100025);
        border-bottom:1px solid #4400aa;padding:11px 14px;border-radius:12px 12px 0 0;
        display:flex;align-items:center;gap:8px;cursor:move;user-select:none;}
      #vg13t{font-family:'Orbitron',sans-serif;font-weight:900;font-size:13px;letter-spacing:3px;flex:1;
        background:linear-gradient(90deg,#cc88ff,#fff,#8833ff);
        -webkit-background-clip:text;-webkit-text-fill-color:transparent;}
      #vg13d{width:9px;height:9px;border-radius:50%;background:#1a0033;transition:all .5s;flex-shrink:0}
      #vg13d.on{background:#bb44ff;box-shadow:0 0 8px #bb44ff,0 0 20px #8800ff;animation:vgp13 2s ease-in-out infinite}
      @keyframes vgp13{0%,100%{opacity:1}50%{opacity:.3}}
      #vg13m{background:none;border:1px solid #4400aa;color:#8855bb;font-size:12px;cursor:pointer;
        border-radius:4px;width:22px;height:22px;display:flex;align-items:center;justify-content:center;
        transition:all .2s;font-family:monospace;flex-shrink:0}
      #vg13m:hover{color:#cc88ff;border-color:#8800ff}
      #vg13b{padding:14px;}
      .g13l{font-size:8px;letter-spacing:3px;text-transform:uppercase;color:#5522aa;margin-bottom:4px}
      .g13v{font-size:12px;color:#e8ccff;line-height:1.4;word-break:break-all}
      .g13v.big{font-family:'Orbitron',sans-serif;font-size:12px;font-weight:900;color:#fff;letter-spacing:1px}
      .g13v.coord{font-size:11px;color:#cc88ff}
      .g13d{height:1px;background:linear-gradient(90deg,transparent,#4400aa55,transparent);margin:9px 0}
      .g13s{margin-bottom:8px}
      #vg13w{text-align:center;padding:20px 0 14px;color:#3d1a66;font-size:10px;letter-spacing:2px}
      .g13sp{font-size:22px;display:block;margin-bottom:8px;animation:gs13 3s linear infinite;color:#4411aa}
      @keyframes gs13{from{transform:rotate(0)}to{transform:rotate(360deg)}}
      #vg13loc{display:none}
      #vg13ld{font-size:9px;color:#6633aa;margin-top:3px;display:none}
      #vg13mb{display:block;width:100%;padding:9px;margin-top:8px;box-sizing:border-box;
        background:linear-gradient(135deg,#220055,#4400aa);border:1px solid #6600ee;
        border-radius:7px;color:#ddaaff;font-family:'Orbitron',sans-serif;font-size:9px;
        letter-spacing:2px;cursor:pointer;text-align:center;text-decoration:none;transition:all .25s}
      #vg13mb:hover{background:linear-gradient(135deg,#3a0099,#7700ff);transform:translateY(-1px);color:#fff}
      #vg13gn{display:none;width:100%;padding:9px;margin-top:6px;box-sizing:border-box;
        background:linear-gradient(135deg,#003322,#006644);border:1px solid #00cc77;
        border-radius:7px;color:#aaffcc;font-family:'Orbitron',sans-serif;font-size:9px;
        letter-spacing:2px;cursor:pointer;text-align:center;transition:all .25s}
      #vg13gn:hover{background:linear-gradient(135deg,#005533,#00aa66);color:#fff;transform:translateY(-1px)}
      #vg13ab{display:flex;align-items:center;gap:10px;margin-top:10px;
        padding:9px 12px;border-radius:8px;border:1px solid #330066;
        background:#0d0020;cursor:pointer;transition:all .2s}
      #vg13ab:hover{border-color:#6600cc;background:#150030}
      #vg13ab.on{border-color:#aa00ff;background:#180035;box-shadow:0 0 12px #7700ff33}
      #vg13al{font-family:'Orbitron',sans-serif;font-size:9px;letter-spacing:2px;color:#7744aa;flex:1;transition:color .2s}
      #vg13ab.on #vg13al{color:#dd99ff}
      .g13sw{width:32px;height:18px;border-radius:9px;background:#220044;border:1px solid #440088;position:relative;transition:all .3s;flex-shrink:0}
      #vg13ab.on .g13sw{background:#7700ff;border-color:#aa44ff;box-shadow:0 0 8px #7700ff88}
      .g13kn{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#553388;transition:all .3s}
      #vg13ab.on .g13kn{left:16px;background:#fff;box-shadow:0 0 6px #fff8}
      #vg13s{font-size:9px;color:#553388;margin-top:5px;min-height:13px;letter-spacing:1px}
      #vg13s.good{color:#aa55ff}
      #vg13s.warn{color:#ff8833}
      #vg13c{font-size:8px;color:#3d1a66;text-align:right;margin-top:6px;letter-spacing:2px}
    `;
    document.head.appendChild(s);
    const p = document.createElement('div');
    p.id = 'vg13';
    p.innerHTML = `
      <div id="vg13h"><span id="vg13t">VOIDGUESSR</span><span id="vg13d"></span><button id="vg13m">_</button></div>
      <div id="vg13b">
        <div id="vg13w"><span class="g13sp">◈</span>WAITING FOR ROUND...</div>
        <div id="vg13loc">
          <div class="g13s"><div class="g13l">◆ Country</div><div class="g13v big" id="vg13co">—</div></div>
          <div class="g13d"></div>
          <div class="g13s"><div class="g13l">◆ Street</div><div class="g13v" id="vg13st">—</div></div>
          <div class="g13s"><div class="g13l">◆ City</div><div class="g13v" id="vg13ci">—</div></div>
          <div class="g13s"><div class="g13l">◆ Coordinates</div><div class="g13v coord" id="vg13xy">—</div></div>
          <div id="vg13ld">⟳ fetching...</div>
          <a id="vg13mb" href="#" target="_blank">⟐ OPEN IN GOOGLE MAPS</a>
          <button id="vg13gn">⚡ GUESS NOW</button>
        </div>
        <div id="vg13ab"><span id="vg13al">AUTO GUESSER</span><div class="g13sw"><div class="g13kn"></div></div></div>
        <div id="vg13s">○ Auto-guesser off</div>
        <div id="vg13c">captures: 0</div>
      </div>`;
    document.body.appendChild(p);

    document.getElementById('vg13ab').addEventListener('click', () => {
      autoGuess = !autoGuess;
      document.getElementById('vg13ab').classList.toggle('on', autoGuess);
      if (autoGuess) {
        setStatus('⚡ Auto-guesser ON', 'good');
        if (currentLat && currentLng && !isGuessing) {
          clearTimeout(guessTimer);
          guessTimer = setTimeout(() => { if (autoGuess) runAutoGuess(currentLat, currentLng); }, 500);
        }
      } else {
        clearTimeout(guessTimer);
        guessTimer = null;
        setStatus('○ Auto-guesser off', '');
      }
    });

    document.getElementById('vg13gn').addEventListener('click', () => {
      if (currentLat && currentLng) runAutoGuess(currentLat, currentLng, true);
      else setStatus('⚠ No location yet', 'warn');
    });

    let min = false;
    document.getElementById('vg13m').onclick = () => {
      min = !min; p.classList.toggle('min', min);
      document.getElementById('vg13m').textContent = min ? '□' : '_';
    };

    document.getElementById('vg13h').addEventListener('mousedown', e => {
      if (e.target.id === 'vg13m') return; e.preventDefault();
      const sx=e.clientX, sy=e.clientY, r=p.getBoundingClientRect(), ox=r.left, oy=r.top;
      const mv = e2 => { p.style.right='auto'; p.style.left=(ox+e2.clientX-sx)+'px'; p.style.top=(oy+e2.clientY-sy)+'px'; };
      const up = () => { removeEventListener('mousemove',mv); removeEventListener('mouseup',up); };
      addEventListener('mousemove',mv); addEventListener('mouseup',up);
    });
  }

  function updateUI(info) {
    if (!info.loading) document.getElementById('vg13c').textContent = `captures: ${capCount}`;
    document.getElementById('vg13d').classList.add('on');
    document.getElementById('vg13w').style.display = 'none';
    document.getElementById('vg13loc').style.display = 'block';
    document.getElementById('vg13gn').style.display = 'block';
    document.getElementById('vg13ld').style.display = info.loading ? 'block' : 'none';
    document.getElementById('vg13co').textContent = info.country ? `${flagEmoji(info.countryCode)} ${info.country}` : '🌍 Detecting...';
    document.getElementById('vg13st').textContent = info.street || (info.loading ? '⟳' : '—');
    document.getElementById('vg13ci').textContent = info.city || (info.loading ? '⟳' : '—');
    document.getElementById('vg13xy').textContent = `${info.lat}°, ${info.lng}°`;
    document.getElementById('vg13mb').href = `https://www.google.com/maps?q=${info.lat},${info.lng}`;
    document.getElementById('vg13mb').style.display = 'block';
  }

  injectUI();
  tick();
  console.log('%c[VoidGuessr v13] ✓ Ready!', 'color:#aa55ff;font-size:14px;font-family:monospace;font-weight:bold');
})();
