import { GoogleGenAI } from '@google/genai';
import { getWeatherForecast, weatherToolDeclaration } from './weather.js';

// Flash-Lite with low thinking answers a full diagnosis in ~4–6 s; bigger Flash models are
// slower (20 s+) and often overloaded, so they are backups. Measured 13 Nov 2026.
const TEXT_MODELS = [
  process.env.GEMINI_MODEL,
  'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-flash-latest',
].filter(Boolean);
const TTS_MODELS = [process.env.GEMINI_TTS_MODEL, 'gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts'].filter(Boolean);
const THINKING = { thinkingLevel: process.env.GEMINI_THINKING || 'low' };
const HEDGE_MS = { text: Number(process.env.GEMINI_HEDGE_MS || 7000), tts: 5000 }; // start a backup model if no answer by then
const MAX_PARALLEL = 3;
const DEADLINE_MS = Number(process.env.GEMINI_TIMEOUT_MS || 35000);

let ai = null;
export function geminiReady() { return Boolean(process.env.GEMINI_API_KEY); }
function client() {
  // v1beta is required for speechConfig (TTS) and responseJsonSchema.
  if (!ai) ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: { apiVersion: process.env.GEMINI_API_VERSION || 'v1beta', ...(process.env.GEMINI_BASE_URL ? { baseUrl: process.env.GEMINI_BASE_URL } : {}) },
  });
  return ai;
}

const working = { text: null, tts: null };
export function activeModels() { return { text: working.text || TEXT_MODELS[0], tts: working.tts || TTS_MODELS[0] }; }

const isModelMissing = e => e?.status === 404 ||
  /not found|is not supported|unknown model|does not exist|deprecated|shut down|no longer available/i.test(String(e?.message || e));
// Overloaded, rate-limited or slow: another model (or a retry) may still answer.
export const isTransient = e => [429, 500, 503, 504].includes(e?.status) || e?.name === 'AbortError' || e?.name === 'TimeoutError' ||
  /UNAVAILABLE|high demand|overloaded|RESOURCE_EXHAUSTED|timed? ?out|took too long|aborted/i.test(String(e?.message || e));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Hedged generation: start the preferred model; if it errors, or is still silent after HEDGE_MS,
 * start the next model in parallel. The first good answer wins and the rest are cancelled.
 * If every model is overloaded, wait briefly and run one more round.
 */
async function generate(kind, params, emit = () => {}) {
  const all = kind === 'text' ? TEXT_MODELS : TTS_MODELS;
  const order = working[kind] ? [working[kind], ...all.filter(m => m !== working[kind])] : [...all];
  for (let round = 0; ; round++) {
    try {
      return await hedgedRound(kind, order, params, emit);
    } catch (e) {
      if (round === 0 && isTransient(e)) {
        emit({ type: 'note', text: 'Gemini is busy, retrying…' });
        await sleep(1500);
        continue;
      }
      throw e;
    }
  }
}

function hedgedRound(kind, order, params, emit) {
  return new Promise((resolve, reject) => {
    let next = 0, inFlight = 0, done = false, timer = null;
    const errors = [], controllers = [];
    const stop = () => { done = true; clearTimeout(timer); clearTimeout(deadline); };
    const fail = e => { if (done) return; stop(); controllers.forEach(c => c.abort()); reject(e); };
    const deadline = setTimeout(() => fail(Object.assign(new Error('Gemini took too long to answer'), { name: 'TimeoutError' })), DEADLINE_MS);

    function launch() {
      if (done) return;
      clearTimeout(timer);
      if (next >= order.length) {
        if (inFlight === 0) fail(errors.find(e => !isTransient(e) && !isModelMissing(e)) || errors.at(-1));
        return;
      }
      const model = order[next++];
      const ctrl = new AbortController();
      controllers.push(ctrl); inFlight++;
      if (next > 1) emit({ type: 'backup', model });
      const config = { ...(params.config || {}), ...(kind === 'text' ? { thinkingConfig: THINKING } : {}), abortSignal: ctrl.signal };
      client().models.generateContent({ model, ...params, config }).then(res => {
        inFlight--;
        if (done) return;
        stop();
        controllers.forEach(c => c !== ctrl && c.abort());
        working[kind] = model;
        resolve({ res, model });
      }, e => {
        inFlight--;
        if (done) return;
        errors.push(e);
        console.warn(`[gemini] ${model} failed (${e?.status || e?.name}: ${String(e?.message).slice(0, 90)})`);
        if (working[kind] === model) working[kind] = null;
        launch();
      });
      // Hedge: if this model is slow, start the next one alongside it.
      if (inFlight < MAX_PARALLEL) timer = setTimeout(launch, HEDGE_MS[kind]);
    }
    launch();
  });
}

let schemaWithToolsOK = true;

/**
 * Agentic loop: Gemini sees photos + audio, decides to call the live weather tool,
 * we execute it (usually instantly, from a forecast prefetched when the request arrived),
 * feed results back, and Gemini returns a structured JSON diagnosis.
 */
export async function runAgent({ contents, system, schema, gps, trace = [], emit = () => {}, weatherPromise }) {
  const tools = [{ functionDeclarations: [weatherToolDeclaration] }];
  let weather = null, model = null, step = 0;
  const log = item => { trace.push(item); emit(item); };

  while (step < 5) {
    const config = { systemInstruction: system, tools, temperature: 0.3 };
    if (schema && schemaWithToolsOK) { config.responseMimeType = 'application/json'; config.responseJsonSchema = schema; }

    let out;
    try {
      emit({ type: 'thinking', step });
      out = await generate('text', { contents, config }, emit);
    } catch (e) {
      // Some models can't combine function calling with a JSON schema: degrade gracefully.
      if (schema && schemaWithToolsOK && e?.status === 400) {
        schemaWithToolsOK = false;
        log({ type: 'note', text: 'Model rejected schema+tools combo; falling back to JSON-by-instruction.' });
        continue;
      }
      throw e;
    }
    step++;
    const { res } = out;
    model = out.model;

    const calls = res.functionCalls || [];
    if (calls.length) {
      contents.push(res.candidates[0].content); // keeps thought signatures intact
      const parts = [];
      for (const call of calls) {
        const args = { ...(call.args || {}) };
        if (gps && typeof args.lat !== 'number') { args.lat = gps.lat; args.lon = gps.lon; }
        log({ type: 'tool_call', name: call.name, model, args: { location: args.location, lat: args.lat, lon: args.lon } });
        let result;
        try {
          if (call.name !== 'get_weather_forecast') result = { error: 'unknown tool' };
          else result = weatherPromise && !args.lat && !differentPlace(args.location, contents) ? await weatherPromise : await getWeatherForecast(args);
        } catch (err) { result = { error: String(err.message || err) }; }
        if (call.name === 'get_weather_forecast' && !result.error) weather = result;
        log({ type: 'tool_result', name: call.name, summary: summarizeWeather(result) });
        parts.push({ functionResponse: { name: call.name, id: call.id, response: { result } } });
      }
      contents.push({ role: 'user', parts });
      continue;
    }

    const text = res.text || '';
    contents.push(res.candidates?.[0]?.content || { role: 'model', parts: [{ text }] });
    return { text, weather, model, trace, usage: res.usageMetadata };
  }
  throw new Error('Agent did not finish in 5 steps');
}

// The prefetched forecast is for the farm location in the first message; only skip it if Gemini asks about somewhere else.
function differentPlace(asked, contents) {
  if (!asked) return false;
  const first = contents[0]?.parts?.map(p => p.text || '').join(' ').toLowerCase() || '';
  return !first.includes(String(asked).split(',')[0].trim().toLowerCase());
}

function summarizeWeather(r) {
  if (!r || r.error) return r?.error || 'no data';
  const w = r.safe_windows?.[0];
  return `${r.location}: now ${r.now?.temp ?? '?'}°C · ${r.safe_windows?.length || 0} safe spray window(s)` +
    (w ? `, first ${w.start.replace('T', ' ')}` : '') + (r.heat_alert ? ` · heat peak ${r.heat_alert.peak_temp_c}°C` : '') + ` [${r.source}]`;
}

export function parseJSON(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { /* try to extract */ }
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) return JSON.parse(t.slice(s, e + 1));
  throw new Error('Model did not return JSON');
}

// Gemini native text-to-speech -> WAV buffer
export async function speak(text, langName) {
  const { res } = await generate('tts', {
    contents: [{ parts: [{ text: `Read this aloud in ${langName}, slowly and warmly, like a kind agricultural extension officer talking to a farmer:\n\n${text}` }] }],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.GEMINI_VOICE || 'Sulafat' } } },
    },
  });
  const part = res.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
  if (!part) throw new Error('No audio returned');
  const pcm = Buffer.from(part.inlineData.data, 'base64');
  if (/wav/i.test(part.inlineData.mimeType || '') || pcm.subarray(0, 4).toString() === 'RIFF') return pcm; // already WAV
  const rate = Number((part.inlineData.mimeType || '').match(/rate=(\d+)/)?.[1] || 24000);
  return pcmToWav(pcm, rate);
}

function pcmToWav(pcm, sampleRate, channels = 1, bits = 16) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * channels * bits / 8, 28);
  h.writeUInt16LE(channels * bits / 8, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
