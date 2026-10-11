// Holt Elias' WHOOP-Werte und trägt pro Tag einen Termin in seinen privaten Google-Kalender «WHOOP» ein.
// Die Zentrale liest diesen Kalender. Läuft stündlich als GitHub Action.
// Repo und Logs sind öffentlich: Das Skript gibt nur Zahlen und kurze Hinweise aus,
// nie Gesundheitswerte, Tokens, den Anmelde-Code oder die Kalender-ID.
import crypto from 'node:crypto';
import { google } from 'googleapis';

const done = msg => { console.log(`::notice::${msg}`); process.exit(0); };
const fail = msg => { console.log(`::error::${msg}`); process.exit(1); };
const LOGIN_PAGE = 'www.g23f-insider.ch/whoop.html';
let step = 'Start';
process.on('unhandledRejection', err => fail(explain(err)));
process.on('uncaughtException', err => fail(explain(err)));
function explain(err) {
  const c = err?.code ?? err?.status ?? err?.response?.status;
  const where = `Schritt «${step}», Code ${c ?? 'unbekannt'}`;
  if (step === 'WHOOP-Anmeldung') {
    if (c === 400) return `${where}: Der Code ist ungültig oder abgelaufen. Auf ${LOGIN_PAGE} neu anmelden und den Code innert weniger Minuten einfügen.`;
    if (c === 401) return `${where}: WHOOP_CLIENT_ID oder WHOOP_CLIENT_SECRET stimmt nicht.`;
  }
  if (step === 'WHOOP-Token erneuern' && (c === 400 || c === 401)) return `${where}: Die WHOOP-Anmeldung ist abgelaufen. Auf ${LOGIN_PAGE} neu anmelden.`;
  if (step === 'WHOOP-Daten holen') {
    if (c === 401 || c === 403) return `${where}: WHOOP verweigert den Zugriff. Auf ${LOGIN_PAGE} neu anmelden und alle Berechtigungen erlauben.`;
    if (c === 429) return `${where}: WHOOP-Limit erreicht. Der nächste Lauf versucht es wieder.`;
  }
  if (step.startsWith('Kalender')) {
    if (c === 404) return `${where}: Kalender nicht gefunden. WHOOP_CALENDAR_ID prüfen und ob «WHOOP» für das Dienstkonto freigegeben ist.`;
    if (c === 403) return `${where}: Kein Schreibrecht. Beim Kalender «WHOOP» für das Dienstkonto «Änderungen vornehmen» wählen.`;
  }
  if (step === 'Token lesen') return `${where}: Die gespeicherte Anmeldung passt nicht mehr (Client Secret geändert?). Auf ${LOGIN_PAGE} neu anmelden.`;
  return `${where} (${err?.name || 'Fehler'}).`;
}

const env = process.env;
let key;
try { key = JSON.parse(env.GCP_SA_KEY || '{}'); }
catch { fail('GCP_SA_KEY ist kein gültiges JSON.'); }
const calendarId = (env.WHOOP_CALENDAR_ID || '').trim();
const clientId = (env.WHOOP_CLIENT_ID || '').trim();
const clientSecret = (env.WHOOP_CLIENT_SECRET || '').trim();
const code = (env.WHOOP_CODE || '').trim();
// Solange die Einrichtung nicht fertig ist, endet der stündliche Lauf ohne Fehler (keine Fehler-Mails).
if (!key.client_email || !key.private_key || !calendarId || !clientId || !clientSecret) {
  const missing = [!key.client_email && 'GCP_SA_KEY', !calendarId && 'WHOOP_CALENDAR_ID', !clientId && 'WHOOP_CLIENT_ID', !clientSecret && 'WHOOP_CLIENT_SECRET'].filter(Boolean);
  if (code) fail(`Diese GitHub-Secrets fehlen noch: ${missing.join(', ')}.`);
  done(`WHOOP ist noch nicht eingerichtet. Es fehlen: ${missing.join(', ')}.`);
}

const REDIRECT = 'https://www.g23f-insider.ch/whoop.html';
const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const API = 'https://api.prod.whoop.com/developer/v2';
const STATE_ID = 'state00001';          // technischer Termin im Jahr 2000, hält die verschlüsselte Anmeldung
const DAYS = code ? 31 : 7;             // bei der Anmeldung einen Monat nachtragen, sonst die letzte Woche abgleichen
const sleep = ms => new Promise(r => setTimeout(r, ms));

const auth = new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/calendar.events'] });
const cal = google.calendar({ version: 'v3', auth });

// WHOOP gibt bei jeder Erneuerung ein neues Refresh-Token aus. Es wird verschlüsselt im Kalender gespeichert.
// Der Schlüssel wird aus dem Client Secret abgeleitet, das nur in den GitHub-Secrets liegt.
const aesKey = crypto.createHash('sha256').update('zentrale-whoop:' + clientSecret).digest();
const seal = text => {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
};
const unseal = b64 => {
  const b = Buffer.from(b64, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', aesKey, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
};

async function loadToken() {
  step = 'Kalender Anmeldung lesen';
  let ev;
  try { ev = (await cal.events.get({ calendarId, eventId: STATE_ID })).data; }
  catch (err) { if (err.code === 404 || err.code === 410) return null; throw err; }
  if (!ev || ev.status === 'cancelled') return null;
  const p = ev.extendedProperties?.private || {};
  const blob = Object.keys(p).filter(k => /^t\d+$/.test(k)).sort((a, b) => a.slice(1) - b.slice(1)).map(k => p[k]).join('');
  if (!blob) return null;
  step = 'Token lesen';
  return unseal(blob);
}

async function saveToken(refresh) {
  step = 'Kalender Anmeldung speichern';
  const blob = seal(refresh), priv = { zentrale: 'state' };
  for (let i = 0; i * 1000 < blob.length; i++) priv['t' + i] = blob.slice(i * 1000, (i + 1) * 1000);
  const body = {
    id: STATE_ID, status: 'confirmed', transparency: 'transparent',
    summary: 'Zentrale: technischer Eintrag, bitte nicht löschen',
    start: { date: '2000-01-01' }, end: { date: '2000-01-02' },
    extendedProperties: { private: priv }
  };
  for (let attempt = 1; ; attempt++) {
    try {
      try { await cal.events.update({ calendarId, eventId: STATE_ID, requestBody: body }); }
      catch (err) { if (err.code !== 404) throw err; await cal.events.insert({ calendarId, requestBody: body }); }
      return;
    } catch (err) {
      if (attempt >= 4) throw err;
      await sleep(2500 * attempt);
    }
  }
}

async function tokenRequest(params) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, client_id: clientId, client_secret: clientSecret })
  });
  if (!r.ok) { const e = new Error('Token'); e.code = r.status; throw e; }
  const j = await r.json();
  if (!j.access_token) { const e = new Error('Token'); e.code = 'ohne Token'; throw e; }
  return j;
}

// ---------- Anmelden oder Token erneuern ----------
let access;
if (code) {
  step = 'WHOOP-Anmeldung';
  const j = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT });
  if (!j.refresh_token) fail('WHOOP hat kein Refresh-Token geschickt. Bei der Anmeldung muss der dauerhafte Zugriff («offline») erlaubt sein.');
  await saveToken(j.refresh_token);
  access = j.access_token;
} else {
  const refresh = await loadToken();
  if (!refresh) done(`Noch nicht bei WHOOP angemeldet. Die Anmeldung auf ${LOGIN_PAGE} starten.`);
  step = 'WHOOP-Token erneuern';
  const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh, scope: 'offline' });
  // Das alte Token ist ab jetzt ungültig, darum das neue sofort sichern.
  try { await saveToken(j.refresh_token || refresh); }
  catch (err) { fail(`Die erneuerte WHOOP-Anmeldung konnte nicht gespeichert werden (Code ${err.code ?? 'unbekannt'}). Auf ${LOGIN_PAGE} neu anmelden.`); }
  access = j.access_token;
}

// ---------- WHOOP-Daten holen ----------
step = 'WHOOP-Daten holen';
const since = new Date(Date.now() - DAYS * 86400000).toISOString();
async function collection(path, optional = false) {
  const out = [];
  let next;
  for (let page = 0; page < 12; page++) {
    const u = new URL(API + path);
    u.searchParams.set('start', since);
    u.searchParams.set('limit', '25');
    if (next) u.searchParams.set('nextToken', next);
    let r;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await fetch(u, { headers: { Authorization: 'Bearer ' + access } });
      if (r.status !== 429) break;
      await sleep(6000 * (attempt + 1));
    }
    if (!r.ok) {
      if (optional && (r.status === 401 || r.status === 403 || r.status === 404)) return out;
      const e = new Error('WHOOP'); e.code = r.status; throw e;
    }
    const j = await r.json();
    out.push(...(j.records || []));
    next = j.next_token || j.nextToken;
    if (!next) break;
  }
  return out;
}
const [cycles, recoveries, sleeps, workouts] = await Promise.all([
  collection('/cycle'), collection('/recovery'), collection('/activity/sleep'), collection('/activity/workout', true)
]);

// ---------- Pro Tag zusammenfassen ----------
// Ein WHOOP-Tag beginnt mit dem Einschlafen am Vorabend. Er zählt für das Datum, an dem Elias aufwacht.
const offsetMin = off => { const m = /^([+-])(\d{2}):?(\d{2})$/.exec(off || ''); return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : 0; };
const localAt = (iso, off, plusH = 0) => new Date(Date.parse(iso) + (offsetMin(off) + plusH * 60) * 60000);
const ymdOf = (iso, off, plusH = 0) => localAt(iso, off, plusH).toISOString().slice(0, 10);
const hmOf = (iso, off) => localAt(iso, off).toISOString().slice(11, 16);
const r1 = x => Math.round(x * 10) / 10;
const minutes = ms => Math.round((ms || 0) / 60000);
const scored = x => x && x.score_state === 'SCORED' && x.score;

const sleepById = new Map(sleeps.map(s => [s.id, s]));
const recByCycle = new Map(recoveries.map(r => [r.cycle_id, r]));
const days = {};
const day = k => (days[k] ??= {});

for (const c of cycles) {
  if (!c.start) continue;
  const k = ymdOf(c.start, c.timezone_offset, 12), d = day(k);
  if (scored(c)) {
    d.strain = r1(c.score.strain);
    if (c.score.kilojoule != null) d.kcal = Math.round(c.score.kilojoule / 4.184);
    if (c.score.average_heart_rate != null) d.hrAvg = c.score.average_heart_rate;
    if (c.score.max_heart_rate != null) d.hrMax = c.score.max_heart_rate;
  }
  const rec = recByCycle.get(c.id);
  if (scored(rec)) {
    d.recovery = Math.round(rec.score.recovery_score);
    if (rec.score.hrv_rmssd_milli != null) d.hrv = Math.round(rec.score.hrv_rmssd_milli);
    if (rec.score.resting_heart_rate != null) d.rhr = Math.round(rec.score.resting_heart_rate);
    if (rec.score.spo2_percentage != null) d.spo2 = r1(rec.score.spo2_percentage);
    if (rec.score.skin_temp_celsius != null) d.skin = r1(rec.score.skin_temp_celsius);
  }
  const sl = (rec && sleepById.get(rec.sleep_id)) || sleeps.find(s => s.cycle_id === c.id && !s.nap);
  if (scored(sl) && !sl.nap) {
    const st = sl.score.stage_summary || {};
    const asleep = minutes((st.total_light_sleep_time_milli || 0) + (st.total_slow_wave_sleep_time_milli || 0) + (st.total_rem_sleep_time_milli || 0));
    d.sleepMin = asleep;
    d.sleep = r1(asleep / 60);
    d.deepMin = minutes(st.total_slow_wave_sleep_time_milli);
    d.remMin = minutes(st.total_rem_sleep_time_milli);
    if (sl.score.sleep_performance_percentage != null) d.sleepPerf = Math.round(sl.score.sleep_performance_percentage);
    if (sl.score.sleep_efficiency_percentage != null) d.sleepEff = Math.round(sl.score.sleep_efficiency_percentage);
    if (sl.score.sleep_consistency_percentage != null) d.sleepCons = Math.round(sl.score.sleep_consistency_percentage);
    if (sl.score.respiratory_rate != null) d.resp = r1(sl.score.respiratory_rate);
    const need = sl.score.sleep_needed;
    if (need) d.needMin = minutes((need.baseline_milli || 0) + (need.need_from_sleep_debt_milli || 0) + (need.need_from_recent_strain_milli || 0) + (need.need_from_recent_nap_milli || 0));
    d.bed = hmOf(sl.start, sl.timezone_offset);
    if (sl.end) d.wake = hmOf(sl.end, sl.timezone_offset);
  }
}
for (const s of sleeps) {
  if (!s.nap || !scored(s) || !s.end) continue;
  const st = s.score.stage_summary || {}, d = day(ymdOf(s.start, s.timezone_offset));
  d.napMin = (d.napMin || 0) + minutes((st.total_light_sleep_time_milli || 0) + (st.total_slow_wave_sleep_time_milli || 0) + (st.total_rem_sleep_time_milli || 0));
}
for (const w of workouts) {
  if (!scored(w) || !w.start) continue;
  const d = day(ymdOf(w.start, w.timezone_offset));
  const item = { sport: String(w.sport_name || 'Training').slice(0, 40), start: hmOf(w.start, w.timezone_offset), strain: r1(w.score.strain) };
  if (w.end) item.min = minutes(Date.parse(w.end) - Date.parse(w.start));
  if (w.score.distance_meter) item.km = r1(w.score.distance_meter / 1000);
  if (w.score.average_heart_rate) item.hrAvg = w.score.average_heart_rate;
  (d.workouts ??= []).push(item);
}

// ---------- In den Kalender schreiben ----------
const firstDay = since.slice(0, 10);
const nextDay = k => { const x = new Date(k + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
const hhmm = min => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
const wanted = [];
for (const [k, d] of Object.entries(days).sort()) {
  if (k < firstDay) continue;
  const parts = [];
  if (d.recovery != null) parts.push(`Recovery ${d.recovery} %`);
  if (d.sleepMin) parts.push(`Schlaf ${hhmm(d.sleepMin)} h`);
  if (d.strain != null) parts.push(`Strain ${d.strain}`);
  if (!parts.length) continue;
  if (d.workouts) d.workouts.sort((a, b) => a.start.localeCompare(b.start));
  wanted.push({
    id: 'tag' + k.replace(/-/g, ''),
    summary: 'WHOOP · ' + parts.join(' · '),
    description: JSON.stringify({ v: 1, day: k, ...d }),
    start: { date: k }, end: { date: nextDay(k) },
    transparency: 'transparent', colorId: '2',
    extendedProperties: { private: { zentrale: 'whoop' } }
  });
}

step = 'Kalender lesen';
const existing = new Map();
let pageToken;
do {
  const r = await cal.events.list({ calendarId, timeMin: firstDay + 'T00:00:00Z', privateExtendedProperty: ['zentrale=whoop'], maxResults: 250, singleEvents: true, pageToken });
  for (const ev of r.data.items || []) existing.set(ev.id, ev);
  pageToken = r.data.nextPageToken;
} while (pageToken);

step = 'Kalender schreiben';
let added = 0, changed = 0, failed = 0, firstCode;
for (const ev of wanted) {
  const cur = existing.get(ev.id);
  try {
    if (!cur) {
      try { await cal.events.insert({ calendarId, requestBody: ev }); }
      catch (err) { if (err.code !== 409) throw err; await cal.events.update({ calendarId, eventId: ev.id, requestBody: { ...ev, status: 'confirmed' } }); }
      added++;
    } else if (cur.summary !== ev.summary || (cur.description || '') !== ev.description) {
      await cal.events.update({ calendarId, eventId: ev.id, requestBody: ev });
      changed++;
    }
  } catch (err) { failed++; firstCode ??= `${err.code} ${err.errors?.[0]?.reason || ''}`.trim(); }
}

const summary = `WHOOP: ${wanted.length} Tage, ${added} neu, ${changed} geändert, ${failed} Fehler.${code ? ' Anmeldung gespeichert.' : ''}`;
console.log(failed ? `::error::${summary} Erster Fehlercode ${firstCode ?? 'unbekannt'}.` : `::notice::${summary}`);
if (failed) process.exit(1);
