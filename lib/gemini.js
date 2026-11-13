import { GoogleGenAI } from '@google/genai';
import { getWeatherForecast, weatherToolDeclaration } from './weather.js';

// Ordered by what responded fastest/most reliably on 13 Nov 2026; the app falls through on overload or timeout.
const TEXT_MODELS = [
  process.env.GEMINI_MODEL,
  'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-flash-latest',
].filter(Boolean);
const TTS_MODELS = [process.env.GEMINI_TTS_MODEL, 'gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts'].filter(Boolean);
const CALL_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 60000);

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

const isModelMissing = e => {
  const m = String(e?.message || e);
  return e?.status === 404 || /not found|is not supported|unknown model|does not exist|deprecated|shut down|no longer available/i.test(m);
};
// Overloaded, rate-limited or slow: another model may still answer.
const isTransient = e => {
  const m = String(e?.message || e);
  return [429, 500, 503, 504].includes(e?.status) || e?.name === 'AbortError' || e?.name === 'TimeoutError' ||
    /UNAVAILABLE|high demand|overloaded|RESOURCE_EXHAUSTED|timed? ?out|aborted/i.test(m);
};

// Try models in order until one exists for this API key; remember the winner.
async function generate(kind, params) {
  const list = working[kind] ? [working[kind], ...(kind === 'text' ? TEXT_MODELS : TTS_MODELS).filter(m => m !== working[kind])]
    : (kind === 'text' ? TEXT_MODELS : TTS_MODELS);
  let lastErr;
  for (const model of list) {
    try {
      const config = { ...(params.config || {}), abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS) };
      const res = await client().models.generateContent({ model, ...params, config });
      working[kind] = model;
      return res;
    } catch (e) {
      lastErr = e;
      if (isModelMissing(e) || isTransient(e)) {
        console.warn(`[gemini] ${model} failed (${e?.status || e?.name}: ${String(e?.message).slice(0, 80)}), trying next…`);
        if (working[kind] === model) working[kind] = null;
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

let schemaWithToolsOK = true;

/**
 * Agentic loop: Gemini sees photos + audio, decides to call the live weather tool,
 * we execute it, feed results back, and Gemini returns a structured JSON diagnosis.
 */
export async function runAgent({ contents, system, schema, gps, trace = [] }) {
  const tools = [{ functionDeclarations: [weatherToolDeclaration] }];
  let weather = null;

  for (let step = 0; step < 5; step++) {
    const config = { systemInstruction: system, tools, temperature: 0.3 };
    if (schema && schemaWithToolsOK) { config.responseMimeType = 'application/json'; config.responseJsonSchema = schema; }

    let res;
    try {
      res = await generate('text', { contents, config });
    } catch (e) {
      // Older models can't combine function calling with JSON schema: degrade gracefully.
      if (schema && schemaWithToolsOK && e?.status === 400) {
        schemaWithToolsOK = false;
        trace.push({ type: 'note', text: 'Model rejected schema+tools combo; falling back to JSON-by-instruction.' });
        step--; continue;
      }
      throw e;
    }

    const calls = res.functionCalls || [];
    if (calls.length) {
      contents.push(res.candidates[0].content); // keeps thought signatures intact
      const parts = [];
      for (const call of calls) {
        const args = { ...(call.args || {}) };
        if (gps && typeof args.lat !== 'number') { args.lat = gps.lat; args.lon = gps.lon; }
        trace.push({ type: 'tool_call', name: call.name, args: { location: args.location, lat: args.lat, lon: args.lon } });
        let result;
        try {
          result = call.name === 'get_weather_forecast' ? await getWeatherForecast(args) : { error: 'unknown tool' };
        } catch (err) { result = { error: String(err.message || err) }; }
        if (call.name === 'get_weather_forecast' && !result.error) weather = result;
        trace.push({ type: 'tool_result', name: call.name, summary: summarizeWeather(result) });
        parts.push({ functionResponse: { name: call.name, id: call.id, response: { result } } });
      }
      contents.push({ role: 'user', parts });
      continue;
    }

    const text = res.text || '';
    contents.push(res.candidates?.[0]?.content || { role: 'model', parts: [{ text }] });
    return { text, weather, model: working.text, trace, usage: res.usageMetadata };
  }
  throw new Error('Agent did not finish in 5 steps');
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
  const res = await generate('tts', {
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
