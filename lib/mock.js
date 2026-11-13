// Offline demo mode: used when no GEMINI_API_KEY is set or when started with --mock.
// Lets you rehearse the demo with zero network. Real mode is always preferred for judging.
import { getWeatherForecast } from './weather.js';

export async function mockDiagnosis({ location, gps }) {
  const weather = await getWeatherForecast({ location, ...(gps || {}) });
  const w = weather.safe_windows[0];
  const win = w ? `${w.start.replace('T', ' ')} – ${w.end.slice(11)}` : 'early tomorrow morning, before 10:00';
  return {
    weather,
    trace: [
      { type: 'tool_call', name: 'get_weather_forecast', args: { location } },
      { type: 'tool_result', name: 'get_weather_forecast', summary: `${weather.location}: ${weather.safe_windows.length} safe spray window(s) [${weather.source}]` },
    ],
    result: {
      plant_visible: true,
      image_quality_note: '',
      farmer_said_english: 'My maize leaves have holes and there is something like sawdust inside the funnel. It started last week.',
      crop: 'Maize (about 4–5 weeks old)',
      diagnosis: {
        name: 'Fall armyworm (Spodoptera frugiperda)', local_name: '',
        category: 'pest', confidence: 0.86, severity: 'moderate', spread_risk: 'high',
      },
      evidence: [
        'Ragged, window-pane holes on young leaves in the whorl',
        'Moist sawdust-like frass (droppings) inside the funnel',
        'Damage concentrated on the newest leaves',
      ],
      alternatives: [
        { name: 'Maize stalk borer', why_less_likely: 'Stalk borer leaves pin-hole "shot holes" in rows and tunnels in the stem, not wet frass in the whorl.' },
        { name: 'Maize streak virus', why_less_likely: 'MSV shows yellow streaks along veins, not chewed holes.' },
      ],
      do_now: [
        'Walk the field in a W pattern and check 20 plants in 5 spots; count plants with fresh damage.',
        'Hand-pick and crush caterpillars in the funnel early morning when they are active.',
        'Put a pinch of dry soil, ash or sand mixed with a little chili into each attacked funnel.',
        'Encourage natural enemies: avoid broad-spectrum sprays that kill wasps and ants.',
      ],
      spray: {
        verdict: 'wait_for_window',
        active_ingredients: ['Emamectin benzoate', 'Bacillus thuringiensis (Bt) — biological option'],
        best_window: win,
        why: 'More than 20% of young plants damaged justifies control. Spray directly into the funnel in a cool, calm window so it is not washed off or evaporated.',
        safety: ['Read the label and use the exact dose', 'Wear gloves, mask, long sleeves and boots', 'Keep children and animals away', 'Respect the pre-harvest interval on the label', 'Never wash equipment in a stream'],
      },
      heat_warning: weather.heat_alert ? `It will reach ${weather.heat_alert.peak_temp_c}°C — do not spray at midday; chemicals evaporate and you can get heat stress in protective clothing.` : '',
      prevention: ['Plant early and at the same time as neighbours', 'Intercrop maize with beans or desmodium (push-pull)', 'Scout twice a week for the first 6 weeks'],
      escalate: { needed: true, to: 'District Agricultural Officer', why: 'Fall armyworm spreads fast between farms; reporting helps an area-wide response.' },
      farmer_message: '(Demo mode — live mode answers in your chosen language.) Your maize is being eaten by fall armyworm. Check your plants every morning and pick the caterpillars out of the funnel by hand. You can put a little dry soil or ash into the funnel. If you must spray, do it in the cool hours shown, never at midday. Wear gloves and a mask.',
      sms_summary: 'Maize: fall armyworm. Check every morning, remove caterpillars. Spray only in cool morning window. Wear gloves & mask.',
    },
  };
}
