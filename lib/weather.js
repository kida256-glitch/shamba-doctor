// Live weather + "safe spray window" engine.
// Uses Open-Meteo (free, no API key). Called by Gemini through function calling.

const UG_FALLBACK = {
  kampala: [0.3476, 32.5825], wakiso: [0.4044, 32.4594], mukono: [0.3533, 32.7553],
  mbale: [1.0827, 34.1750], gulu: [2.7724, 32.2881], lira: [2.2499, 32.8999],
  mbarara: [-0.6072, 30.6545], masaka: [-0.3338, 31.7341], jinja: [0.4244, 33.2042],
  kasese: [0.1833, 30.0833], hoima: [1.4331, 31.3524], arua: [3.0201, 30.9111],
  soroti: [1.7146, 33.6111], kabale: [-1.2486, 29.9899], fort_portal: [0.6710, 30.2750],
  iganga: [0.6092, 33.4686], luwero: [0.8492, 32.4731], masindi: [1.6744, 31.7150],
  tororo: [0.6928, 34.1809], kapchorwa: [1.3960, 34.4508], bushenyi: [-0.5853, 30.2114],
};

export async function geocode(place) {
  const key = String(place || '').trim().toLowerCase().replace(/\s+/g, '_');
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=5&language=en&format=json`;
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    const hit = (j.results || []).find(x => x.country_code === 'UG') || (j.results || [])[0];
    if (hit) return { lat: hit.latitude, lon: hit.longitude, name: `${hit.name}${hit.admin1 ? ', ' + hit.admin1 : ''}` };
  } catch { /* fall through */ }
  if (UG_FALLBACK[key]) return { lat: UG_FALLBACK[key][0], lon: UG_FALLBACK[key][1], name: place };
  return { lat: UG_FALLBACK.kampala[0], lon: UG_FALLBACK.kampala[1], name: `${place || 'Kampala'} (approx.)` };
}

// Agronomic rules of thumb for spraying (label always wins):
//  - temperature below ~28°C (volatilisation, drift, applicator heat stress in PPE)
//  - wind 3–15 km/h (calm = inversions & hanging fog; strong = drift)
//  - relative humidity above ~45% (droplets evaporate in dry air)
//  - low rain chance over the next 6 hours (wash-off)
//  - daylight only (06:00–18:00)
function scoreHour(h, next6RainMax) {
  const reasons = [];
  if (h.hour < 6 || h.hour >= 18) reasons.push('dark');
  if (h.temp > 28) reasons.push(`hot ${h.temp}°C`);
  if (h.wind > 15) reasons.push(`windy ${h.wind} km/h`);
  if (h.wind < 3) reasons.push('too calm (inversion risk)');
  if (h.rh < 45) reasons.push(`dry air ${h.rh}%`);
  if (next6RainMax >= 40) reasons.push(`rain likely within 6h (${next6RainMax}%)`);
  return reasons;
}

export function computeWindows(hours) {
  const scored = hours.map((h, i) => {
    const next6 = hours.slice(i, i + 6).map(x => x.rainProb ?? 0);
    const reasons = scoreHour(h, Math.max(0, ...next6));
    return { ...h, ok: reasons.length === 0, reasons };
  });
  const windows = [];
  let cur = null;
  for (const h of scored) {
    if (h.ok) {
      if (!cur) cur = { start: h.time, end: h.time, hours: [] };
      cur.end = h.time; cur.hours.push(h);
    } else if (cur) { windows.push(cur); cur = null; }
  }
  if (cur) windows.push(cur);
  const fmt = w => {
    const avg = k => Math.round(w.hours.reduce((s, x) => s + x[k], 0) / w.hours.length);
    const endHour = new Date(new Date(w.end + ':00Z').getTime() + 3600e3).toISOString().slice(0, 16);
    return { start: w.start, end: endHour, duration_hours: w.hours.length, avg_temp_c: avg('temp'), avg_wind_kmh: avg('wind'), avg_humidity: avg('rh') };
  };
  const hotHours = scored.filter(h => h.temp >= 30);
  return {
    hourly: scored.map(h => ({ t: h.time, temp: h.temp, rain: h.rainProb, wind: h.wind, ok: h.ok })),
    safe_windows: windows.map(fmt).slice(0, 4),
    heat_alert: hotHours.length
      ? { hours_at_or_above_30c: hotHours.length, peak_temp_c: Math.max(...hotHours.map(h => h.temp)), first_hot_hour: hotHours[0].time }
      : null,
    blocked_reasons_sample: scored.filter(h => !h.ok && h.hour >= 6 && h.hour < 18).slice(0, 6).map(h => ({ time: h.time, why: h.reasons })),
  };
}

// Forecasts change slowly: reuse one for 10 minutes so the tool call (and follow-up chat) answer instantly.
const cache = new Map();
export function getWeatherForecast(args = {}) {
  const { location, lat, lon } = args;
  const key = typeof lat === 'number' && typeof lon === 'number'
    ? `${lat.toFixed(2)},${lon.toFixed(2)}` : String(location || 'Kampala').trim().toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.promise;
  const promise = fetchForecast(args);
  cache.set(key, { at: Date.now(), promise });
  promise.then(r => { if (r.source !== 'open-meteo') cache.delete(key); }, () => cache.delete(key)); // never cache offline fallbacks
  return promise;
}

async function fetchForecast({ location, lat, lon } = {}) {
  let place;
  if (typeof lat === 'number' && typeof lon === 'number') place = { lat, lon, name: location || `${lat.toFixed(3)}, ${lon.toFixed(3)}` };
  else place = await geocode(location || 'Kampala');

  let hours;
  let source = 'open-meteo';
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
      `&hourly=temperature_2m,relative_humidity_2m,precipitation_probability,wind_speed_10m&forecast_days=2&timezone=Africa%2FKampala`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('weather http ' + r.status);
    const j = await r.json();
    const H = j.hourly;
    hours = H.time.map((t, i) => ({
      time: t, hour: Number(t.slice(11, 13)),
      temp: Math.round(H.temperature_2m[i]), rh: Math.round(H.relative_humidity_2m[i]),
      rainProb: H.precipitation_probability?.[i] ?? 0, wind: Math.round(H.wind_speed_10m[i]),
    }));
  } catch (e) {
    source = 'simulated (offline)';
    hours = simulatedHours();
  }

  // Only look forward from "now" (Kampala time)
  const nowLocal = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 13);
  const upcoming = hours.filter(h => h.time.slice(0, 13) >= nowLocal).slice(0, 36);
  const analysis = computeWindows(upcoming);
  return {
    location: place.name, lat: place.lat, lon: place.lon, source,
    now: upcoming[0] || null,
    next_hours: upcoming.filter((_, i) => i % 3 === 0).slice(0, 12)
      .map(h => ({ time: h.time, temp_c: h.temp, humidity: h.rh, rain_chance: h.rainProb, wind_kmh: h.wind })),
    ...analysis,
    rules_used: 'Spray only 06:00–18:00, temp ≤28°C, wind 3–15 km/h, humidity ≥45%, rain chance <40% for next 6h.',
  };
}

function simulatedHours() {
  const out = [];
  const start = new Date(Date.now() + 3 * 3600e3);
  start.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 48; i++) {
    const d = new Date(start.getTime() + i * 3600e3);
    const hour = d.getUTCHours();
    const temp = Math.round(19 + 11 * Math.max(0, Math.sin(((hour - 7) / 12) * Math.PI)));
    out.push({
      time: d.toISOString().slice(0, 16), hour, temp,
      rh: Math.round(90 - (temp - 19) * 3.5), rainProb: hour >= 14 && hour <= 17 ? 55 : 10,
      wind: hour < 8 ? 2 : hour < 12 ? 7 : 12,
    });
  }
  return out;
}

export const weatherToolDeclaration = {
  name: 'get_weather_forecast',
  description:
    'Get the live 36-hour hourly forecast for a farm location in Uganda and pre-computed SAFE PESTICIDE SPRAY WINDOWS ' +
    '(temperature, wind, humidity and rain-wash-off rules) plus heat alerts. Call this whenever spraying, timing of field work, ' +
    'heat stress or weather-driven disease risk is relevant.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      location: { type: 'string', description: 'District or town in Uganda, e.g. "Mbale" or "Luwero".' },
      lat: { type: 'number', description: 'Latitude if GPS is known.' },
      lon: { type: 'number', description: 'Longitude if GPS is known.' },
    },
  },
};
