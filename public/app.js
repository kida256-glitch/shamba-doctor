const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { images: [], audio: null, gps: null, caseId: null, lang: 'en', status: null, lastResult: null };

// ---------- boot ----------
(async function boot() {
  const st = await fetch('/api/status').then(r => r.json()).catch(() => null);
  state.status = st;
  const pill = $('#modePill');
  if (!st) { pill.textContent = 'offline'; return; }
  pill.textContent = st.mock ? 'DEMO MODE' : `LIVE · ${st.models.text}`;
  pill.className = 'pill ' + (st.mock ? 'mock' : 'live');
  const sel = $('#lang');
  Object.entries(st.languages).forEach(([code, name]) => sel.add(new Option(name, code, false, code === 'lg')));
})();

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
  if (t.dataset.tab === 'radar') loadRadar();
}));

// ---------- photos (compressed in-browser) ----------
$('#photoInput').addEventListener('change', async e => {
  for (const file of [...e.target.files].slice(0, 4 - state.images.length)) {
    const data = await compressImage(file);
    state.images.push(data);
  }
  e.target.value = '';
  renderThumbs();
});

function renderThumbs() {
  const box = $('#thumbs');
  box.querySelectorAll('.thumb').forEach(n => n.remove());
  state.images.forEach((img, i) => {
    const d = document.createElement('div');
    d.className = 'thumb';
    d.innerHTML = `<img alt="photo ${i + 1}" src="data:${img.mimeType};base64,${img.data}"><button type="button" aria-label="remove">×</button>`;
    d.querySelector('button').onclick = () => { state.images.splice(i, 1); renderThumbs(); };
    box.insertBefore(d, box.querySelector('.add-photo'));
  });
  box.querySelector('.add-photo').style.display = state.images.length >= 4 ? 'none' : '';
}

async function compressImage(file, max = 1280) {
  const url = URL.createObjectURL(file);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(url);
  return { mimeType: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.85).split(',')[1] };
}

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
      $('#micLabel').textContent = 'Re-record';
      const blob = new Blob(chunks, { type: rec.mimeType });
      const wav = await toWav16k(blob);
      state.audio = { mimeType: 'audio/wav', data: await blobToB64(wav) };
      const p = $('#voicePreview'); p.src = URL.createObjectURL(wav); p.hidden = false;
    };
    rec.start(); recStart = Date.now();
    btn.classList.add('rec'); btn.setAttribute('aria-pressed', 'true');
    recTimer = setInterval(() => {
      const s = Math.floor((Date.now() - recStart) / 1000);
      $('#micLabel').textContent = `Recording… ${s}s — tap to stop`;
      if (s >= 60) rec.stop();
    }, 250);
  } catch (e) { showError('Microphone not available: ' + e.message); }
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
  if (!navigator.geolocation) return showError('GPS not available on this device.');
  $('#gpsBtn').textContent = '…';
  navigator.geolocation.getCurrentPosition(p => {
    state.gps = { lat: p.coords.latitude, lon: p.coords.longitude };
    $('#location').value = `My farm (${state.gps.lat.toFixed(3)}, ${state.gps.lon.toFixed(3)})`;
    $('#gpsBtn').textContent = '✓ GPS';
  }, err => { $('#gpsBtn').textContent = 'GPS'; showError('Could not get GPS: ' + err.message + ' — type your district instead.'); },
  { enableHighAccuracy: true, timeout: 10000 });
});
$('#location').addEventListener('input', () => { state.gps = null; });

// ---------- diagnose ----------
$('#intake').addEventListener('submit', async e => {
  e.preventDefault();
  hide('#error');
  if (!state.images.length && !state.audio && !$('#textInput').value.trim()) return showError('Add a photo, a voice note, or type a question first.');
  state.lang = $('#lang').value;
  const body = {
    images: state.images, audio: state.audio, text: $('#textInput').value.trim(),
    lang: state.lang, location: state.gps ? 'farmer GPS location' : $('#location').value.trim(), gps: state.gps, crop: $('#crop').value.trim(),
  };
  $('#goBtn').disabled = true;
  show('#thinking'); hide('#results');
  const stepper = runStepper();
  try {
    const r = await fetch('/api/diagnose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Something went wrong');
    state.caseId = j.caseId; state.lastResult = j;
    renderResults(j);
  } catch (err) { showError(err.message); }
  finally { stepper.stop(); hide('#thinking'); $('#goBtn').disabled = false; }
});

function runStepper() {
  const items = [...document.querySelectorAll('#thinkSteps li')];
  items.forEach(li => li.className = '');
  if (!state.audio) items[1].className = 'done';
  let i = 0;
  const tick = () => {
    while (items[i] && items[i].className === 'done') i++;
    items.forEach((li, k) => { if (k < i) li.className = 'done'; else if (k === i) li.className = 'on'; });
    if (i < items.length - 1) i++;
  };
  tick();
  const t = setInterval(tick, 2200);
  return { stop: () => clearInterval(t) };
}

// ---------- results ----------
const VERDICT = {
  spray: ['✓', 'Spray is justified'],
  wait_for_window: ['⏱', 'Wait for the safe window'],
  do_not_spray: ['✕', "Don't spray"],
  not_needed: ['✓', 'No spraying needed'],
};

function renderResults({ result: r, weather: w, trace = [], model, ms, mock }) {
  const d = r.diagnosis || {};
  const sp = r.spray || {};
  const [vIcon, vText] = VERDICT[sp.verdict] || ['?', sp.verdict || ''];
  const conf = Math.round((d.confidence || 0) * 100);
  const box = $('#results');

  box.innerHTML = `
    ${r.plant_visible === false || r.image_quality_note ? `<div class="card error">${esc(r.image_quality_note || 'I could not see a plant clearly. Please take a closer, sharper photo in daylight.')}</div>` : ''}

    <div class="card hero">
      <div class="crop">${esc(r.crop)}</div>
      <h2>${esc(d.name)}</h2>
      ${d.local_name ? `<div class="local">${esc(d.local_name)}</div>` : ''}
      <div class="badges">
        <span class="badge">${esc(d.category)}</span>
        <span class="badge sev-${esc(d.severity)}">severity: ${esc(d.severity)}</span>
        <span class="badge">spread risk: ${esc(d.spread_risk)}</span>
      </div>
      <div class="conf"><span>Confidence</span><span class="bar"><i style="width:0" data-w="${conf}%"></i></span><b>${conf}%</b></div>
      <div class="listen">
        <button id="speakBtn" aria-label="Listen">${playIcon()}</button>
        <p id="farmerMsg">${esc(r.farmer_message)}</p>
      </div>
      ${r.farmer_said_english ? `<p class="hint" style="color:#cfe8cf;margin-top:10px">🎙 You said: “${esc(r.farmer_said_english)}”</p>` : ''}
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
      ${(sp.active_ingredients || []).length ? `<div class="chips">${sp.active_ingredients.map(a => `<span class="chip">${esc(a)}</span>`).join('')}</div>` : ''}
      ${(sp.safety || []).length ? `<ul class="safety">${sp.safety.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
      ${r.heat_warning ? `<div class="heat">🌡 ${esc(r.heat_warning)}</div>` : ''}
    </div>

    <div class="grid2">
      <div class="card">
        <h3>Do this today</h3>
        <ul class="checklist">${(r.do_now || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul>
      </div>
      <div class="card">
        <h3>What I saw</h3>
        <ul class="evidence">${(r.evidence || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul>
        ${(r.alternatives || []).length ? `<details><summary>Other possibilities</summary>${r.alternatives.map(a => `<p class="alt"><b>${esc(a.name)}</b> — ${esc(a.why_less_likely)}</p>`).join('')}</details>` : ''}
      </div>
    </div>

    ${r.escalate?.needed ? `<div class="card escalate"><h3>📣 Report to ${esc(r.escalate.to || 'your extension officer')}</h3><p>${esc(r.escalate.why)}</p></div>` : ''}

    ${(r.prevention || []).length ? `<div class="card"><h3>Prevent it next season</h3><ul>${r.prevention.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}

    <div class="card">
      <h3>Share with your farmer group</h3>
      <div class="sms" id="smsText">${esc(r.sms_summary)}</div>
      <div class="share-row">
        <a class="ghost small" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent('🌱 Shamba Doctor: ' + (r.sms_summary || ''))}">Share on WhatsApp</a>
        <button class="ghost small" id="copySms">Copy SMS</button>
      </div>
    </div>

    <div class="card">
      <h3>Ask a follow-up</h3>
      <div class="chat-log" id="chatLog"></div>
      <form class="chat-form" id="chatForm">
        <input id="chatInput" placeholder="e.g. Can I still eat the maize? What about my beans next to it?" />
        <button class="ghost">Send</button>
      </form>
    </div>

    <div class="card trace">
      <details>
        <summary>How Gemini worked this out</summary>
        ${trace.map(t => t.type === 'tool_call'
          ? `<div class="t">🔧 <span>Gemini called <code>${esc(t.name)}(${esc(t.args?.location || '')}${t.args?.lat ? ` ${(+t.args.lat).toFixed(2)},${(+t.args.lon).toFixed(2)}` : ''})</code></span></div>`
          : t.type === 'tool_result' ? `<div class="t">📡 <span>${esc(t.summary)}</span></div>` : `<div class="t">ℹ️ ${esc(t.text)}</div>`).join('')}
        <div class="t">🧠 <span>Model <code>${esc(model)}</code> · multimodal input (${state.images.length} photo${state.images.length === 1 ? '' : 's'}${state.audio ? ' + voice' : ''}) · structured JSON output · ${(ms / 1000).toFixed(1)}s${mock ? ' · DEMO MODE' : ''}</span></div>
      </details>
    </div>

    <button class="ghost again" id="againBtn">↺ New diagnosis</button>
  `;
  show('#results'); hide('#intake');
  requestAnimationFrame(() => box.querySelectorAll('[data-w]').forEach(i => { i.style.width = i.dataset.w; }));
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });

  box.querySelectorAll('.checklist li').forEach(li => li.onclick = () => li.classList.toggle('done'));
  $('#speakBtn').onclick = () => speakText(r.farmer_message);
  $('#copySms').onclick = () => { navigator.clipboard.writeText(r.sms_summary || ''); $('#copySms').textContent = 'Copied ✓'; };
  $('#chatForm').onsubmit = sendChat;
  $('#againBtn').onclick = resetForm;
}

function timeline(w) {
  const hrs = w.hourly.slice(0, 36);
  const max = Math.max(...hrs.map(h => h.temp), 32), min = Math.min(...hrs.map(h => h.temp), 14);
  const bars = hrs.map(h => {
    const ht = 12 + ((h.temp - min) / (max - min)) * 80;
    const cls = ['h', h.ok ? 'ok' : '', h.temp >= 30 ? 'hot' : '', h.rain >= 40 ? 'rain' : ''].join(' ');
    return `<div class="${cls}" style="height:${ht}%" title="${esc(h.t.replace('T', ' '))} · ${h.temp}°C · rain ${h.rain}% · wind ${h.wind} km/h"></div>`;
  }).join('');
  const axis = hrs.map((h, i) => `<span>${i % 6 === 0 ? h.t.slice(11, 13) + 'h' : ''}</span>`).join('');
  return `<div class="timeline" aria-label="36-hour forecast">${bars}</div><div class="tl-axis">${axis}</div>
    <div class="legend"><span><i style="background:var(--leaf)"></i>safe to spray</span><span><i style="background:#e9e2cf"></i>not safe</span><span><i style="background:var(--clay)"></i>≥30°C heat</span><span><i style="background:#3d7fb8;border-radius:50%"></i>rain likely</span><span>📍 ${esc(w.location)} · ${esc(w.source)}</span></div>`;
}

// ---------- read aloud: Gemini TTS, falls back to the browser voice ----------
let audioEl = null;
const playIcon = () => '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
const stopIcon = () => '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';
async function speakText(text) {
  const btn = $('#speakBtn');
  if (audioEl && !audioEl.paused) { audioEl.pause(); btn.innerHTML = playIcon(); btn.classList.remove('playing'); return; }
  if (speechSynthesis.speaking) { speechSynthesis.cancel(); btn.innerHTML = playIcon(); btn.classList.remove('playing'); return; }
  btn.innerHTML = '…';
  try {
    const r = await fetch('/api/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, lang: state.lang }) });
    if (!r.ok) throw new Error('tts');
    audioEl = new Audio(URL.createObjectURL(await r.blob()));
    audioEl.onended = () => { btn.innerHTML = playIcon(); btn.classList.remove('playing'); };
    await audioEl.play();
  } catch {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.92;
    u.onend = () => { btn.innerHTML = playIcon(); btn.classList.remove('playing'); };
    speechSynthesis.speak(u);
  }
  btn.innerHTML = stopIcon(); btn.classList.add('playing');
}

// ---------- follow-up chat ----------
async function sendChat(e) {
  e.preventDefault();
  const input = $('#chatInput'); const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  const log = $('#chatLog');
  log.insertAdjacentHTML('beforeend', `<div class="msg me">${esc(msg)}</div>`);
  const pending = document.createElement('div'); pending.className = 'msg bot'; pending.textContent = '…'; log.append(pending);
  try {
    const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId: state.caseId, message: msg }) });
    const j = await r.json();
    pending.textContent = j.reply || j.error;
    if (j.trace?.some(t => t.type === 'tool_call')) pending.insertAdjacentHTML('afterbegin', '<small style="display:block;color:var(--leaf)">🔧 checked live weather</small>');
  } catch (err) { pending.textContent = err.message; }
}

function resetForm() {
  state.images = []; state.audio = null; state.caseId = null;
  renderThumbs(); $('#voicePreview').hidden = true; $('#micLabel').textContent = 'Record voice note';
  $('#textInput').value = ''; hide('#results'); show('#intake');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------- outbreak radar ----------
let map, layer;
const SEV = { none: '#2f7d45', low: '#6aa84f', moderate: '#f2b632', high: '#e07a2e', critical: '#c8553d' };
async function loadRadar() {
  const cases = await fetch('/api/cases').then(r => r.json());
  if (window.L && !map) {
    map = L.map('map', { scrollWheelZoom: false }).setView([1.37, 32.29], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);
  }
  if (map) {
    setTimeout(() => map.invalidateSize(), 50);
    layer?.remove(); layer = L.layerGroup().addTo(map);
    cases.filter(c => typeof c.lat === 'number').forEach(c => {
      L.circleMarker([c.lat, c.lon], { radius: c.severity === 'critical' ? 13 : c.severity === 'high' ? 11 : 8, color: '#fff', weight: 2, fillColor: SEV[c.severity] || '#888', fillOpacity: .9 })
        .bindPopup(`<b>${esc(c.issue)}</b><br>${esc(c.crop)} · ${esc(c.location)}<br>severity: ${esc(c.severity)}${c.sample ? '<br><i>sample report</i>' : ''}`).addTo(layer);
    });
  }
  // cluster alerts: same issue reported ≥2 times in the last 72h with high spread risk
  const recent = cases.filter(c => Date.now() - new Date(c.time) < 72 * 3600e3 && c.spread_risk === 'high');
  const byIssue = {};
  const norm = s => String(s || '').replace(/\s*\(.*?\)\s*/g, ' ').trim().toLowerCase();
  recent.forEach(c => { (byIssue[norm(c.issue)] ||= []).push(c); });
  $('#alerts').innerHTML = Object.entries(byIssue).filter(([, v]) => v.length >= 2)
    .map(([k, v]) => `<div class="alert">⚠️ ${v.length} reports of <b>${esc(v[0].issue.replace(/\s*\(.*?\)/, ''))}</b> in 72h — ${esc([...new Set(v.map(x => x.location))].join(', '))}. Alert the district agricultural officers.</div>`).join('');
  $('#caseList').innerHTML = cases.length ? cases.slice(0, 30).map(c => `
    <div class="c"><span><span class="dot" style="background:${SEV[c.severity] || '#888'}"></span><b>${esc(c.issue)}</b> · ${esc(c.crop)}<br><small>${esc(c.location)}${c.sample ? ' · sample' : ''}</small></span>
    <small>${new Date(c.time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small></div>`).join('')
    : '<div class="empty">No reports yet — run a diagnosis or load sample reports.</div>';
}
$('#sampleBtn').onclick = async () => { await fetch('/api/cases/sample', { method: 'POST' }); loadRadar(); };
$('#clearSampleBtn').onclick = async () => { await fetch('/api/cases/sample', { method: 'DELETE' }); loadRadar(); };

// ---------- helpers ----------
function show(s) { $(s).hidden = false; }
function hide(s) { $(s).hidden = true; }
function showError(m) { const e = $('#error'); e.textContent = m; e.hidden = false; }
