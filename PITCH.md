# Shamba Doctor — submission pack

## ⏰ Before 5:00 PM CAT (6:00 PM Kampala time)
1. Put your key in `.env` and run `npm start`. Do one real diagnosis by about 11:00 so there's time to tweak.
2. Collect **3 real photos**: maize with chewed leaves (fall armyworm), cassava with mosaic or yellow leaves, and a banana or bean leaf. Real field photos from your phone beat internet images.
3. Push to GitHub: `git init && git add . && git commit -m "Shamba Doctor" && gh repo create shamba-doctor --public --source . --push`
4. Record a **2-minute demo video** using the script below (the screen recorder on your phone or OBS is fine).
5. Submit on the MLH page: repo link, video, the text below, and pick **Best Use of the Google Gemini API**.

---

## Submission text (paste and edit)

**Tagline:** A crop doctor in your pocket that speaks your language and tells you *when* it's safe to spray — powered by Gemini.

**Inspiration**
Smallholder farmers in Uganda often diagnose crop problems by guesswork and spray pesticides "just in case", at the wrong time of day, in rising heat. Extension officers can't visit every farm. Our team (Flux Data) recently won first place at an agricultural data hackathon with "Look first, spray second", a voice-line idea. Today we turned it into a working AI product.

**What it does**
A farmer takes a photo of a sick plant and describes the problem by voice in Luganda, Runyankole, Acholi, Lusoga, Ateso, Kiswahili or English. Gemini:
- diagnoses the problem from the photos and voice note, showing its evidence, a confidence score and alternatives;
- **calls a live-weather tool** and returns a spray verdict with an exact *safe spray window* (temperature, wind, humidity, rain wash-off), plus heat warnings;
- gives a non-chemical-first action checklist and names active ingredients only when spraying is justified, with PPE and label safety;
- **reads the advice aloud** in the farmer's language with Gemini TTS, and produces an SMS/WhatsApp summary for farmer groups;
- flags notifiable outbreaks (e.g. banana bacterial wilt, fall armyworm), which appear on an **Outbreak Radar** that alerts extension officers when reports cluster.

**How we built it**
Node.js + Express, vanilla JS mobile web app, and the `@google/genai` SDK. One Gemini request carries the photos and the voice note (recorded in the browser and converted to 16 kHz WAV). Gemini runs as an agent with a function declaration, `get_weather_forecast`; our server calls Open-Meteo and runs a spray-window engine, then sends the result back. The final answer uses **structured output (JSON schema)** so the UI can render verdicts, severity and checklists reliably. Follow-up questions keep the full multimodal context. Gemini native TTS creates the spoken reply. The app falls back across Gemini model versions automatically.

**Challenges**
Combining function calling with structured JSON output in one agent loop; getting browser audio into a format Gemini accepts everywhere; and making spray advice *safe*: IPM first, no brand names, and honest "spraying won't cure this" answers for viral and bacterial diseases.

**Accomplishments**
A full multimodal → tool-calling → structured-output → speech loop running in a day, in local languages, with real weather.

**What we learned**
How to design Gemini as an agent that decides when it needs live data, and how much a strict response schema improves reliability.

**What's next**
A USSD/IVR version for feature phones (our original voice-line idea), a pilot with district agricultural officers, NARO-validated knowledge for grounding, and an offline-first PWA.

**Built with:** Google Gemini API, @google/genai, Node.js, Express, Open-Meteo, Leaflet, OpenStreetMap, Web Audio API, MediaRecorder

---

## 2-minute demo script

| Time | Show | Say |
|---|---|---|
| 0:00–0:15 | Title screen | "In Uganda, a farmer who sees holes in her maize usually sprays whatever the shop sells, at midday, in 30-degree heat. Shamba Doctor changes that: look first, spray second." |
| 0:15–0:45 | Add a maize photo, **record a voice note in Luganda**, location Mbale, language Luganda, then tap Diagnose | "She takes a photo and just *talks* in Luganda. One Gemini request gets the image and the audio." |
| 0:45–1:15 | Result hero → press ▶ **Listen** | "Gemini found fall armyworm, shows the evidence it saw, and answers *in Luganda, out loud*, because not every farmer reads." |
| 1:15–1:40 | Spray card + timeline, then expand **How Gemini worked this out** | "Here's the magic: Gemini decided on its own to call our live-weather tool. It says *don't spray now*; the safe window is tomorrow 7 to 10 AM, before the heat. Green bars are safe, red is above 30 degrees." |
| 1:40–1:50 | Follow-up chat: "Can I still eat the maize?" | "She can keep asking questions, with full context." |
| 1:50–2:00 | Outbreak radar with alerts | "Every case becomes an early warning for extension officers. Shamba Doctor: AI that protects crops, farmers and the environment." |

## Judge Q&A prep
- **"Is the diagnosis reliable?"** It shows a confidence score, evidence and alternatives, asks for a better photo when unsure, and escalates serious cases to extension officers. It supports officers; it doesn't replace them.
- **"Why Gemini?"** Photo, voice, local languages, tool calling, strict JSON and speech all come from one model family. Without it, this pipeline would need four or five separate services.
- **"Feature phones?"** Next step: the same agent behind USSD/IVR, which our earlier first-place hackathon idea already designed.
- **"Business model?"** Free for farmers. Paid dashboards and alerts for agro-input companies, NGOs, SACCOs/insurers and district local governments.
