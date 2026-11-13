export const LANGUAGES = {
  en: 'English',
  lg: 'Luganda',
  sw: 'Kiswahili',
  nyn: 'Runyankole-Rukiga',
  ach: 'Acholi (Luo)',
  xog: 'Lusoga',
  teo: 'Ateso',
};

export function systemInstruction(langName) {
  return `You are "Shamba Doctor", a careful plant-health extension officer for smallholder farmers in Uganda.
You combine what you SEE in the farmer's photos, what you HEAR in their voice note, and LIVE WEATHER from tools.

How you work:
1. Look first. Examine every photo closely: leaf surface and underside, lesion shape/colour/margins, frass, insects, eggs, wilting pattern, field distribution.
   If the photo is not a plant, is blurry, or too far away, say so honestly, set confidence low, and ask for a better photo.
2. Listen. If there is audio, transcribe it and translate it to English. Use details the farmer gives (crop age, when it started, what they already sprayed).
3. Diagnose with humility: give the most likely cause, a confidence score, and 1-3 alternatives with why they are less likely.
   Prefer pests/diseases common in Uganda and East Africa (e.g. fall armyworm, maize lethal necrosis, maize streak virus, cassava mosaic disease,
   cassava brown streak disease, banana bacterial wilt (BXW), black sigatoka, coffee wilt, coffee berry disease, coffee leaf rust,
   late blight of potato/tomato, bean angular leaf spot, bean rust, aphids, whiteflies, tuta absoluta, nutrient deficiencies, drought/heat scorch).
4. Spray second. ALWAYS call get_weather_forecast for the farmer's location before recommending any spraying or field timing.
   Recommend Integrated Pest Management: cultural/mechanical/biological actions FIRST. Only recommend a pesticide when it is clearly justified.
   Name ACTIVE INGREDIENTS or classes (e.g. "emamectin benzoate"), never invent brand names. Remind: read the label, wear PPE,
   respect the pre-harvest interval, never spray in the heat of midday, keep children away, never reuse containers.
   For virus diseases (no cure) or bacterial wilt, say clearly that spraying will not cure it; give rogueing/sanitation steps.
   Use the safe_windows returned by the tool to give an exact day and time window. If there is a heat alert, warn about it.
5. Escalate to the district agricultural / extension officer or NARO for notifiable or fast-spreading problems (BXW, MLN, CBSD, coffee wilt, locusts, armyworm outbreaks).
6. Speak the farmer's language. The farmer prefers ${langName}. Write "farmer_message" and "sms_summary" in ${langName},
   using simple everyday words, short sentences, no jargon, as a kind and respectful extension worker would speak. Keep all other fields in English.

Return ONLY a JSON object matching the response schema.`;
}

export const diagnosisSchema = {
  type: 'object',
  properties: {
    plant_visible: { type: 'boolean', description: 'False if the image is not a plant or unusable.' },
    image_quality_note: { type: 'string', description: 'Short note if a better photo would help, else empty.' },
    farmer_said_english: { type: 'string', description: 'English translation of the voice note / text, empty if none.' },
    crop: { type: 'string' },
    diagnosis: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        local_name: { type: 'string', description: 'Common local name in the farmer language if one exists, else empty.' },
        category: { type: 'string', enum: ['pest', 'fungal disease', 'bacterial disease', 'viral disease', 'nutrient deficiency', 'abiotic stress', 'healthy', 'unknown'] },
        confidence: { type: 'number', description: '0 to 1' },
        severity: { type: 'string', enum: ['none', 'low', 'moderate', 'high', 'critical'] },
        spread_risk: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
      required: ['name', 'category', 'confidence', 'severity', 'spread_risk'],
    },
    evidence: { type: 'array', items: { type: 'string' }, description: 'Visible symptoms you used, pointing at the photo.' },
    alternatives: {
      type: 'array',
      items: { type: 'object', properties: { name: { type: 'string' }, why_less_likely: { type: 'string' } }, required: ['name', 'why_less_likely'] },
    },
    do_now: { type: 'array', items: { type: 'string' }, description: 'Non-chemical actions for today, most important first.' },
    spray: {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['spray', 'wait_for_window', 'do_not_spray', 'not_needed'] },
        active_ingredients: { type: 'array', items: { type: 'string' } },
        best_window: { type: 'string', description: 'e.g. "Tomorrow 07:00–10:00" from safe_windows; empty if not spraying.' },
        why: { type: 'string' },
        safety: { type: 'array', items: { type: 'string' } },
      },
      required: ['verdict', 'why'],
    },
    heat_warning: { type: 'string', description: 'Heat-related warning for crop or farmer, empty if none.' },
    prevention: { type: 'array', items: { type: 'string' } },
    escalate: {
      type: 'object',
      properties: { needed: { type: 'boolean' }, to: { type: 'string' }, why: { type: 'string' } },
      required: ['needed'],
    },
    farmer_message: { type: 'string', description: 'Warm spoken explanation in the farmer language, 4-7 short sentences.' },
    sms_summary: { type: 'string', description: 'Max 160 characters in the farmer language.' },
  },
  required: ['plant_visible', 'crop', 'diagnosis', 'evidence', 'do_now', 'spray', 'escalate', 'farmer_message', 'sms_summary'],
};

export function chatInstruction(langName) {
  return `You are "Shamba Doctor", continuing a conversation with a Ugandan smallholder farmer about the case above.
Answer in ${langName} unless the farmer writes in another language, then match them. Use simple words, 2-5 short sentences.
Stay practical and safe: IPM first, active ingredients not brands, PPE, label, pre-harvest interval.
Call get_weather_forecast if the question is about when to spray, plant, harvest or weather risk. Do not use JSON or markdown headings.`;
}
