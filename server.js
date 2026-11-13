import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runAgent, parseJSON, speak, geminiReady, activeModels, isTransient } from './lib/gemini.js';
import { systemInstruction, diagnosisSchema, chatInstruction, LANGUAGES } from './lib/prompts.js';
import { mockDiagnosis } from './lib/mock.js';
import { getWeatherForecast } from './lib/weather.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK = process.argv.includes('--mock') || process.env.MOCK === '1' || !geminiReady();
const PORT = Number(process.env.PORT || 3000);
// Vercel's filesystem is read-only except /tmp (ephemeral, per instance) — fine for a demo radar.
const CASES_FILE = process.env.VERCEL ? path.join(os.tmpdir(), 'cases.json') : path.join(__dirname, 'data', 'cases.json');

const app = express();
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- tiny persistence for the outbreak radar ----
try { fs.mkdirSync(path.dirname(CASES_FILE), { recursive: true }); } catch { /* read-only FS */ }
const loadCases = () => { try { return JSON.parse(fs.readFileSync(CASES_FILE, 'utf8')); } catch { return []; } };
const saveCases = c => { try { fs.writeFileSync(CASES_FILE, JSON.stringify(c, null, 2)); } catch (e) { console.warn('[cases] not saved:', e.message); } };
const sessions = new Map(); // caseId -> { contents, lang, gps, location }

app.get('/api/status', (_req, res) => res.json({ mock: MOCK, models: activeModels(), languages: LANGUAGES }));

// Streams newline-delimited JSON so the UI can show each step live:
// {type:'thinking'|'backup'|'note'|'tool_call'|'tool_result'} … then {type:'result', …} or {type:'error', …}
app.post('/api/diagnose', async (req, res) => {
  const { images = [], audio, text = '', lang = 'en', location = 'Kampala', gps, crop = '' } = req.body || {};
  const langName = LANGUAGES[lang] || 'English';
  const trace = [];
  const started = Date.now();
  if (!images.length && !audio && !text) return res.status(400).json({ error: 'Send at least a photo, a voice note or a question.' });

  res.set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const emit = ev => { if (!res.writableEnded) res.write(JSON.stringify({ ...ev, t: Date.now() - started }) + '\n'); };
  emit({ type: 'start', images: images.length, audio: !!audio?.data });

  try {
    // Start the forecast now, in parallel with Gemini looking at the photos.
    const weatherPromise = getWeatherForecast(gps ? { location, lat: gps.lat, lon: gps.lon } : { location });
    weatherPromise.catch(() => {});

    let result, weather, model = 'mock';
    if (MOCK) {
      const m = await mockDiagnosis({ location, gps });
      result = m.result; weather = m.weather;
      for (const ev of m.trace) { trace.push(ev); emit(ev); }
    } else {
      const parts = [];
      images.slice(0, 4).forEach((img, i) => {
        parts.push({ text: `Photo ${i + 1}:` });
        parts.push({ inlineData: { mimeType: img.mimeType || 'image/jpeg', data: img.data } });
      });
      if (audio?.data) {
        parts.push({ text: `Farmer's voice note (may be in ${langName} or mixed languages):` });
        parts.push({ inlineData: { mimeType: audio.mimeType || 'audio/wav', data: audio.data } });
      }
      parts.push({
        text: [
          `Farm location: ${location}${gps ? ` (GPS ${gps.lat.toFixed(4)}, ${gps.lon.toFixed(4)})` : ''}, Uganda.`,
          `Local time: ${new Date().toLocaleString('en-GB', { timeZone: 'Africa/Kampala' })} (Africa/Kampala).`,
          crop ? `Farmer says the crop is: ${crop}.` : '',
          text ? `Farmer's written message: "${text}"` : '',
          `Farmer's preferred language: ${langName}.`,
          'Diagnose the problem and give a safe action plan. Check the live weather before advising any spraying.',
        ].filter(Boolean).join('\n'),
      });
      const contents = [{ role: 'user', parts }];
      const out = await runAgent({ contents, system: systemInstruction(langName), schema: diagnosisSchema, gps, trace, emit, weatherPromise });
      result = parseJSON(out.text);
      weather = out.weather;
      model = out.model;
      const id = crypto.randomUUID();
      sessions.set(id, { contents, lang, gps, location });
      result._caseId = id;
    }

    const caseId = result._caseId || crypto.randomUUID();
    const coords = weather ? { lat: weather.lat, lon: weather.lon } : gps || null;
    const cases = loadCases();
    cases.unshift({
      id: caseId, time: new Date().toISOString(), location: weather?.location || location, ...coords,
      crop: result.crop, issue: result.diagnosis?.name, category: result.diagnosis?.category,
      severity: result.diagnosis?.severity, spread_risk: result.diagnosis?.spread_risk, escalate: !!result.escalate?.needed,
    });
    saveCases(cases.slice(0, 500));

    emit({ type: 'result', caseId, result, weather, trace, model, mock: MOCK, ms: Date.now() - started });
  } catch (e) {
    console.error(e);
    emit({ type: 'error', error: friendlyError(e), retryable: isTransient(e), trace });
  }
  res.end();
});

app.post('/api/chat', async (req, res) => {
  const { caseId, message, context } = req.body || {};
  let s = sessions.get(caseId);
  // Serverless: this request may hit an instance that never saw the diagnosis. Rebuild the case
  // from the result the browser sends back (no photos, but the full diagnosis and location).
  if (!s && !MOCK && context?.result) {
    s = {
      contents: [
        { role: 'user', parts: [{ text: `Farm location: ${context.location || 'Uganda'}. Here is the diagnosis you gave this farmer earlier:\n${JSON.stringify(context.result).slice(0, 12000)}` }] },
        { role: 'model', parts: [{ text: 'Understood. I will answer follow-up questions about this case.' }] },
      ],
      lang: context.lang || 'en', gps: context.gps || null, location: context.location,
    };
    sessions.set(caseId || crypto.randomUUID(), s);
  }
  if (MOCK || !s) {
    return res.json({ reply: MOCK
      ? '(Demo mode) Spray only in the cool morning window shown above, into the funnel, and wear gloves and a mask. Check again after 3 days.'
      : 'This case expired — please run a new diagnosis.', trace: [] });
  }
  try {
    const trace = [];
    const contents = [...s.contents, { role: 'user', parts: [{ text: message }] }];
    const out = await runAgent({ contents, system: chatInstruction(LANGUAGES[s.lang] || 'English'), gps: s.gps, trace });
    s.contents = contents;
    res.json({ reply: out.text, trace });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: friendlyError(e) });
  }
});

app.post('/api/speak', async (req, res) => {
  const { text, lang = 'en' } = req.body || {};
  if (MOCK) return res.status(503).json({ error: 'TTS needs a Gemini key', fallback: true });
  try {
    const wav = await speak(String(text).slice(0, 1500), LANGUAGES[lang] || 'English');
    res.set('Content-Type', 'audio/wav').send(wav);
  } catch (e) {
    console.error('[tts]', e.message);
    res.status(502).json({ error: friendlyError(e), fallback: true });
  }
});

app.get('/api/weather', async (req, res) => {
  try {
    const { location, lat, lon } = req.query;
    res.json(await getWeatherForecast({ location, lat: lat ? Number(lat) : undefined, lon: lon ? Number(lon) : undefined }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/cases', (_req, res) => res.json(loadCases()));

app.post('/api/cases/sample', (_req, res) => {
  const now = Date.now();
  const sample = [
    ['Mbale', 1.0827, 34.175, 'Maize', 'Fall armyworm', 'pest', 'high', 'high', true],
    ['Sironko', 1.2304, 34.2479, 'Maize', 'Fall armyworm', 'pest', 'moderate', 'high', true],
    ['Tororo', 0.6928, 34.1809, 'Maize', 'Fall armyworm', 'pest', 'moderate', 'high', true],
    ['Luwero', 0.8492, 32.4731, 'Cassava', 'Cassava brown streak disease', 'viral disease', 'high', 'high', true],
    ['Masaka', -0.3338, 31.7341, 'Banana', 'Banana bacterial wilt (BXW)', 'bacterial disease', 'critical', 'high', true],
    ['Kabale', -1.2486, 29.9899, 'Irish potato', 'Late blight', 'fungal disease', 'high', 'high', false],
    ['Mukono', 0.3533, 32.7553, 'Tomato', 'Tuta absoluta', 'pest', 'moderate', 'medium', false],
    ['Gulu', 2.7724, 32.2881, 'Beans', 'Bean angular leaf spot', 'fungal disease', 'low', 'medium', false],
  ].map(([location, lat, lon, crop, issue, category, severity, spread_risk, escalate], i) => ({
    id: 'sample-' + i, sample: true, time: new Date(now - i * 7.2e6).toISOString(),
    location, lat, lon, crop, issue, category, severity, spread_risk, escalate,
  }));
  const cases = loadCases().filter(c => !c.sample);
  saveCases([...cases, ...sample]);
  res.json({ added: sample.length });
});

app.delete('/api/cases/sample', (_req, res) => { saveCases(loadCases().filter(c => !c.sample)); res.json({ ok: true }); });

function friendlyError(e) {
  const m = String(e?.message || e);
  if (e?.status === 503 || /UNAVAILABLE|high demand|overloaded/i.test(m)) return 'Gemini is very busy right now. We tried several models. Please tap Try again in a few seconds.';
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || /took too long/i.test(m)) return 'Gemini took too long to answer. Please tap Try again.';
  if (e?.status === 429 || /quota|rate/i.test(m)) return 'Gemini rate limit hit — wait a few seconds and try again.';
  if (/API key|PERMISSION_DENIED|401|403/i.test(m)) return 'Gemini API key problem — check GEMINI_API_KEY in .env.';
  return m.slice(0, 300);
}

// On Vercel the app is exported as a serverless function; locally it listens on PORT.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n🌱 Shamba Doctor running → http://localhost:${PORT}`);
    console.log(MOCK ? '   MODE: DEMO/MOCK (no Gemini key or --mock flag)\n' : `   MODE: LIVE Gemini · trying ${activeModels().text}\n`);
  });
}

export default app;
