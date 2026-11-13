const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { images: [], audio: null, gps: null, caseId: null, lang: 'lg', status: null, lastBody: null, busy: false };

// ---------- boot ----------
(async function boot() {
  const st = await fetch('/api/status').then(r => r.json()).catch(() => null);
  state.status = st;
  const pill = $('#modePill');
  if (!st) { pill.querySelector('span').textContent = 'offline'; return; }
  pill.querySelector('span').textContent = st.mock ? 'DEMO MODE' : `LIVE · ${st.models.text.replace('gemini-', 'Gemini ')}`;
  pill.className = 'pill ' + (st.mock ? 'mock' : 'live');
  const seg = $('#langSeg');
  Object.entries(st.languages).forEach(([code, name]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.code = code;
    b.textContent = name.replace(/\s*\(.*\)/, '');
    b.setAttribute('aria-checked', String(code === state.lang));
    b.onclick = () => { state.lang = code; $$('#langSeg button').forEach(x => x.setAttribute('aria-checked', String(x === b))); markSteps(); };
    seg.append(b);
  });
  markSteps();
})();

// ---------- light / dark theme ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]').content = t === 'light' ? '#f4f3ef' : '#070708';
  $('#themeBtn').setAttribute('aria-label', t === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
}
applyTheme(document.documentElement.dataset.theme || 'dark');
$('#themeBtn').onclick = () => {
  const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(t);
  try { localStorage.setItem('sd-theme', t); } catch { /* private mode: theme just won't persist */ }
};

// ---------- tabs with sliding indicator ----------
$$('.tab').forEach(t => t.addEventListener('click', () => {
  $$('.tab').forEach(x => { x.classList.toggle('active', x === t); x.setAttribute('aria-selected', String(x === t)); });
  $('.tabs').dataset.active = t.dataset.tab;
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
  if (t.dataset.tab === 'radar') loadRadar();
}));

// ---------- step completion markers ----------
function markSteps() {
  $('[data-step="1"]').classList.toggle('filled', state.images.length > 0);
  $('[data-step="2"]').classList.toggle('filled', !!state.audio || $('#textInput').value.trim().length > 0);
  $('[data-step="3"]').classList.toggle('filled', !!($('#location').value.trim() || state.gps));
}
$('#textInput').addEventListener('input', markSteps);

// ---------- photos: pick, drag & drop, paste (compressed in-browser) ----------
$('#photoInput').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
const dz = $('#dropzone');
['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', e => addFiles(e.dataTransfer.files));
document.addEventListener('paste', e => {
  const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
  if (files.length && $('#tab-diagnose').classList.contains('active')) addFiles(files);
});

async function addFiles(list) {
  const files = [...list].filter(f => f.type.startsWith('image/')).slice(0, 4 - state.images.length);
  if (!files.length) return;
  for (const f of files) {
    try { state.images.push(await compressImage(f)); } catch { toast('Could not read that image'); }
  }
  renderThumbs();
  toast(`${state.images.length} photo${state.images.length === 1 ? '' : 's'} ready`);
}

function renderThumbs() {
  const box = $('#thumbs');
  box.innerHTML = '';
  state.images.forEach((img, i) => {
    const d = document.createElement('div');
    d.className = 'thumb';
    d.innerHTML = `<img alt="photo ${i + 1}" src="data:${img.mimeType};base64,${img.data}"><span class="n">${i + 1}</span><button type="button" aria-label="Remove photo ${i + 1}">×</button>`;
    d.querySelector('button').onclick = () => { state.images.splice(i, 1); renderThumbs(); };
    box.append(d);
  });
  dz.classList.toggle('full', state.images.length >= 4);
  markSteps();
}

// 1024 px is plenty for leaf symptoms and keeps uploads small on mobile data.
async function compressImage(file, max = 1024) {
  const url = URL.createObjectURL(file);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(url);
  return { mimeType: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.82).split(',')[1] };
}

// ---------- quick examples & crop chips ----------
$$('#quickChips .chip').forEach(c => c.onclick = () => {
  $('#textInput').value = c.dataset.text;
  $('#crop').value = c.dataset.crop;
  syncCropChips(); markSteps();
  $$('#quickChips .chip').forEach(x => x.classList.toggle('on', x === c));
});
$$('#cropChips .chip').forEach(c => c.onclick = () => {
  $('#crop').value = $('#crop').value === c.textContent ? '' : c.textContent;
  syncCropChips();
});
function syncCropChips() { $$('#cropChips .chip').forEach(x => x.classList.toggle('on', x.textContent.toLowerCase() === $('#crop').value.trim().toLowerCase())); }
$('#crop').addEventListener('input', syncCropChips);

// ---------- voice note → 16 kHz mono WAV (universally accepted by Gemini) ----------
let rec, chunks = [], recTimer, recStart;
$('#micBtn').addEventListener('click', async () => {
  const btn = $('#micBtn');
  if (rec && rec.state === 'recording') { rec.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    rec = new MediaRecorder(stream); chunks = [];
    rec.ondataavailable = e => chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      clearInterval(recTimer);
      btn.classList.remove('rec'); btn.setAttribute('aria-pressed', 'false');
      $('#micLabel').textContent = 'Voice note ready · tap to re-record';
      const blob = new Blob(chunks, { type: rec.mimeType });
      const wav = await toWav16k(blob);
      state.audio = { mimeType: 'audio/wav', data: await blobToB64(wav) };
      const p = $('#voicePreview'); p.src = URL.createObjectURL(wav); p.hidden = false;
      markSteps(); toast('Voice note added');
    };
    rec.start(); recStart = Date.now();
    btn.classList.add('rec'); btn.setAttribute('aria-pressed', 'true');
    recTimer = setInterval(() => {
      const s = Math.floor((Date.now() - recStart) / 1000);
      $('#micLabel').textContent = `Recording… ${s}s · tap to stop`;
      if (s >= 45) rec.stop(); // keeps the upload under Vercel's 4.5 MB request limit
    }, 250);
  } catch (e) {
    showError(location.protocol === 'https:' || location.hostname === 'localhost'
      ? 'Microphone not available: ' + e.message
      : 'The microphone needs a secure (https) link on phones. You can still type what you see.');
  }
});

async function toWav16k(blob) {
  const buf = await blob.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await ctx.decodeAudioData(buf);
  const rate = 16000;
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); out.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  w(36, 'data'); out.setUint32(40, pcm.length * 2, true);
  pcm.forEach((v, i) => out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
  ctx.close();
  return new Blob([out], { type: 'audio/wav' });
}
const blobToB64 = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result.split(',')[1]); f.readAsDataURL(b); });

// ---------- GPS ----------
$('#gpsBtn').addEventListener('click', () => {
  const b = $('#gpsBtn'), lab = b.querySelector('span');
  if (!navigator.geolocation) return showError('GPS is not available on this device.');
  lab.textContent = '…';
  navigator.geolocation.getCurrentPosition(p => {
    state.gps = { lat: p.coords.latitude, lon: p.coords.longitude };
    $('#location').value = `My farm (${state.gps.lat.toFixed(3)}, ${state.gps.lon.toFixed(3)})`;
    lab.textContent = 'GPS ✓'; b.classList.add('ok'); markSteps();
  }, err => { lab.textContent = 'GPS'; showError('Could not get GPS: ' + err.message + '. Type your district instead.'); },
  { enableHighAccuracy: true, timeout: 10000 });
});
$('#location').addEventListener('input', () => { state.gps = null; $('#gpsBtn').classList.remove('ok'); $('#gpsBtn span').textContent = 'GPS'; markSteps(); });

// ---------- diagnose (streams live progress from the server) ----------
$('#intake').addEventListener('submit', e => {
  e.preventDefault();
  if (!state.images.length && !state.audio && !$('#textInput').value.trim()) {
    return showError('Add a photo, record a voice note, or type what you see first.');
  }
  state.lastBody = {
    images: state.images, audio: state.audio, text: $('#textInput').value.trim(),
    lang: state.lang, location: state.gps ? 'farmer GPS location' : ($('#location').value.trim() || 'Kampala'),
    gps: state.gps, crop: $('#crop').value.trim(),
  };
  diagnose(state.lastBody);
});
$('#retryBtn').onclick = () => state.lastBody && diagnose(state.lastBody);

async function diagnose(body) {
  if (state.busy) return;
  state.busy = true;
  hide('#error'); hide('#results'); hide('#intake');
  $('#goBtn').disabled = true;
  const prog = startProgress(body);
  try {
    const r = await fetch('/api/diagnose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok || !r.body) {
      const j = await r.json().catch(() => ({}));
      throw Object.assign(new Error(j.error || `Server error (${r.status})`), { retryable: r.status >= 500 });
    }
    let final = null;
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let n;
      while ((n = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, n).trim(); buf = buf.slice(n + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'result') final = ev;
        else if (ev.type === 'error') throw Object.assign(new Error(ev.error), { retryable: ev.retryable });
        else prog.event(ev);
      }
    }
    if (!final) throw Object.assign(new Error('The connection closed before Gemini finished. Please try again.'), { retryable: true });
    prog.finish();
    state.caseId = final.caseId;
    // Sent back with follow-up questions so any server instance can answer them.
    state.chatContext = { result: final.result, location: final.weather?.location || body.location, gps: body.gps, lang: body.lang };
    await new Promise(r => setTimeout(r, 350));
    hide('#thinking');
    renderResults(final);
  } catch (err) {
    hide('#thinking'); show('#intake');
    showError(err.message, err.retryable !== false);
  } finally {
    prog.stop();
    state.busy = false;
    $('#goBtn').disabled = false;
  }
}

function startProgress(body) {
  const steps = Object.fromEntries($$('#thinkSteps li').map(li => [li.dataset.k, li]));
  Object.values(steps).forEach(li => { li.className = ''; li.hidden = false; li.querySelector('small').textContent = ''; });
  steps.look.querySelector('.lbl').textContent = body.images.length ? `Examining your ${body.images.length > 1 ? body.images.length + ' photos' : 'photo'}` : 'Reading your description';
  steps.listen.hidden = !body.audio;
  steps.weather.querySelector('.lbl').textContent = `Checking live weather · ${body.gps ? 'your GPS location' : body.location}`;
  $('#thinkNote').textContent = '';
  const scan = $('#scanBox');
  scan.querySelector('img')?.remove();
  if (body.images[0]) {
    const im = new Image(); im.alt = ''; im.src = `data:${body.images[0].mimeType};base64,${body.images[0].data}`;
    scan.prepend(im);
  }
  scan.querySelector('.scan-ph').hidden = !!body.images[0];
  show('#thinking');
  $('#thinking').scrollIntoView({ behavior: 'smooth', block: 'center' });

  const t0 = performance.now();
  const timer = setInterval(() => { $('#timer').textContent = ((performance.now() - t0) / 1000).toFixed(1) + 's'; }, 100);
  const set = (k, cls, note) => { const li = steps[k]; if (!li || li.hidden) return; li.className = cls; if (note !== undefined) li.querySelector('small').textContent = note; };
  set('look', 'on'); set('listen', 'on');

  return {
    event(ev) {
      if (ev.type === 'tool_call') {
        set('look', 'done'); set('listen', 'done');
        set('weather', 'on', `Gemini called get_weather_forecast · ${ev.model?.replace('gemini-', '') || ''}`);
      } else if (ev.type === 'tool_result') {
        set('weather', 'done', ev.summary);
      } else if (ev.type === 'thinking' && ev.step > 0) {
        set('look', 'done'); set('listen', 'done');
        set('plan', 'on');
      } else if (ev.type === 'backup') {
        $('#thinkNote').textContent = `⚡ Busy model, racing a backup: ${ev.model}`;
      } else if (ev.type === 'note') {
        $('#thinkNote').textContent = ev.text;
      }
    },
    finish() {
      Object.values(steps).forEach(li => { if (!li.hidden) li.className = 'done'; });
      if (!steps.weather.querySelector('small').textContent) steps.weather.querySelector('small').textContent = 'forecast ready';
    },
    stop() { clearInterval(timer); },
  };
}

// ---------- results ----------
const VERDICT = {
  spray: ['✓', 'Spraying is justified'],
  wait_for_window: ['◷', 'Wait for the safe window'],
  do_not_spray: ['✕', "Don't spray"],
  not_needed: ['✓', 'No spraying needed'],
};
const SEV_LEVELS = ['none', 'low', 'moderate', 'high', 'critical'];
const SEV_COL = { none: '#8a8f97', low: '#c9cdd3', moderate: '#d4af37', high: '#e8913a', critical: '#e2574c' };

function renderResults({ result: r, weather: w, trace = [], model, ms, mock }) {
  const d = r.diagnosis || {};
  const sp = r.spray || {};
  const [vIcon, vText] = VERDICT[sp.verdict] || ['?', sp.verdict || ''];
  const conf = Math.max(0, Math.min(100, Math.round((d.confidence || 0) * 100)));
  const sevIdx = Math.max(0, SEV_LEVELS.indexOf(d.severity));
  const C = 2 * Math.PI * 44;
  const box = $('#results');

  box.innerHTML = `
    ${r.plant_visible === false || r.image_quality_note ? `<div class="card notice">📷 ${esc(r.image_quality_note || 'I could not see a plant clearly. Please take a closer, sharper photo in daylight.')}</div>` : ''}

    <div class="card hero">
      <div class="hero-top">
        <div class="grow">
          <span class="crop">${esc(r.crop || 'Your crop')}</span>
          <h2>${esc(d.name)}</h2>
          ${d.local_name ? `<div class="local">${esc(d.local_name)}</div>` : ''}
        </div>
        <div class="ring" title="How sure Gemini is">
          <svg viewBox="0 0 100 100">
            <defs><linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f7e48c"/><stop offset=".5" stop-color="#d4af37"/><stop offset="1" stop-color="#a8841f"/></linearGradient></defs>
            <circle class="trk" cx="50" cy="50" r="44" fill="none" stroke-width="8"/>
            <circle class="val" cx="50" cy="50" r="44" fill="none" stroke-width="8" stroke-dasharray="${C}" stroke-dashoffset="${C}" data-off="${C * (1 - conf / 100)}"/>
          </svg>
          <div class="lab"><div><b data-count="${conf}">0%</b><small>confident</small></div></div>
        </div>
      </div>
      <div class="badges">
        <span class="badge">${esc(d.category)}</span>
        <span class="badge sev sev-${esc(d.severity)}">Severity: ${esc(d.severity)}</span>
        <span class="badge">Spread risk: ${esc(d.spread_risk)}</span>
      </div>
      <div class="sevbar">${SEV_LEVELS.map((s, i) => `<i data-c="${i <= sevIdx ? SEV_COL[d.severity] || '#d4af37' : ''}"></i>`).join('')}</div>
      <div class="sevbar-lab"><span>none</span><span>critical</span></div>
      <div class="listen">
        <button id="speakBtn" class="play" aria-label="Listen to the advice">${playIcon()}</button>
        <p id="farmerMsg">${esc(r.farmer_message)}</p>
      </div>
      ${r.farmer_said_english ? `<p class="said">🎙 You said: “${esc(r.farmer_said_english)}”</p>` : ''}
    </div>

    <div class="card spray v-${esc(sp.verdict)}">
      <div class="verdict">
        <div class="icon">${vIcon}</div>
        <div>
          <h3>${esc(vText)}</h3>
          ${sp.best_window ? `<div class="when">${esc(sp.best_window)}</div>` : ''}
        </div>
      </div>
      <p>${esc(sp.why)}</p>
      ${w?.hourly?.length ? timeline(w) : ''}
      ${(sp.active_ingredients || []).length ? `<span class="label">Active ingredients (if you must spray)</span><div class="chips static">${sp.active_ingredients.map(a => `<span class="chip sm">${esc(a)}</span>`).join('')}</div>` : ''}
      ${(sp.safety || []).length ? `<ul class="safety">${sp.safety.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
      ${r.heat_warning ? `<div class="heat">🌡 ${esc(r.heat_warning)}</div>` : ''}
    </div>

    <div class="grid2">
      <div class="card">
        <div class="card-head"><h3>Do this today</h3><span class="progress-mini" id="doneCount">0/${(r.do_now || []).length}</span></div>
        <div class="pbar"><i id="donePbar"></i></div>
        <ul class="checklist">${(r.do_now || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul>
      </div>
      <div class="card">
        <h3>What Gemini saw</h3>
        <ul class="evidence">${(r.evidence || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul>
        ${(r.alternatives || []).length ? `<details><summary>Other possibilities (${r.alternatives.length})</summary>${r.alternatives.map(a => `<p class="alt"><b>${esc(a.name)}</b>: ${esc(a.why_less_likely)}</p>`).join('')}</details>` : ''}
      </div>
    </div>

    ${r.escalate?.needed ? `<div class="card escalate"><h3>📣 Report to ${esc(r.escalate.to || 'your extension officer')}</h3><p>${esc(r.escalate.why)}</p></div>` : ''}

    ${(r.prevention || []).length ? `<div class="card"><h3>Prevent it next season</h3><ul class="plain">${r.prevention.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}

    <div class="card">
      <h3>Share with your farmer group</h3>
      <div class="sms" id="smsText">${esc(r.sms_summary)}</div>
      <div class="sms-meta">${(r.sms_summary || '').length} characters · fits one SMS${(r.sms_summary || '').length > 160 ? ' (2 parts)' : ''}</div>
      <div class="share-row">
        <a class="ghost small" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent('🌱 Shamba Doctor: ' + (r.sms_summary || ''))}">Share on WhatsApp</a>
        <button class="ghost small" id="copySms">Copy SMS</button>
      </div>
    </div>

    <div class="card">
      <h3>Ask a follow-up</h3>
      <div class="chips chat-sugg" id="chatSugg">
        <button type="button" class="chip sm">Can I still eat the harvest?</button>
        <button type="button" class="chip sm">When exactly can I spray?</button>
        <button type="button" class="chip sm">Will it spread to my other crops?</button>
      </div>
      <div class="chat-log" id="chatLog"></div>
      <form class="chat-form" id="chatForm">
        <input id="chatInput" placeholder="Ask anything about this case…" autocomplete="off" />
        <button class="primary small">Send</button>
      </form>
    </div>

    <div class="card trace">
      <details>
        <summary>How Gemini worked this out</summary>
        ${trace.map(t => t.type === 'tool_call'
          ? `<div class="t"><span class="ti">🔧</span><span>Gemini decided to call <code>${esc(t.name)}(${esc(t.args?.location || '')}${t.args?.lat ? ` ${(+t.args.lat).toFixed(2)},${(+t.args.lon).toFixed(2)}` : ''})</code></span></div>`
          : t.type === 'tool_result' ? `<div class="t"><span class="ti">📡</span><span>${esc(t.summary)}</span></div>`
          : `<div class="t"><span class="ti">ℹ️</span><span>${esc(t.text)}</span></div>`).join('')}
        <div class="t"><span class="ti">🧠</span><span><code>${esc(model)}</code> · multimodal input (${state.lastBody?.images.length || 0} photo${state.lastBody?.images.length === 1 ? '' : 's'}${state.lastBody?.audio ? ' + voice' : ''}) · structured JSON output${mock ? ' · DEMO MODE' : ''}</span><span class="ms">${(ms / 1000).toFixed(1)}s</span></div>
      </details>
    </div>

    <button class="ghost again" id="againBtn">↺ Diagnose another plant</button>
  `;
  show('#results');
  window.scrollTo({ top: box.offsetTop - 90, behavior: 'smooth' });

  // animate ring, counter, severity bar
  requestAnimationFrame(() => setTimeout(() => {
    const v = box.querySelector('.ring .val'); v.style.strokeDashoffset = v.dataset.off;
    box.querySelectorAll('.sevbar i').forEach((i, k) => setTimeout(() => { if (i.dataset.c) i.style.background = i.dataset.c; }, k * 90));
    countUp(box.querySelector('[data-count]'), conf);
  }, 80));

  // checklist with progress
  const items = [...box.querySelectorAll('.checklist li')];
  const upd = () => {
    const n = items.filter(li => li.classList.contains('done')).length;
    $('#doneCount').textContent = `${n}/${items.length}`;
    $('#donePbar').style.width = items.length ? (n / items.length * 100) + '%' : '0';
    if (n === items.length && n) toast('All done for today. Well done! 🌱');
  };
  items.forEach(li => li.onclick = () => { li.classList.toggle('done'); upd(); });

  if (w?.hourly?.length) wireTimeline(w);
  $('#speakBtn').onclick = () => speakText(r.farmer_message);
  $('#copySms').onclick = async () => {
    try { await navigator.clipboard.writeText(r.sms_summary || ''); toast('SMS copied'); } catch { toast('Copy not allowed here'); }
  };
  $('#chatForm').onsubmit = e => { e.preventDefault(); sendChat($('#chatInput').value); };
  $$('#chatSugg .chip').forEach(c => c.onclick = () => sendChat(c.textContent));
  $('#againBtn').onclick = resetForm;
}

function countUp(el, to) {
  const t0 = performance.now(), dur = 1200;
  const step = now => {
    const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(to * e) + '%';
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function timeline(w) {
  const hrs = w.hourly.slice(0, 36);
  const max = Math.max(...hrs.map(h => h.temp), 32), min = Math.min(...hrs.map(h => h.temp), 14);
  const bars = hrs.map((h, i) => {
    const ht = 14 + ((h.temp - min) / (max - min)) * 80;
    const cls = ['h', h.ok ? 'ok' : '', h.temp >= 30 ? 'hot' : '', h.rain >= 40 ? 'rain' : ''].join(' ');
    return `<div class="${cls}" data-i="${i}" style="height:${ht}%;animation-delay:${i * 14}ms"></div>`;
  }).join('');
  const axis = hrs.map((h, i) => `<span>${i % 6 === 0 ? fmtHour(h.t) : ''}</span>`).join('');
  const safe = hrs.filter(h => h.ok).length;
  return `<div class="timeline-wrap">
    <span class="label">Next 36 hours · tap a bar</span>
    <div class="timeline" id="timeline" aria-label="36-hour forecast">${bars}</div>
    <div class="tl-axis">${axis}</div>
    <div class="tl-read" id="tlRead"><span>☀️ <b>${safe}</b> safe spray hour${safe === 1 ? '' : 's'} in the next 36h</span><span>📍 ${esc(w.location)} · ${esc(w.source)}</span></div>
    <div class="legend"><span><i style="background:var(--gold)"></i>safe to spray</span><span><i style="background:var(--bar-off)"></i>not safe</span><span><i style="background:var(--heat)"></i>≥30°C heat</span><span><i style="background:var(--rain);border-radius:50%"></i>rain likely</span></div>
  </div>`;
}

function wireTimeline(w) {
  const tl = $('#timeline'); if (!tl) return;
  const hrs = w.hourly.slice(0, 36);
  const show = i => {
    const h = hrs[i]; if (!h) return;
    tl.querySelectorAll('.h').forEach(b => b.classList.toggle('sel', +b.dataset.i === i));
    $('#tlRead').innerHTML = `<span><b>${esc(fmtDay(h.t))} ${esc(fmtHour(h.t))}</b></span><span>🌡 ${h.temp}°C</span><span>🌧 ${h.rain}%</span><span>💨 ${h.wind} km/h</span>
      <span class="${h.ok ? 'tag-ok' : 'tag-no'}">${h.ok ? '✓ Safe to spray' : '✕ Not safe'}</span>`;
  };
  const pick = x => {
    const r = tl.getBoundingClientRect();
    show(Math.max(0, Math.min(hrs.length - 1, Math.floor((x - r.left) / r.width * hrs.length))));
  };
  tl.addEventListener('pointermove', e => pick(e.clientX));
  tl.addEventListener('pointerdown', e => pick(e.clientX));
}
const fmtHour = t => { const h = +t.slice(11, 13); return `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`; };
const fmtDay = t => {
  const d = t.slice(0, 10), today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  const tom = new Date(Date.now() + 27 * 3600e3).toISOString().slice(0, 10);
  return d === today ? 'Today' : d === tom ? 'Tomorrow' : d;
};

// ---------- read aloud: Gemini TTS, falls back to the browser voice ----------
let audioEl = null;
const playIcon = () => '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
const stopIcon = () => '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';
const spinIcon = () => '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-dasharray="36 60" stroke-linecap="round"/></svg>';
const ttsCache = new Map();
async function speakText(text) {
  const btn = $('#speakBtn');
  const idle = () => { btn.innerHTML = playIcon(); btn.classList.remove('playing', 'loading'); };
  if (audioEl && !audioEl.paused) { audioEl.pause(); return idle(); }
  if (speechSynthesis.speaking) { speechSynthesis.cancel(); return idle(); }
  btn.innerHTML = spinIcon(); btn.classList.add('loading');
  try {
    let url = ttsCache.get(text);
    if (!url) {
      const r = await fetch('/api/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, lang: state.lang }) });
      if (!r.ok) throw new Error('tts');
      url = URL.createObjectURL(await r.blob());
      ttsCache.set(text, url);
    }
    audioEl = new Audio(url);
    audioEl.onended = idle;
    await audioEl.play();
  } catch {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.92; u.onend = idle;
    speechSynthesis.speak(u);
  }
  btn.innerHTML = stopIcon(); btn.classList.remove('loading'); btn.classList.add('playing');
}

// ---------- follow-up chat ----------
async function sendChat(text) {
  const msg = String(text || '').trim();
  if (!msg) return;
  $('#chatInput').value = '';
  const log = $('#chatLog');
  log.insertAdjacentHTML('beforeend', `<div class="msg me">${esc(msg)}</div>`);
  const pending = document.createElement('div');
  pending.className = 'msg bot'; pending.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  log.append(pending); log.scrollTop = log.scrollHeight;
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId: state.caseId, message: msg, context: state.chatContext }) });
    const j = await r.json();
    pending.textContent = j.reply || j.error;
    if (j.trace?.some(t => t.type === 'tool_call')) pending.insertAdjacentHTML('afterbegin', '<span class="tool">🔧 checked live weather</span>');
  } catch (err) { pending.textContent = err.message; }
  log.scrollTop = log.scrollHeight;
}

function resetForm() {
  state.images = []; state.audio = null; state.caseId = null;
  renderThumbs(); $('#voicePreview').hidden = true; $('#micLabel').textContent = 'Record a voice note';
  $('#textInput').value = ''; $$('#quickChips .chip').forEach(x => x.classList.remove('on'));
  hide('#results'); hide('#error'); show('#intake'); markSteps();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------- outbreak radar ----------
let map, layer, radarFilter = 'all', radarCases = [];
async function loadRadar() {
  radarCases = await fetch('/api/cases').then(r => r.json()).catch(() => []);
  if (window.L && !map) {
    map = L.map('map', { scrollWheelZoom: false }).setView([1.37, 32.29], 6);
    // Free OSM tiles, darkened with a CSS filter (.dark-tiles) to match the black & gold theme.
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 19, className: 'dark-tiles' }).addTo(map);
  }
  renderRadar();
}

function renderRadar() {
  const cases = radarCases;
  const norm = s => String(s || '').replace(/\s*\(.*?\)\s*/g, ' ').trim();
  const place = s => String(s || '').split(',')[0].trim();
  const shown = radarFilter === 'all' ? cases : cases.filter(c => norm(c.issue).toLowerCase() === radarFilter);

  // cluster alerts: same issue reported ≥2 times in the last 72h with high spread risk
  const recent = cases.filter(c => Date.now() - new Date(c.time) < 72 * 3600e3 && c.spread_risk === 'high');
  const byIssue = {};
  recent.forEach(c => { (byIssue[norm(c.issue).toLowerCase()] ||= []).push(c); });
  const alerts = Object.values(byIssue).filter(v => v.length >= 2);

  $('#radarStats').innerHTML = `
    <div class="stat"><b>${cases.length}</b><small>reports</small></div>
    <div class="stat gold"><b>${new Set(cases.map(c => place(c.location))).size}</b><small>districts</small></div>
    <div class="stat red"><b>${cases.filter(c => c.severity === 'critical' || c.severity === 'high').length}</b><small>high / critical</small></div>
    <div class="stat gold"><b>${alerts.length}</b><small>cluster alerts</small></div>`;
  $('#alerts').innerHTML = alerts.map(v => `<div class="alert">⚠️ <span>${v.length} reports of <b>${esc(norm(v[0].issue))}</b> in 72h: ${esc([...new Set(v.map(x => place(x.location)))].join(', '))}. Alert the district agricultural officers.</span></div>`).join('');

  const issues = [...new Map(cases.map(c => norm(c.issue)).filter(Boolean).map(i => [i.toLowerCase(), i])).values()];
  $('#radarFilter').innerHTML = issues.length > 1 ? ['all', ...issues].map(i => `<button type="button" class="chip sm ${radarFilter === i.toLowerCase() ? 'on' : ''}" data-f="${esc(i.toLowerCase())}">${i === 'all' ? 'All' : esc(i)}</button>`).join('') : '';
  $$('#radarFilter .chip').forEach(b => b.onclick = () => { radarFilter = b.dataset.f; renderRadar(); });

  const markers = {};
  if (map) {
    setTimeout(() => map.invalidateSize(), 50);
    layer?.remove(); layer = L.layerGroup().addTo(map);
    shown.filter(c => typeof c.lat === 'number').forEach(c => {
      markers[c.id] = L.circleMarker([c.lat, c.lon], {
        radius: c.severity === 'critical' ? 13 : c.severity === 'high' ? 11 : 8,
        color: '#070708', weight: 2, fillColor: SEV_COL[c.severity] || '#8a8f97', fillOpacity: .92,
      }).bindPopup(`<b>${esc(c.issue)}</b><br>${esc(c.crop)} · ${esc(c.location)}<br>Severity: ${esc(c.severity)}${c.sample ? '<br><i>sample report</i>' : ''}`).addTo(layer);
    });
  }
  $('#caseList').innerHTML = shown.length ? shown.slice(0, 30).map(c => `
    <div class="c" data-id="${esc(c.id)}"><span><span class="dot" style="background:${SEV_COL[c.severity] || '#888'};color:${SEV_COL[c.severity] || '#888'}"></span><b>${esc(c.issue)}</b> · ${esc(c.crop)}<br><small>${esc(c.location)}${c.sample ? ' · sample' : ''}</small></span>
    <small>${new Date(c.time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small></div>`).join('')
    : '<div class="empty">No reports yet. Run a diagnosis or load sample reports.</div>';
  $$('#caseList .c').forEach(row => row.onclick = () => {
    const m = markers[row.dataset.id]; if (!m) return;
    map.flyTo(m.getLatLng(), 9, { duration: .8 }); setTimeout(() => m.openPopup(), 850);
    $('#map').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}
$('#sampleBtn').onclick = async () => { await fetch('/api/cases/sample', { method: 'POST' }); radarFilter = 'all'; await loadRadar(); toast('Sample reports loaded'); };
$('#clearSampleBtn').onclick = async () => { await fetch('/api/cases/sample', { method: 'DELETE' }); radarFilter = 'all'; await loadRadar(); toast('Samples cleared'); };

// ---------- helpers ----------
function show(s) { $(s).hidden = false; }
function hide(s) { $(s).hidden = true; }
function showError(m, retryable = false) {
  $('#errorText').textContent = m;
  $('#retryBtn').hidden = !(retryable && state.lastBody);
  const e = $('#error'); e.hidden = true; void e.offsetWidth; e.hidden = false;
  e.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
let toastT;
function toast(m) {
  const t = $('#toast'); t.textContent = m; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200);
}
