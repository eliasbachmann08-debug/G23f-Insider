// Kopiert die G23f-Einträge, die Elias selbst sieht, in seinen privaten Google-Kalender «G23f».
// Läuft stündlich als GitHub Action. Das Repo ist öffentlich und damit auch die Logs:
// Das Skript gibt deshalb nur Zahlen aus, nie Inhalte von Einträgen.
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { google } from 'googleapis';

const key = JSON.parse(process.env.GCP_SA_KEY || '{}');
const calendarId = process.env.G23F_CALENDAR_ID;
const owner = (process.env.G23F_OWNER || 'elias').toLowerCase();
if (!key.client_email || !calendarId) {
  console.error('GCP_SA_KEY oder G23F_CALENDAR_ID fehlt in den GitHub-Secrets.');
  process.exit(1);
}

const TZ = 'Europe/Zurich';
const KIND = { hausaufgabe: 'HA', test: 'Test', organisatorisch: 'Org.' };
const WINDOW_BACK = 14; // Tage in die Vergangenheit, die noch abgeglichen werden

initializeApp({ credential: cert(key), projectId: key.project_id });
const db = getFirestore();
const auth = new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/calendar.events'] });
const cal = google.calendar({ version: 'v3', auth });

const todayZh = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isYmd = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
// Google verlangt Termin-IDs aus 0-9 und a-v. Hex erfüllt das und bleibt pro Eintrag gleich.
const eventId = docId => 'g23f' + Buffer.from(docId).toString('hex');

const from = addDays(todayZh(), -WINDOW_BACK);

const handle = await db.collection('handles').doc(owner).get();
const uid = handle.exists ? handle.data().uid : null;
if (!uid) { console.error('Das Konto wurde in G23f nicht gefunden.'); process.exit(1); }

const [entrySnap, progressSnap] = await Promise.all([
  db.collection('eintraege').where('date', '>=', from).get(),
  db.collection('entryProgress').doc(uid).collection('items').get()
]);
const done = new Set(progressSnap.docs.filter(d => d.data().completed).map(d => d.id));

const visibleToOwner = e => {
  const v = e.visibility || 'alle';
  if (v === 'alle') return true;
  if (e.authorUid === uid) return true;
  return v === 'auswahl' && Array.isArray(e.visibleToUids) && e.visibleToUids.includes(uid);
};

const wanted = new Map();
for (const doc of entrySnap.docs) {
  const e = doc.data();
  if (!isYmd(e.date) || !visibleToOwner(e)) continue;
  const type = KIND[e.type] ? e.type : 'hausaufgabe';
  const title = type === 'organisatorisch'
    ? (e.thema || 'Organisatorisches')
    : [e.fach || 'Ohne Fach', e.thema].filter(Boolean).join(' – ');
  const last = type === 'organisatorisch' && isYmd(e.dateTo) && e.dateTo >= e.date ? e.dateTo : e.date;
  const tick = type === 'hausaufgabe' && done.has(doc.id) ? '✓ ' : '';
  wanted.set(eventId(doc.id), {
    id: eventId(doc.id),
    summary: `${tick}${KIND[type]}: ${title}`.slice(0, 250),
    description: [e.infos, e.linkUrl].filter(Boolean).join('\n\n').slice(0, 4000),
    start: { date: e.date },
    end: { date: addDays(last, 1) },
    transparency: 'transparent',
    colorId: type === 'test' ? '11' : type === 'organisatorisch' ? '5' : '9',
    extendedProperties: { private: { g23f: '1', typ: type } },
    // Tests: Erinnerung am Vorabend um 18:00
    reminders: type === 'test' ? { useDefault: false, overrides: [{ method: 'popup', minutes: 360 }] } : { useDefault: false, overrides: [] }
  });
}

const existing = new Map();
let pageToken;
do {
  const r = await cal.events.list({ calendarId, timeMin: from + 'T00:00:00Z', privateExtendedProperty: ['g23f=1'], maxResults: 2500, singleEvents: true, pageToken });
  for (const ev of r.data.items || []) existing.set(ev.id, ev);
  pageToken = r.data.nextPageToken;
} while (pageToken);

const same = (a, b) => a.summary === b.summary && (a.description || '') === (b.description || '') &&
  a.start?.date === b.start.date && a.end?.date === b.end.date && (a.colorId || '') === (b.colorId || '');

let added = 0, changed = 0, removed = 0, failed = 0;
for (const ev of wanted.values()) {
  const cur = existing.get(ev.id);
  try {
    if (!cur) {
      try { await cal.events.insert({ calendarId, requestBody: ev }); }
      catch (err) {
        // Früher gelöschte Termine behalten ihre ID. Dann wird der alte Termin wiederhergestellt.
        if (err.code !== 409) throw err;
        await cal.events.update({ calendarId, eventId: ev.id, requestBody: { ...ev, status: 'confirmed' } });
      }
      added++;
    } else if (!same(cur, ev)) {
      await cal.events.update({ calendarId, eventId: ev.id, requestBody: ev });
      changed++;
    }
  } catch (err) { failed++; console.error('Ein Termin konnte nicht übertragen werden, Code', err.code || 'unbekannt'); }
}
for (const [id, cur] of existing) {
  if (wanted.has(id) || !id.startsWith('g23f')) continue;
  if (cur.start?.date && cur.start.date < from) continue;
  try { await cal.events.delete({ calendarId, eventId: id }); removed++; }
  catch (err) { if (err.code !== 410) { failed++; console.error('Ein Termin konnte nicht gelöscht werden, Code', err.code || 'unbekannt'); } }
}

console.log(`G23f-Kalender: ${wanted.size} Einträge, ${added} neu, ${changed} geändert, ${removed} entfernt, ${failed} Fehler.`);
if (failed) process.exit(1);
