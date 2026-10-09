// Kopiert die G23f-Einträge, die Elias selbst sieht, in seinen privaten Google-Kalender «G23f».
// Läuft stündlich als GitHub Action. Das Repo ist öffentlich und damit auch die Logs:
// Das Skript gibt deshalb nur Zahlen aus, nie Inhalte von Einträgen.
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { google } from 'googleapis';

// Fehler erscheinen als kurze Hinweise im Workflow, ohne Meldungstexte von Google oder Firebase,
// damit nie ein Teil des Schlüssels, der Kalender-ID oder eines Eintrags in den öffentlichen Logs landet.
const fail = msg => { console.log(`::error::${msg}`); process.exit(1); };
let step = 'Start';
process.on('unhandledRejection', err => fail(explain(err)));
process.on('uncaughtException', err => fail(explain(err)));
function explain(err) {
  const c = err?.code ?? err?.status ?? err?.response?.status;
  const where = `Schritt «${step}», Code ${c ?? 'unbekannt'}`;
  if (step === 'Firestore lesen') {
    if (c === 7 || c === 'permission-denied') return `${where}: Das Dienstkonto darf G23f nicht lesen. In IAM die Rolle «Cloud Datastore-Betrachter» prüfen.`;
    if (c === 5) return `${where}: Firestore-Datenbank nicht gefunden.`;
    if (c === 16) return `${where}: Schlüssel ungültig oder gelöscht.`;
  }
  if (step.startsWith('Kalender')) {
    if (c === 404) return `${where}: Kalender nicht gefunden. Kalender-ID prüfen und ob G23f für das Dienstkonto freigegeben ist.`;
    if (c === 403) return `${where}: Kein Schreibrecht. Bei der Freigabe «Änderungen an Terminen vornehmen» wählen und Calendar API prüfen.`;
    if (c === 400 && /invalid_grant/.test(String(err?.message))) return `${where}: Schlüssel ungültig oder gelöscht.`;
  }
  return `${where} (${err?.name || 'Fehler'}).`;
}

let key;
try { key = JSON.parse(process.env.GCP_SA_KEY || '{}'); }
catch { fail('GCP_SA_KEY ist kein gültiges JSON. Den ganzen Inhalt der Schlüsseldatei neu als Secret einfügen.'); }
const calendarId = (process.env.G23F_CALENDAR_ID || '').trim();
const owner = (process.env.G23F_OWNER || 'elias').toLowerCase();
if (!key.client_email || !key.private_key) fail('GCP_SA_KEY fehlt oder ist unvollständig.');
if (!calendarId) fail('G23F_CALENDAR_ID fehlt in den GitHub-Secrets.');

const TZ = 'Europe/Zurich';
const KIND = { hausaufgabe: 'HA', test: 'Test', organisatorisch: 'Org.' };
const WINDOW_BACK = 14; // Tage in die Vergangenheit, die noch abgeglichen werden

step = 'Schlüssel laden';
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

step = 'Firestore lesen';
const handle = await db.collection('handles').doc(owner).get();
const uid = handle.exists ? handle.data().uid : null;
if (!uid) fail('Das Konto wurde in G23f nicht gefunden.');

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
    summary: `${tick}${KIND[type]}: ${title}`.replace(/\s*\n+\s*/g, ' · ').slice(0, 250),
    description: [e.infos, e.linkUrl].filter(Boolean).join('\n\n').slice(0, 4000),
    start: { date: e.date },
    end: { date: addDays(last, 1) },
    transparency: 'transparent',
    colorId: type === 'test' ? '11' : type === 'organisatorisch' ? '5' : '9',
    // Erinnerungen gelten pro Person. Elias stellt sie in den Einstellungen des Kalenders G23f ein.
    extendedProperties: { private: { g23f: '1', typ: type } }
  });
}

step = 'Kalender lesen';
const existing = new Map();
let pageToken;
do {
  const r = await cal.events.list({ calendarId, timeMin: from + 'T00:00:00Z', privateExtendedProperty: ['g23f=1'], maxResults: 2500, singleEvents: true, pageToken });
  for (const ev of r.data.items || []) existing.set(ev.id, ev);
  pageToken = r.data.nextPageToken;
} while (pageToken);

const same = (a, b) => a.summary === b.summary && (a.description || '') === (b.description || '') &&
  a.start?.date === b.start.date && a.end?.date === b.end.date && (a.colorId || '') === (b.colorId || '');

step = 'Kalender schreiben';
let added = 0, changed = 0, removed = 0, failed = 0, firstCode;
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
  } catch (err) { failed++; firstCode ??= `${err.code} ${err.errors?.[0]?.reason || ''}`.trim(); }
}
for (const [id, cur] of existing) {
  if (wanted.has(id) || !id.startsWith('g23f')) continue;
  if (cur.start?.date && cur.start.date < from) continue;
  try { await cal.events.delete({ calendarId, eventId: id }); removed++; }
  catch (err) { if (err.code !== 410) { failed++; firstCode ??= `${err.code} ${err.errors?.[0]?.reason || ''}`.trim(); } }
}

const summary = `G23f-Kalender: ${wanted.size} Einträge, ${added} neu, ${changed} geändert, ${removed} entfernt, ${failed} Fehler.`;
console.log(failed ? `::error::${summary} Erster Fehlercode ${firstCode ?? 'unbekannt'}.` : `::notice::${summary}`);
if (failed) process.exit(1);
