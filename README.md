# 🌱 Shamba Doctor — *look first, spray second*

A farmer snaps a photo of a sick crop and describes the problem by voice in **Luganda, Runyankole, Acholi, Lusoga, Ateso, Kiswahili or English**.
**Gemini** looks at the photo, listens to the voice note, **calls a live-weather tool** to find a *safe spray window*, and replies with:

- a diagnosis with a confidence score, visible evidence and alternatives
- a **non-chemical-first action plan** (Integrated Pest Management)
- a **spray verdict + exact time window**, using live temperature, wind, humidity and rain wash-off rules, with heat alerts
- a spoken answer in the farmer's language (Gemini TTS), an SMS/WhatsApp summary for their farmer group
- an **escalation flag** for notifiable outbreaks, feeding an **Outbreak Radar** for extension officers

Built at **Hack Days Kampala (MLH), MUBS — Best Use of the Google Gemini API**.

---

## How it uses Gemini

| Gemini capability | Where |
|---|---|
| **Multimodal input**: up to 4 photos + a voice note in one request | `server.js` → `/api/diagnose` |
| **Function calling / agent loop**: Gemini decides to call `get_weather_forecast`, we run it (Open-Meteo), feed the result back | `lib/gemini.js` → `runAgent()` |
| **Structured output**: `responseJsonSchema` with enums for category, severity, spread risk and spray verdict | `lib/prompts.js` → `diagnosisSchema` |
| **Multilingual reasoning**: speech transcribed and translated to English; answers written back in the farmer's language | `systemInstruction()` |
| **Native text-to-speech** reads the advice aloud for low-literacy users | `lib/gemini.js` → `speak()` |
| **Multi-turn chat** keeps the photos and tool results in context, and can re-check the weather | `/api/chat` |
| **Fast & resilient**: Flash-Lite with low thinking (~8 s per diagnosis); if a model is busy (503) or slow, a backup model is raced in parallel and the first answer wins | `generate()` in `lib/gemini.js` |
| **Live progress**: the diagnosis streams each agent step (tool call, weather result, backup model) to the UI as it happens | `/api/diagnose` (NDJSON) |

## Run it (Windows, macOS or Linux)

```bash
cd Desktop/shamba-doctor
npm install
copy .env.example .env        # macOS/Linux: cp .env.example .env
# open .env and paste your key from https://aistudio.google.com/apikey
npm start                     # → http://localhost:3000
```

- **No key or bad Wi-Fi?** `npm run mock` runs a full offline demo with canned results and simulated weather. Use it for rehearsal and as an emergency backup only.
- **On a phone:** the camera works over plain HTTP on your LAN, but the **microphone and GPS need HTTPS**. Run `npx localtunnel --port 3000` (or ngrok) and open the https URL on the phone.
- **Outbreak radar:** the "Load sample reports" button adds 8 clearly-labelled sample reports so the map isn't empty during the demo.

## Architecture

```
Phone browser (camera, mic → 16 kHz WAV, GPS)
        │  JSON (base64 photos + audio)
        ▼
Node/Express ──► Gemini (multimodal + tools + JSON schema)
   │                 │ functionCall: get_weather_forecast
   │◄────────────────┘
   ├─► Open-Meteo forecast → spray-window engine (lib/weather.js)
   ├─► Gemini TTS → WAV
   └─► data/cases.json → Outbreak radar (Leaflet map)
```

Spray-window rules (from standard pesticide application guidance; the product label always wins): daylight only, ≤28 °C, wind 3–15 km/h, humidity ≥45 %, rain chance under 40 % for the next 6 hours.

## Safety

The app names **active ingredients, never brands**. It always puts non-chemical steps first, tells farmers when spraying *won't* help (viruses, bacterial wilt), and repeats PPE, label and pre-harvest-interval guidance. It refers notifiable diseases to district agricultural officers and NARO. It is a decision-support tool, not a replacement for an extension officer.
