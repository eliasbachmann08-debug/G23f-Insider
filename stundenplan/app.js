import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc,
  deleteDoc, onSnapshot, query, where, serverTimestamp, Timestamp,
  runTransaction, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged, browserLocalPersistence, setPersistence, deleteUser
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCe36w6HmFGScPaSjbFRkxrvuD9VCNrqDk",
  authDomain: "g23f-studenplan.firebaseapp.com",
  projectId: "g23f-studenplan",
  storageBucket: "g23f-studenplan.firebasestorage.app",
  messagingSenderId: "585686898310",
  appId: "1:585686898310:web:3712285a4380ae380b6307"
};

const ADMIN_EMAIL = "eliasbachmann08@gmail.com";

const COLLECTIONS = {
  entries: "eintraege",
  users: "users",
  members: "members",
  handles: "handles",
  tickets: "registrationTickets",
  reports: "reports"
};

const FALLBACK_SUBJECTS = [
  "Geschichte", "Mathematik", "Deutsch", "Französisch", "Englisch",
  "Biologie", "Physik", "Geografie", "Philosophie",
  "Schwerpunktfach Mathe", "Schwerpunktfach Physik"
];

const TYPE_META = {
  hausaufgabe: { short: "HA", long: "Hausaufgabe", icon: "✏️" },
  test: { short: "Test", long: "Test / Prüfung", icon: "📝" },
  organisatorisch: { short: "Org.", long: "Organisatorisch", icon: "📌" }
};

const app = initializeApp(FIREBASE_CONFIG);
const db = getFirestore(app);
const auth = getAuth(app);
await setPersistence(auth, browserLocalPersistence);

const $ = id => document.getElementById(id);

let currentUser = null;
let currentProfile = null;
let allUsers = [];
let subjects = [...FALLBACK_SUBJECTS];
let entries = [];
let currentView = "week";
let currentFilter = "all";
let selectedDate = startOfToday();
let activeDay = null;
let editingEntryId = null;
let selectedType = "hausaufgabe";
let selectedVisibility = "alle";
let selectedPeople = [];
let reportTarget = null;
let openReports = [];
let authFlowBusy = false;
let sessionRun = 0;
let migrationStarted = false;
let toastTimer = null;

const entryUnsubscribers = [];
let reportsUnsubscribe = null;
const entrySources = new Map();
const sourceReady = new Set();

function isAdmin() {
  return currentUser?.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase();
}

function cleanName(value) {
  return String(value || "").normalize("NFC").trim().replace(/\s+/g, " ");
}

function normalizeName(value) {
  // Firestore Rules use String.lower(); using the same operation here makes
  // the unique first-name handle case-insensitive on both sides.
  return cleanName(value).toLowerCase();
}

function validFirstName(value) {
  const name = cleanName(value);
  return name.length >= 2 && name.length <= 24 && /^[\p{L}][\p{L}\p{M}' -]*$/u.test(name);
}

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeId(value) {
  return escapeHTML(encodeURIComponent(String(value || "")));
}

function decodeId(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function cloneDate(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dateString(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseDate(value) {
  if (!value) return startOfToday();
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addDays(date, amount) {
  const copy = cloneDate(date);
  copy.setDate(copy.getDate() + amount);
  return copy;
}

function startOfWeek(date) {
  const copy = cloneDate(date);
  const weekday = copy.getDay();
  copy.setDate(copy.getDate() + (weekday === 0 ? -6 : 1 - weekday));
  return copy;
}

function sameDate(a, b) {
  return dateString(a) === dateString(b);
}

function isToday(value) {
  const date = value instanceof Date ? value : parseDate(value);
  return sameDate(date, startOfToday());
}

function swissWeekNumber(date) {
  const target = cloneDate(date);
  target.setDate(target.getDate() + 3 - ((target.getDay() + 6) % 7));
  const weekOne = new Date(target.getFullYear(), 0, 4);
  return 1 + Math.round(((target - weekOne) / 86400000 - 3 + ((weekOne.getDay() + 6) % 7)) / 7);
}

function shortDate(date) {
  return date.toLocaleDateString("de-CH", { day: "numeric", month: "short" });
}

function longDate(date) {
  return date.toLocaleDateString("de-CH", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function timestampDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value === "number") return new Date(value);
  if (value.seconds) return new Date(value.seconds * 1000);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatTimestamp(value) {
  const date = timestampDate(value);
  if (!date) return "";
  return `${date.toLocaleDateString("de-CH", { day: "numeric", month: "short", year: "numeric" })}, ${date.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" })}`;
}

function entryCoversDate(entry, value) {
  const end = entry.dateTo || entry.date;
  return value >= entry.date && value <= end;
}

function entryTitle(entry) {
  return entry.type === "organisatorisch" ? (entry.thema || "Organisatorisches") : (entry.fach || "Ohne Fach");
}

function profileFor(uid) {
  return allUsers.find(user => user.uid === uid) || (uid === currentUser?.uid ? currentProfile : null);
}

function avatarColor(uid) {
  let hash = 0;
  for (const char of String(uid || "G23f")) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 38% 48%)`;
}

function initials(name) {
  return cleanName(name).split(" ").filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "?";
}

function avatarHTML(profile, sizeClass = "") {
  const name = profile?.nickname || "Unbekannt";
  if (profile?.photoData) {
    return `<img class="avatar ${sizeClass}" src="${escapeHTML(profile.photoData)}" alt="Profilbild von ${escapeHTML(name)}">`;
  }
  return `<span class="avatar-fallback ${sizeClass}" style="background:${avatarColor(profile?.uid)}" aria-hidden="true">${escapeHTML(initials(name))}</span>`;
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(screen => screen.classList.toggle("active", screen.id === id));
  const inApp = id === "screen-app";
  document.body.classList.toggle("app-active", inApp);
  $("header-account").hidden = !inApp;
}

function showLoading(message = "Lädt …") {
  $("loading-text").textContent = message;
  $("loading-layer").hidden = false;
}

function hideLoading() {
  $("loading-layer").hidden = true;
}

function setError(id, message = "") {
  const element = $(id);
  element.textContent = message;
  element.classList.toggle("visible", Boolean(message));
}

function setButtonBusy(button, busy, busyText = "Bitte warten …") {
  if (!button.dataset.defaultText) button.dataset.defaultText = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? busyText : button.dataset.defaultText;
}

function toast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").classList.add("show");
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3200);
}

function authErrorMessage(error) {
  const messages = {
    "auth/email-already-in-use": "Diese E-Mail ist bereits registriert. Melde dich stattdessen an.",
    "auth/invalid-email": "Die E-Mail-Adresse ist ungültig.",
    "auth/weak-password": "Das persönliche Passwort muss mindestens 6 Zeichen haben.",
    "auth/user-not-found": "Für diese E-Mail wurde kein Konto gefunden.",
    "auth/wrong-password": "E-Mail oder persönliches Passwort stimmt nicht.",
    "auth/invalid-credential": "E-Mail oder persönliches Passwort stimmt nicht.",
    "auth/too-many-requests": "Zu viele Versuche. Warte kurz und probiere es erneut.",
    "auth/network-request-failed": "Keine Verbindung. Prüfe dein Internet.",
    "permission-denied": "Die Berechtigung fehlt. Prüfe das Klassenpasswort oder melde dich bei Elias."
  };
  if (error?.code === "name-taken" || error?.message === "NAME_TAKEN") {
    return "Dieser Vorname wird bereits verwendet. Melde dich bei Elias, falls das nicht stimmen kann.";
  }
  if (error?.code === "class-password" || error?.message === "CLASS_PASSWORD") {
    return "Das Klassenpasswort stimmt nicht.";
  }
  return messages[error?.code] || "Das hat nicht funktioniert. Versuch es nochmals oder melde dich bei Elias.";
}

async function createRegistrationTicket(user, nickname, classPassword) {
  const ticketId = user.uid;
  const nicknameKey = normalizeName(nickname);
  try {
    // The matching password lives only in the unreadable config/registration
    // Firestore document. Security Rules approve or reject this short-lived
    // ticket; the password is never part of the GitHub source.
    await setDoc(doc(db, COLLECTIONS.tickets, ticketId), {
      uid: user.uid,
      email: user.email.trim().toLowerCase(),
      nickname: cleanName(nickname),
      nicknameKey,
      classPassword,
      createdAt: serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + 9 * 60 * 1000)
    });
  } catch (error) {
    if (error?.code === "permission-denied") {
      const wrapped = new Error("CLASS_PASSWORD");
      wrapped.code = "class-password";
      throw wrapped;
    }
    throw error;
  }
  return { ticketId, nicknameKey };
}

async function closeRegistrationTicket(ticketId = null) {
  if (!ticketId || !auth.currentUser) return;
  try {
    await deleteDoc(doc(db, COLLECTIONS.tickets, ticketId));
  } catch {
    // Tickets are unreadable and expire after a few minutes. A failed cleanup
    // therefore never grants lasting access.
  }
}

async function finishRegistration(user, nickname, ticketId, nicknameKey) {
  const memberRef = doc(db, COLLECTIONS.members, user.uid);
  const handleRef = doc(db, COLLECTIONS.handles, nicknameKey);
  const profileRef = doc(db, COLLECTIONS.users, user.uid);

  await runTransaction(db, async transaction => {
    const handleSnapshot = await transaction.get(handleRef);
    const profileSnapshot = await transaction.get(profileRef);
    if (handleSnapshot.exists() && handleSnapshot.data().uid !== user.uid) {
      const error = new Error("NAME_TAKEN");
      error.code = "name-taken";
      throw error;
    }

    const previous = profileSnapshot.exists() ? profileSnapshot.data() : {};
    transaction.set(memberRef, {
      email: user.email.toLowerCase(),
      nickname: cleanName(nickname),
      nicknameKey,
      ticketId,
      blocked: false,
      createdAt: serverTimestamp()
    });
    transaction.set(handleRef, {
      uid: user.uid,
      nickname: cleanName(nickname),
      nicknameKey,
      createdAt: handleSnapshot.exists() ? (handleSnapshot.data().createdAt || serverTimestamp()) : serverTimestamp()
    });
    transaction.set(profileRef, {
      nickname: cleanName(nickname),
      nicknameKey,
      photoData: previous.photoData || null,
      createdAt: previous.createdAt || serverTimestamp()
    });
  });
}

async function loadOwnProfile(user, memberData = null) {
  const snapshot = await getDoc(doc(db, COLLECTIONS.users, user.uid));
  if (snapshot.exists()) return { uid: user.uid, ...snapshot.data() };

  const fallbackName = memberData?.nickname || (isAdmin() ? "Elias" : user.email.split("@")[0]);
  const fallbackKey = memberData?.nicknameKey || normalizeName(fallbackName);
  const profile = { nickname: fallbackName, nicknameKey: fallbackKey, photoData: null, createdAt: serverTimestamp() };
  await setDoc(doc(db, COLLECTIONS.users, user.uid), profile);
  return { uid: user.uid, nickname: fallbackName, nicknameKey: fallbackKey, photoData: null, createdAt: null };
}

async function ensureAdminIdentity(profile) {
  // The admin address always owns the reserved class ID "Elias".
  const nickname = "Elias";
  const nicknameKey = normalizeName(nickname);
  const handleRef = doc(db, COLLECTIONS.handles, nicknameKey);
  const handleSnapshot = await getDoc(handleRef);
  await setDoc(doc(db, COLLECTIONS.users, currentUser.uid), { nickname, nicknameKey }, { merge: true });
  await setDoc(handleRef, {
    uid: currentUser.uid,
    nickname,
    nicknameKey,
    createdAt: handleSnapshot.exists() ? (handleSnapshot.data().createdAt || serverTimestamp()) : serverTimestamp()
  });
  return { ...profile, nickname, nicknameKey };
}

async function loadSession(user) {
  const run = ++sessionRun;
  showLoading("Konto wird geladen …");
  currentUser = user;

  try {
    let memberData = null;
    if (!isAdmin()) {
      const memberSnapshot = await getDoc(doc(db, COLLECTIONS.members, user.uid));
      if (!memberSnapshot.exists()) {
        let oldName = "";
        try {
          const oldProfile = await getDoc(doc(db, COLLECTIONS.users, user.uid));
          if (oldProfile.exists()) oldName = oldProfile.data().nickname || "";
        } catch { /* profile may not exist yet */ }
        $("join-name").value = oldName;
        setError("join-error", "");
        showScreen("screen-join");
        hideLoading();
        return;
      }
      memberData = memberSnapshot.data();
      if (memberData.blocked) {
        await signOut(auth);
        setError("login-error", "Dieses Konto wurde gesperrt. Melde dich bei Elias.");
        showScreen("screen-login");
        hideLoading();
        return;
      }
    }

    currentProfile = await loadOwnProfile(user, memberData);
    if (isAdmin()) currentProfile = await ensureAdminIdentity(currentProfile);
    if (run !== sessionRun) return;
    await Promise.all([loadSubjects(), loadAllUsers()]);
    if (run !== sessionRun) return;

    updateHeaderProfile();
    currentView = "week";
    currentFilter = "all";
    selectedDate = startOfToday();
    activeDay = null;
    $("entry-filter").value = "all";
    showScreen("screen-app");
    renderCalendar();
    startEntryListeners();
    if (isAdmin()) startReportsListener();
    else stopReportsListener();
  } catch (error) {
    console.error(error);
    setError("login-error", "Das Konto konnte nicht geladen werden. Prüfe die Firebase-Regeln oder melde dich bei Elias.");
    showScreen("screen-login");
  } finally {
    hideLoading();
  }
}

function updateHeaderProfile() {
  $("header-avatar").innerHTML = avatarHTML(currentProfile);
  $("header-name").textContent = currentProfile?.nickname || "Profil";
  $("reports-btn").hidden = !isAdmin();
}

async function loadSubjects() {
  try {
    const response = await fetch("../faecher/faecher.json", { cache: "no-store" });
    if (!response.ok) throw new Error("subject-list");
    const data = await response.json();
    subjects = data.map(item => item.name).filter(Boolean);
    if (!subjects.length) subjects = [...FALLBACK_SUBJECTS];
  } catch {
    subjects = [...FALLBACK_SUBJECTS];
  }
  $("entry-subject").innerHTML = subjects.map(subject => `<option value="${escapeHTML(subject)}">${escapeHTML(subject)}</option>`).join("");
}

async function loadAllUsers() {
  const snapshot = await getDocs(collection(db, COLLECTIONS.users));
  allUsers = snapshot.docs
    .map(item => ({ uid: item.id, ...item.data() }))
    .filter(user => user.nickname)
    .sort((a, b) => a.nickname.localeCompare(b.nickname, "de-CH", { sensitivity: "base" }));

  if (currentProfile && !allUsers.some(user => user.uid === currentUser.uid)) {
    allUsers.push({ uid: currentUser.uid, ...currentProfile });
  }
}

function stopEntryListeners() {
  while (entryUnsubscribers.length) {
    try { entryUnsubscribers.pop()(); } catch { /* already stopped */ }
  }
  entrySources.clear();
  sourceReady.clear();
  entries = [];
}

function startEntryListeners() {
  stopEntryListeners();
  migrationStarted = false;
  const entriesRef = collection(db, COLLECTIONS.entries);
  // Everyone, including Elias, receives only the entries they are allowed to
  // see. The three constrained queries are required because Firestore rules
  // do not filter a broad collection query after it has been made.
  const sources = [
    ["all", query(entriesRef, where("visibility", "==", "alle"))],
    ["own", query(entriesRef, where("authorUid", "==", currentUser.uid))],
    ["selected", query(entriesRef, where("visibleToUids", "array-contains", currentUser.uid))]
  ];

  for (const [sourceName, sourceQuery] of sources) {
    const unsubscribe = onSnapshot(sourceQuery, snapshot => {
      const map = new Map();
      snapshot.forEach(item => map.set(item.id, { id: item.id, ...item.data() }));

      if (sourceReady.has(sourceName)) {
        snapshot.docChanges().forEach(change => {
          if (change.type !== "added") return;
          const item = { id: change.doc.id, ...change.doc.data() };
          if (item.authorUid !== currentUser.uid && (item.dateTo || item.date) >= dateString(startOfToday())) {
            toast(`🔔 ${item.authorName || "Jemand"} hat ${entryTitle(item)} hinzugefügt`);
          }
        });
      }
      sourceReady.add(sourceName);
      entrySources.set(sourceName, map);
      mergeEntrySources();

      if (isAdmin() && !migrationStarted) {
        migrationStarted = true;
        migrateLegacyEntries().catch(error => console.warn("Migration übersprungen", error));
      }
    }, error => {
      console.error(error);
      toast("⚠️ Einträge konnten nicht geladen werden. Prüfe die Firebase-Regeln.");
    });
    entryUnsubscribers.push(unsubscribe);
  }
}

function mergeEntrySources() {
  const merged = new Map();
  entrySources.forEach(map => map.forEach((value, key) => merged.set(key, value)));
  entries = [...merged.values()].sort((a, b) => {
    const dateCompare = String(a.date || "").localeCompare(String(b.date || ""));
    if (dateCompare) return dateCompare;
    return (timestampDate(a.createdAt || a.ts)?.getTime() || 0) - (timestampDate(b.createdAt || b.ts)?.getTime() || 0);
  });
  renderCalendar();
  if (isAdmin() && !$("reports-modal").hidden) renderReports();
}

async function migrateLegacyEntries() {
  if (!isAdmin()) return;
  await loadAllUsers();
  const batches = [];
  let batch = writeBatch(db);
  let writes = 0;

  for (const entry of entries) {
    const patch = {};
    const visibility = entry.visibility || "alle";
    if (!entry.visibility) patch.visibility = "alle";

    if (!entry.createdAt || typeof entry.createdAt === "number") {
      const legacyCreatedAt = typeof entry.createdAt === "number" ? entry.createdAt : entry.ts;
      patch.createdAt = typeof legacyCreatedAt === "number"
        ? Timestamp.fromMillis(legacyCreatedAt)
        : serverTimestamp();
    }
    if (entry.dateTo === undefined) {
      patch.dateTo = entry.type === "organisatorisch" ? entry.date : null;
    }

    const legacyEditor = entry.editedBy || null;
    const legacyEditorProfile = legacyEditor
      ? allUsers.find(user => normalizeName(user.nickname) === normalizeName(legacyEditor))
      : null;
    if (entry.editedByUid === undefined) patch.editedByUid = legacyEditorProfile?.uid || null;
    if (entry.editedByName === undefined) patch.editedByName = legacyEditor;
    if (entry.editedAt === undefined) {
      patch.editedAt = null;
    } else if (typeof entry.editedAt === "number") {
      patch.editedAt = Timestamp.fromMillis(entry.editedAt);
    }

    if (!Array.isArray(entry.visibleToUids)) {
      const oldNames = Array.isArray(entry.visibleTo) ? entry.visibleTo : [];
      const matches = oldNames
        .map(name => allUsers.find(user => normalizeName(user.nickname) === normalizeName(name)))
        .filter(Boolean);
      patch.visibleToUids = visibility === "auswahl" ? [...new Set(matches.map(user => user.uid))] : [];
      patch.visibleToNames = visibility === "auswahl" ? [...new Set(matches.map(user => user.nickname))] : [];
    } else if (!Array.isArray(entry.visibleToNames)) {
      patch.visibleToNames = entry.visibleToUids.map(uid => profileFor(uid)?.nickname).filter(Boolean);
    }

    if (Object.keys(patch).length) {
      batch.update(doc(db, COLLECTIONS.entries, entry.id), patch);
      writes += 1;
      if (writes === 400) {
        batches.push(batch.commit());
        batch = writeBatch(db);
        writes = 0;
      }
    }
  }

  if (writes) batches.push(batch.commit());
  if (batches.length) {
    await Promise.all(batches);
    toast("✓ Ältere Einträge wurden automatisch aktualisiert");
  }
}

function visibleEntries() {
  return currentFilter === "all" ? entries : entries.filter(entry => entry.type === currentFilter);
}

function entriesForDate(date) {
  const value = dateString(date);
  return visibleEntries().filter(entry => entryCoversDate(entry, value));
}

function typeKind(entry) {
  const meta = TYPE_META[entry.type] || TYPE_META.organisatorisch;
  return `${meta.icon} ${meta.short}`;
}

function eventBars(list, maximum = 4) {
  const bars = list.slice(0, maximum).map(entry => `<span class="event-bar ${escapeHTML(entry.type)}"></span>`).join("");
  return `<div class="event-bars">${bars}</div>`;
}

function compactEntryHTML(entry, className = "calendar-entry") {
  const label = className === "agenda-entry"
    ? `<span class="entry-main"><span class="entry-label">${escapeHTML(entryTitle(entry))}</span><span class="entry-tap-hint">Antippen für genauere Infos</span></span>`
    : `<span class="entry-label">${escapeHTML(entryTitle(entry))}</span>`;
  return `<button class="${className} ${escapeHTML(entry.type)}" type="button" data-entry-id="${safeId(entry.id)}">
    <span class="entry-kind">${escapeHTML(typeKind(entry))}</span>
    ${label}
    ${className === "agenda-entry" ? '<span class="entry-chevron">›</span>' : ""}
  </button>`;
}

function renderWeek() {
  const monday = startOfWeek(selectedDate);
  const days = Array.from({ length: 7 }, (_, index) => addDays(monday, index));

  const desktop = days.map((day, index) => {
    const dayEntries = entriesForDate(day);
    const isSelected = activeDay && sameDate(day, activeDay);
    const classes = ["week-day", isSelected ? "selected" : "", isToday(day) ? "today" : ""].filter(Boolean).join(" ");
    return `<section class="${classes}" data-calendar-date="${dateString(day)}" role="button" tabindex="0" aria-pressed="${isSelected ? "true" : "false"}" aria-label="${escapeHTML(longDate(day))} auswählen">
      <div class="day-header">
        <strong>${["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"][index]}</strong>
        <span>${shortDate(day)}</span>
      </div>
      <div class="week-entries">${dayEntries.length ? dayEntries.map(entry => compactEntryHTML(entry)).join("") : '<div class="week-empty">Keine Einträge</div>'}</div>
    </section>`;
  }).join("");

  const mobile = days.map((day, index) => {
    const dayEntries = entriesForDate(day);
    const classes = ["strip-day", activeDay && sameDate(day, activeDay) ? "selected" : "", isToday(day) ? "today" : "", index === 6 ? "sunday" : ""].filter(Boolean).join(" ");
    return `<button class="${classes}" type="button" data-calendar-date="${dateString(day)}">
      <span class="strip-weekday">${["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"][index]}</span>
      <span class="strip-number">${day.getDate()}</span>
      ${eventBars(dayEntries, 4)}
    </button>`;
  }).join("");

  return `<div class="week-desktop"><div class="week-grid">${desktop}</div></div>
    <div class="week-mobile"><div class="week-strip">${mobile}</div></div>`;
}

function renderMonth() {
  const firstOfMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
  const firstCell = startOfWeek(firstOfMonth);
  const days = Array.from({ length: 42 }, (_, index) => addDays(firstCell, index));
  const weekdayHeader = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]
    .map((name, index) => `<div class="weekday-label ${index === 6 ? "sunday" : ""}">${name}</div>`).join("");

  const cells = days.map(day => {
    const dayEntries = entriesForDate(day);
    const outside = day.getMonth() !== selectedDate.getMonth();
    const classes = ["month-day", outside ? "outside" : "", activeDay && sameDate(day, activeDay) ? "selected" : "", isToday(day) ? "today" : ""].filter(Boolean).join(" ");
    const labels = dayEntries.slice(0, 3).map(entry => `<span class="month-event ${escapeHTML(entry.type)}">${escapeHTML(entryTitle(entry))}</span>`).join("");
    const more = dayEntries.length > 3 ? `<span class="month-more">+${dayEntries.length - 3}</span>` : "";
    return `<button class="${classes}" type="button" data-calendar-date="${dateString(day)}">
      <span class="month-number">${day.getDate()}</span>
      <span class="month-events">${labels}${more}</span>
      ${eventBars(dayEntries, 4)}
    </button>`;
  }).join("");

  return `<div class="weekday-row">${weekdayHeader}</div><div class="month-grid">${cells}</div>`;
}

function renderAgenda() {
  const agenda = $("agenda-section");
  if (!activeDay) {
    agenda.hidden = true;
    $("agenda-list").innerHTML = "";
    return;
  }
  agenda.hidden = false;
  const dayEntries = entriesForDate(activeDay);
  $("agenda-date").textContent = longDate(activeDay);
  $("agenda-count").textContent = `${dayEntries.length} ${dayEntries.length === 1 ? "Eintrag" : "Einträge"}`;
  $("agenda-list").innerHTML = dayEntries.length
    ? dayEntries.map(entry => compactEntryHTML(entry, "agenda-entry")).join("")
    : '<div class="empty-state">Für diesen Tag gibt es keine Einträge.</div>';
}

function renderCalendar(animate = false) {
  if (!$("calendar-surface")) return;
  $("calendar-card").dataset.view = currentView;
  $("week-view-btn").classList.toggle("active", currentView === "week");
  $("month-view-btn").classList.toggle("active", currentView === "month");

  if (currentView === "week") {
    const monday = startOfWeek(selectedDate);
    const sunday = addDays(monday, 6);
    $("period-label").textContent = `KW ${swissWeekNumber(monday)} · ${shortDate(monday)}–${shortDate(sunday)}`;
    $("calendar-surface").innerHTML = renderWeek();
  } else {
    $("period-label").textContent = selectedDate.toLocaleDateString("de-CH", { month: "long", year: "numeric" });
    $("calendar-surface").innerHTML = renderMonth();
  }
  renderAgenda();

  if (animate) {
    $("calendar-surface").classList.remove("switching");
    requestAnimationFrame(() => $("calendar-surface").classList.add("switching"));
  }
}

function setCalendarView(view, animate = true) {
  if (!['week', 'month'].includes(view) || currentView === view) return;
  currentView = view;
  renderCalendar(animate);
}

function navigatePeriod(direction) {
  if (currentView === "week") selectedDate = addDays(selectedDate, direction * 7);
  else selectedDate = new Date(selectedDate.getFullYear(), selectedDate.getMonth() + direction, Math.min(selectedDate.getDate(), 28));
  activeDay = null;
  renderCalendar(true);
}

function selectCalendarDay(date, scrollToPanel = true) {
  const wasSelected = activeDay && sameDate(activeDay, date);
  selectedDate = cloneDate(date);
  activeDay = wasSelected ? null : cloneDate(date);
  renderCalendar();
  if (activeDay && scrollToPanel) {
    requestAnimationFrame(() => $("agenda-section").scrollIntoView({ behavior: "smooth", block: "start" }));
  }
}

function normalizedSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("de-CH")
    .trim();
}

function entrySearchText(entry) {
  const meta = TYPE_META[entry.type] || TYPE_META.organisatorisch;
  return normalizedSearchText([
    meta.short, meta.long, entry.fach, entry.thema, entry.infos,
    entry.authorName, entry.visibleToNames?.join(" ")
  ].filter(Boolean).join(" "));
}

function searchResultHTML(entry, isPast) {
  const meta = TYPE_META[entry.type] || TYPE_META.organisatorisch;
  const secondary = entry.type === "organisatorisch" ? entry.infos : entry.thema;
  const dateLabel = entry.dateTo && entry.dateTo !== entry.date
    ? `${shortDate(parseDate(entry.date))} – ${shortDate(parseDate(entry.dateTo))}`
    : longDate(parseDate(entry.date));
  return `<button class="search-result ${isPast ? "past" : ""}" type="button" data-search-entry-id="${safeId(entry.id)}">
    <span class="search-result-kind ${escapeHTML(entry.type)}">${escapeHTML(meta.icon)} ${escapeHTML(meta.short)}</span>
    <span class="search-result-main">
      <strong>${escapeHTML(entryTitle(entry))}</strong>
      ${secondary ? `<span>${escapeHTML(secondary)}</span>` : ""}
      <time>${escapeHTML(dateLabel)}</time>
    </span>
    <span class="search-result-arrow" aria-hidden="true">›</span>
  </button>`;
}

function renderSearchResults() {
  const queryText = normalizedSearchText($("calendar-search").value);
  const container = $("search-results");
  if (!queryText) {
    container.innerHTML = '<div class="search-empty">Beginne zu tippen. Die Suche prüft Fach, Ereignis, Auftrag und zusätzliche Infos.</div>';
    return;
  }

  const matches = entries.filter(entry => entrySearchText(entry).includes(queryText));
  const today = dateString(startOfToday());
  const upcoming = matches
    .filter(entry => (entry.dateTo || entry.date) >= today)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const past = matches
    .filter(entry => (entry.dateTo || entry.date) < today)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  if (!matches.length) {
    container.innerHTML = `<div class="search-empty">Keine Einträge zu „${escapeHTML($("calendar-search").value.trim())}“ gefunden.</div>`;
    return;
  }

  container.innerHTML = `${upcoming.length ? `<section class="search-group"><h3>Kommend</h3>${upcoming.map(entry => searchResultHTML(entry, false)).join("")}</section>` : ""}
    ${past.length ? `<section class="search-group past-group"><h3>Vorbei</h3>${past.map(entry => searchResultHTML(entry, true)).join("")}</section>` : ""}`;
}

function openCalendarSearch() {
  $("calendar-search").value = "";
  renderSearchResults();
  openModal("search-modal");
}

function jumpToSearchEntry(entryId) {
  const entry = entries.find(item => item.id === entryId);
  if (!entry) return;
  const date = parseDate(entry.date);
  currentFilter = "all";
  $("entry-filter").value = "all";
  selectedDate = cloneDate(date);
  activeDay = cloneDate(date);
  closeModal("search-modal");
  renderCalendar(true);
  requestAnimationFrame(() => $("agenda-section").scrollIntoView({ behavior: "smooth", block: "start" }));
}

function openModal(id) {
  $(id).hidden = false;
  document.body.style.overflow = "hidden";
  requestAnimationFrame(() => $(id).querySelector("input, select, textarea, button:not(.modal-close)")?.focus());
}

function closeModal(id) {
  $(id).hidden = true;
  if (![...document.querySelectorAll(".modal-backdrop")].some(modal => !modal.hidden)) {
    document.body.style.overflow = "";
  }
}

function closeAllModals() {
  document.querySelectorAll(".modal-backdrop").forEach(modal => { modal.hidden = true; });
  document.body.style.overflow = "";
}

function canManageEntry(entry) {
  return isAdmin() || entry.authorUid === currentUser?.uid;
}

function setEntryType(type) {
  selectedType = type;
  document.querySelectorAll("[data-type]").forEach(button => button.classList.toggle("active", button.dataset.type === type));
  const organisational = type === "organisatorisch";
  $("single-date-row").hidden = organisational;
  $("range-date-row").hidden = !organisational;
  $("subject-row").hidden = organisational;
  $("entry-topic-label").textContent = organisational ? "Ereignis" : "Auftrag / Thema";
  $("entry-topic").placeholder = organisational ? "z. B. Sporttag oder Herbstferien" : "z. B. Seiten 45–52 lesen";
}

function setEntryVisibility(visibility) {
  selectedVisibility = visibility;
  document.querySelectorAll("[data-visibility]").forEach(button => button.classList.toggle("active", button.dataset.visibility === visibility));
  $("people-row").hidden = visibility !== "auswahl";
  setError("people-error", "");
  if (visibility === "auswahl") setTimeout(() => $("people-search").focus(), 50);
}

function renderSelectedPeople() {
  $("selected-people").innerHTML = selectedPeople.map(person => `
    <span class="person-tag">
      ${escapeHTML(person.nickname)}
      <button type="button" data-remove-person="${safeId(person.uid)}" aria-label="${escapeHTML(person.nickname)} entfernen">✕</button>
    </span>`).join("");
}

function matchingPeople(search) {
  const key = normalizeName(search);
  if (!key) return [];
  return allUsers.filter(user =>
    user.uid !== currentUser?.uid &&
    normalizeName(user.nickname).includes(key) &&
    !selectedPeople.some(person => person.uid === user.uid)
  ).slice(0, 12);
}

function renderPeopleResults() {
  const search = $("people-search").value;
  const matches = matchingPeople(search);
  const results = $("people-results");
  if (!normalizeName(search)) {
    results.hidden = true;
    results.innerHTML = "";
    return;
  }
  results.innerHTML = matches.length
    ? matches.map(user => `<button class="person-result" type="button" data-person-uid="${safeId(user.uid)}">
        ${avatarHTML(user)}<strong>${escapeHTML(user.nickname)}</strong>
      </button>`).join("")
    : '<div class="no-result">Kein vorhandenes Konto passt zu dieser Eingabe.</div>';
  results.hidden = false;
}

function addSelectedPerson(uid) {
  const user = allUsers.find(item => item.uid === uid);
  if (!user || selectedPeople.some(person => person.uid === uid)) return false;
  selectedPeople.push({ uid: user.uid, nickname: user.nickname });
  $("people-search").value = "";
  $("people-results").hidden = true;
  setError("people-error", "");
  renderSelectedPeople();
  return true;
}

async function openAddEntry() {
  const entryDate = activeDay || selectedDate;
  editingEntryId = null;
  selectedPeople = [];
  $("entry-modal-title").textContent = "Neuer Eintrag";
  $("entry-save-btn").textContent = "Speichern";
  $("entry-date").value = dateString(entryDate);
  $("entry-date-from").value = dateString(entryDate);
  $("entry-date-to").value = dateString(entryDate);
  $("entry-topic").value = "";
  $("entry-info").value = "";
  $("people-search").value = "";
  setError("entry-error", "");
  setError("people-error", "");
  setEntryType("hausaufgabe");
  setEntryVisibility("alle");
  renderSelectedPeople();
  openModal("entry-modal");
  loadAllUsers().catch(() => {});
}

function openEditEntry(entryId) {
  const entry = entries.find(item => item.id === entryId);
  if (!entry || !canManageEntry(entry)) return;
  editingEntryId = entry.id;
  $("entry-modal-title").textContent = "Eintrag bearbeiten";
  $("entry-save-btn").textContent = "Änderungen speichern";
  setEntryType(entry.type);
  $("entry-date").value = entry.date || dateString(selectedDate);
  $("entry-date-from").value = entry.date || dateString(selectedDate);
  $("entry-date-to").value = entry.dateTo || entry.date || dateString(selectedDate);
  if (entry.fach && subjects.includes(entry.fach)) $("entry-subject").value = entry.fach;
  $("entry-topic").value = entry.thema || "";
  $("entry-info").value = entry.infos || "";
  selectedPeople = (entry.visibleToUids || []).map(uid => {
    const profile = profileFor(uid);
    return profile ? { uid, nickname: profile.nickname } : null;
  }).filter(Boolean);
  setEntryVisibility(entry.visibility || "alle");
  renderSelectedPeople();
  setError("entry-error", "");
  setError("people-error", "");
  closeModal("detail-modal");
  openModal("entry-modal");
  loadAllUsers().catch(() => {});
}

async function saveEntry(event) {
  event.preventDefault();
  setError("entry-error", "");
  setError("people-error", "");

  if (!currentUser || !currentProfile) return;
  const organisational = selectedType === "organisatorisch";
  const date = organisational ? $("entry-date-from").value : $("entry-date").value;
  const dateTo = organisational ? $("entry-date-to").value : null;
  const subject = organisational ? "" : $("entry-subject").value;
  const topic = $("entry-topic").value.trim();
  const info = $("entry-info").value.trim();

  if (!date) return setError("entry-error", "Wähle ein Datum aus.");
  if (organisational && dateTo && dateTo < date) return setError("entry-error", "Das Enddatum muss nach dem Startdatum liegen.");
  if (!topic) return setError("entry-error", organisational ? "Gib das Ereignis ein." : "Gib den Auftrag oder das Thema ein.");
  if (!organisational && !subject) return setError("entry-error", "Wähle ein Fach aus.");
  if (selectedVisibility === "auswahl") {
    if (!selectedPeople.length) return setError("people-error", "Wähle mindestens ein vorhandenes Konto aus.");
    const invalid = selectedPeople.some(person => !allUsers.some(user => user.uid === person.uid));
    if (invalid) return setError("people-error", "Mindestens ein ausgewähltes Konto existiert nicht mehr. Wähle die Personen erneut aus.");
  }

  const visibleToUids = selectedVisibility === "auswahl" ? selectedPeople.map(person => person.uid) : [];
  const visibleToNames = selectedVisibility === "auswahl" ? selectedPeople.map(person => person.nickname) : [];
  const button = $("entry-save-btn");
  setButtonBusy(button, true, "Speichert …");

  try {
    if (editingEntryId) {
      const original = entries.find(item => item.id === editingEntryId);
      if (!original || !canManageEntry(original)) throw new Error("permission-denied");
      const update = {
        type: selectedType,
        date,
        dateTo: organisational ? (dateTo || date) : null,
        fach: subject,
        thema: topic,
        infos: info,
        visibility: selectedVisibility,
        visibleToUids,
        visibleToNames,
        editedByUid: currentUser.uid,
        editedByName: currentProfile.nickname,
        editedAt: serverTimestamp()
      };
      if (!original.createdAt) {
        update.createdAt = typeof original.ts === "number"
          ? Timestamp.fromMillis(original.ts)
          : serverTimestamp();
      }
      await updateDoc(doc(db, COLLECTIONS.entries, editingEntryId), update);
      toast("✓ Eintrag wurde aktualisiert");
    } else {
      await addDoc(collection(db, COLLECTIONS.entries), {
        type: selectedType,
        date,
        dateTo: organisational ? (dateTo || date) : null,
        fach: subject,
        thema: topic,
        infos: info,
        authorUid: currentUser.uid,
        authorName: currentProfile.nickname,
        visibility: selectedVisibility,
        visibleToUids,
        visibleToNames,
        createdAt: serverTimestamp(),
        editedByUid: null,
        editedByName: null,
        editedAt: null
      });
      const visibilityText = selectedVisibility === "alle" ? "alle sehen ihn" : selectedVisibility === "privat" ? "nur du siehst ihn" : `sichtbar für ${visibleToNames.join(", ")}`;
      toast(`✓ Gespeichert – ${visibilityText}`);
    }
    closeModal("entry-modal");
  } catch (error) {
    console.error(error);
    setError("entry-error", "Der Eintrag konnte nicht gespeichert werden. Prüfe deine Verbindung und Berechtigung.");
  } finally {
    setButtonBusy(button, false);
  }
}

async function deleteEntry(entryId) {
  const entry = entries.find(item => item.id === entryId);
  if (!entry || !canManageEntry(entry)) return;
  const own = entry.authorUid === currentUser.uid;
  const question = own ? "Deinen Eintrag wirklich löschen?" : `Eintrag von ${entry.authorName || "dieser Person"} wirklich löschen?`;
  if (!confirm(question)) return;
  try {
    await deleteDoc(doc(db, COLLECTIONS.entries, entry.id));
    closeModal("detail-modal");
    toast("Eintrag gelöscht");
  } catch {
    toast("⚠️ Der Eintrag konnte nicht gelöscht werden");
  }
}

function visibilityText(entry) {
  if (entry.visibility === "privat") return "🔒 Nur für dich sichtbar";
  if (entry.visibility === "auswahl") return `👥 Sichtbar für: ${(entry.visibleToNames || []).join(", ") || "ausgewählte Personen"}`;
  return "🌍 Für die ganze Klasse sichtbar";
}

function openEntryDetail(entryId) {
  const entry = entries.find(item => item.id === entryId);
  if (!entry) return;
  const author = profileFor(entry.authorUid) || { uid: entry.authorUid, nickname: entry.authorName || "Unbekannt", photoData: null };
  const meta = TYPE_META[entry.type] || TYPE_META.organisatorisch;
  const dateLabel = entry.dateTo && entry.dateTo !== entry.date
    ? `${longDate(parseDate(entry.date))} – ${longDate(parseDate(entry.dateTo))}`
    : longDate(parseDate(entry.date));
  const canManage = canManageEntry(entry);
  const canReport = entry.authorUid !== currentUser.uid;
  const created = formatTimestamp(entry.createdAt || entry.ts);
  const edited = formatTimestamp(entry.editedAt);

  $("detail-content").innerHTML = `
    <span class="detail-type ${escapeHTML(entry.type)}">${escapeHTML(meta.icon)} ${escapeHTML(meta.long)}</span>
    <h2 class="detail-title">${escapeHTML(entryTitle(entry))}</h2>
    <div class="detail-date">${escapeHTML(dateLabel)}</div>
    <div class="detail-visibility">${escapeHTML(visibilityText(entry))}</div>
    ${entry.type !== "organisatorisch" && entry.thema ? `<section class="detail-section"><h3>Auftrag / Thema</h3><p>${escapeHTML(entry.thema)}</p></section>` : ""}
    ${entry.infos ? `<section class="detail-section"><h3>Zusätzliche Infos</h3><p>${escapeHTML(entry.infos)}</p></section>` : ""}
    <button class="detail-author" id="detail-author-btn" type="button">
      ${avatarHTML(author)}
      <span><strong>${escapeHTML(author.nickname || entry.authorName || "Unbekannt")}</strong><span>Profil öffnen</span></span>
    </button>
    <div class="detail-meta">
      ${created ? `Hinzugefügt: ${escapeHTML(created)}` : ""}
      ${entry.editedByName ? `<br>Bearbeitet von ${escapeHTML(entry.editedByName)}${edited ? `: ${escapeHTML(edited)}` : ""}` : ""}
    </div>
    <div class="detail-actions">
      ${canManage ? '<button class="action-btn" id="detail-edit-btn" type="button">✏️ Bearbeiten</button>' : ""}
      ${canManage ? '<button class="action-btn danger" id="detail-delete-btn" type="button">🗑 Löschen</button>' : ""}
      ${canReport ? '<button class="action-btn danger" id="detail-report-btn" type="button">⚑ Eintrag melden</button>' : ""}
    </div>`;

  $("detail-author-btn").addEventListener("click", () => openProfile(author.uid));
  $("detail-edit-btn")?.addEventListener("click", () => openEditEntry(entry.id));
  $("detail-delete-btn")?.addEventListener("click", () => deleteEntry(entry.id));
  $("detail-report-btn")?.addEventListener("click", () => openReport("entry", entry.id, entryTitle(entry)));
  openModal("detail-modal");
}

async function getProfile(uid) {
  const cached = profileFor(uid);
  if (cached) return cached;
  const snapshot = await getDoc(doc(db, COLLECTIONS.users, uid));
  return snapshot.exists() ? { uid, ...snapshot.data() } : { uid, nickname: "Unbekannt", photoData: null };
}

async function openProfile(uid) {
  closeModal("detail-modal");
  $("profile-content").innerHTML = '<div class="empty-state">Profil wird geladen …</div>';
  openModal("profile-modal");
  try {
    const profile = await getProfile(uid);
    const own = uid === currentUser.uid;
    const joined = formatTimestamp(profile.createdAt);
    $("profile-content").innerHTML = `
      <div class="profile-card">
        ${avatarHTML(profile)}
        <h2>${escapeHTML(profile.nickname || "Unbekannt")}</h2>
        ${joined ? `<p class="detail-meta">Dabei seit ${escapeHTML(timestampDate(profile.createdAt).toLocaleDateString("de-CH", { month: "long", year: "numeric" }))}</p>` : ""}
        ${own ? '<p class="profile-id-note">Dein Vorname ist deine Klassen-ID. Für eine Korrektur meldest du dich bei Elias.</p>' : ""}
        ${own ? '<label class="photo-upload">📷 Profilbild ändern<input id="profile-photo-input" type="file" accept="image/*" hidden></label>' : ""}
        <div class="detail-actions">
          ${!own ? '<button class="action-btn danger" id="profile-report-btn" type="button">⚑ Konto melden</button>' : ""}
          ${isAdmin() && !own ? '<button class="action-btn danger" id="profile-block-btn" type="button">🚫 Konto sperren</button>' : ""}
        </div>
      </div>`;
    $("profile-photo-input")?.addEventListener("change", uploadProfilePhoto);
    $("profile-report-btn")?.addEventListener("click", () => openReport("user", uid, profile.nickname || "Unbekannt"));
    $("profile-block-btn")?.addEventListener("click", () => blockUser(uid, profile.nickname || "dieses Konto"));
  } catch {
    $("profile-content").innerHTML = '<div class="empty-state">Das Profil konnte nicht geladen werden.</div>';
  }
}

async function uploadProfilePhoto(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) return toast("⚠️ Wähle eine Bilddatei aus");
  if (file.size > 2 * 1024 * 1024) return toast("⚠️ Das Ausgangsbild darf höchstens 2 MB gross sein");
  showLoading("Profilbild wird verarbeitet …");
  try {
    const dataUrl = await resizeImage(file, 220);
    await updateDoc(doc(db, COLLECTIONS.users, currentUser.uid), { photoData: dataUrl });
    currentProfile.photoData = dataUrl;
    const ownInList = allUsers.find(user => user.uid === currentUser.uid);
    if (ownInList) ownInList.photoData = dataUrl;
    updateHeaderProfile();
    await openProfile(currentUser.uid);
    toast("✓ Profilbild gespeichert");
  } catch {
    toast("⚠️ Das Profilbild konnte nicht gespeichert werden");
  } finally {
    hideLoading();
  }
}

function resizeImage(file, maxSize) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const image = new Image();
      image.onerror = reject;
      image.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", .8));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function openReport(type, targetId, label) {
  reportTarget = { type, targetId, label };
  $("report-title").textContent = type === "entry" ? "Eintrag melden" : "Konto melden";
  $("report-target").textContent = type === "entry" ? `Gemeldeter Eintrag: ${label}` : `Gemeldetes Konto: ${label}`;
  $("report-reason").value = "";
  $("report-details").value = "";
  setError("report-error", "");
  closeModal(type === "entry" ? "detail-modal" : "profile-modal");
  openModal("report-modal");
}

async function submitReport(event) {
  event.preventDefault();
  if (!reportTarget) return;
  const reason = $("report-reason").value;
  const details = $("report-details").value.trim();
  if (!reason) return setError("report-error", "Wähle einen Grund aus.");
  const button = $("report-submit");
  setButtonBusy(button, true, "Sendet …");
  setError("report-error", "");
  const reportId = `${currentUser.uid}_${reportTarget.type}_${reportTarget.targetId}`;
  try {
    await setDoc(doc(db, COLLECTIONS.reports, reportId), {
      reporterUid: currentUser.uid,
      reporterName: currentProfile.nickname,
      targetType: reportTarget.type,
      targetId: reportTarget.targetId,
      targetLabel: String(reportTarget.label || "").slice(0, 120),
      reason,
      details,
      status: "open",
      createdAt: serverTimestamp()
    });
    closeModal("report-modal");
    toast("✓ Meldung wurde an Elias gesendet");
  } catch (error) {
    console.error(error);
    setError("report-error", "Diese Meldung wurde bereits gesendet oder konnte nicht gespeichert werden.");
  } finally {
    setButtonBusy(button, false);
  }
}

function stopReportsListener() {
  if (reportsUnsubscribe) reportsUnsubscribe();
  reportsUnsubscribe = null;
  openReports = [];
  $("report-count").hidden = true;
}

function startReportsListener() {
  stopReportsListener();
  reportsUnsubscribe = onSnapshot(collection(db, COLLECTIONS.reports), snapshot => {
    openReports = snapshot.docs
      .map(item => ({ id: item.id, ...item.data() }))
      .filter(report => report.status === "open")
      .sort((a, b) => (timestampDate(b.createdAt)?.getTime() || 0) - (timestampDate(a.createdAt)?.getTime() || 0));
    $("report-count").textContent = String(openReports.length);
    $("report-count").hidden = openReports.length === 0;
    if (!$("reports-modal").hidden) renderReports();
  }, error => console.error(error));
}

function reportReasonLabel(reason) {
  return {
    falsch: "Falsche Information",
    unangemessen: "Unangemessener Inhalt",
    spam: "Spam / Störung",
    anderes: "Anderer Grund"
  }[reason] || reason;
}

function renderReports() {
  $("reports-list").innerHTML = openReports.length ? openReports.map(report => {
    const targetIsVisible = report.targetType === "user" || entries.some(entry => entry.id === report.targetId);
    return `
      <article class="report-card">
        <div class="report-card-head">
          <h3>${report.targetType === "entry" ? "📅 Eintrag" : "👤 Konto"}: ${escapeHTML(report.targetLabel)}</h3>
          <span class="detail-meta">${escapeHTML(formatTimestamp(report.createdAt))}</span>
        </div>
        <p><strong>${escapeHTML(reportReasonLabel(report.reason))}</strong> · gemeldet von ${escapeHTML(report.reporterName || "Unbekannt")}</p>
        ${report.details ? `<p>${escapeHTML(report.details)}</p>` : ""}
        ${report.targetType === "entry" && !targetIsVisible ? '<p class="detail-meta">🔒 Der Inhalt ist für dich nicht freigegeben und bleibt verborgen.</p>' : ""}
        <div class="detail-actions">
          ${targetIsVisible ? `<button class="action-btn" type="button" data-open-report-target="${safeId(report.id)}">Öffnen</button>` : ""}
          ${report.targetType === "entry" ? `<button class="action-btn danger" type="button" data-delete-report-entry="${safeId(report.id)}">Eintrag löschen</button>` : ""}
          ${report.targetType === "user" ? `<button class="action-btn danger" type="button" data-block-report-user="${safeId(report.id)}">Konto sperren</button>` : ""}
          <button class="action-btn" type="button" data-resolve-report="${safeId(report.id)}">Als erledigt markieren</button>
        </div>
      </article>`;
  }).join("") : '<div class="empty-state">Keine offenen Meldungen. ✓</div>';
}

async function resolveReport(reportId) {
  try {
    await updateDoc(doc(db, COLLECTIONS.reports, reportId), {
      status: "resolved",
      resolvedAt: serverTimestamp(),
      resolvedByUid: currentUser.uid
    });
    toast("✓ Meldung erledigt");
  } catch {
    toast("⚠️ Meldung konnte nicht aktualisiert werden");
  }
}

async function deleteReportedEntry(report) {
  if (!isAdmin() || report.targetType !== "entry") return;
  if (!confirm("Diesen gemeldeten Eintrag wirklich löschen? Ein geschützter Inhalt wird dir dabei nicht angezeigt.")) return;

  try {
    await deleteDoc(doc(db, COLLECTIONS.entries, report.targetId));
  } catch {
    toast("⚠️ Der gemeldete Eintrag konnte nicht gelöscht werden");
    return;
  }

  try {
    await updateDoc(doc(db, COLLECTIONS.reports, report.id), {
      status: "resolved",
      resolvedAt: serverTimestamp(),
      resolvedByUid: currentUser.uid
    });
    toast("✓ Eintrag gelöscht und Meldung erledigt");
  } catch {
    toast("✓ Eintrag gelöscht. Markiere die Meldung noch als erledigt.");
  }
}

async function blockUser(uid, name) {
  if (!isAdmin() || uid === currentUser.uid) return;
  if (!confirm(`${name} wirklich sperren? Die Person kann danach keine Klassendaten mehr öffnen.`)) return;
  try {
    await updateDoc(doc(db, COLLECTIONS.members, uid), { blocked: true, blockedAt: serverTimestamp(), blockedByUid: currentUser.uid });
    closeModal("profile-modal");
    toast(`🚫 ${name} wurde gesperrt`);
  } catch {
    toast("⚠️ Das Konto konnte nicht gesperrt werden");
  }
}

function openReportsCenter() {
  if (!isAdmin()) return;
  renderReports();
  openModal("reports-modal");
}

async function handleLogin(event) {
  event.preventDefault();
  setError("login-error", "");
  const email = $("login-email").value.trim().toLowerCase();
  const password = $("login-password").value;
  if (!email || !password) return setError("login-error", "Gib E-Mail und persönliches Passwort ein.");
  const button = $("login-submit");
  setButtonBusy(button, true, "Meldet an …");
  authFlowBusy = true;
  try {
    const credential = await signInWithEmailAndPassword(auth, email, password);
    await loadSession(credential.user);
  } catch (error) {
    setError("login-error", authErrorMessage(error));
  } finally {
    authFlowBusy = false;
    setButtonBusy(button, false);
  }
}

async function handleRegistration(event) {
  event.preventDefault();
  setError("register-error", "");
  const nickname = cleanName($("register-name").value);
  const email = $("register-email").value.trim().toLowerCase();
  const password = $("register-password").value;
  const classPassword = $("register-class-password").value;
  if (!validFirstName(nickname)) return setError("register-error", "Gib deinen echten Vornamen mit 2 bis 24 Buchstaben korrekt ein.");
  if (!email || !password || !classPassword) return setError("register-error", "Fülle alle Pflichtfelder aus.");
  if (password.length < 6) return setError("register-error", "Das persönliche Passwort muss mindestens 6 Zeichen haben.");

  const button = $("register-submit");
  setButtonBusy(button, true, "Erstellt Konto …");
  showLoading("Klassenpasswort wird geprüft …");
  authFlowBusy = true;
  let ticket = null;
  let credential = null;
  let membershipCreated = false;
  try {
    credential = await createUserWithEmailAndPassword(auth, email, password);
    ticket = await createRegistrationTicket(credential.user, nickname, classPassword);
    await finishRegistration(credential.user, nickname, ticket.ticketId, ticket.nicknameKey);
    membershipCreated = true;
    await closeRegistrationTicket(ticket.ticketId);
    $("register-class-password").value = "";
    await loadSession(credential.user);
    toast("✓ Konto erstellt – willkommen!");
  } catch (error) {
    console.error(error);
    await closeRegistrationTicket(ticket?.ticketId);
    if (credential?.user && !membershipCreated) {
      try { await deleteUser(credential.user); } catch { /* user can be cleaned up in Firebase */ }
    }
    hideLoading();
    setError("register-error", authErrorMessage(error));
  } finally {
    authFlowBusy = false;
    hideLoading();
    setButtonBusy(button, false);
  }
}

async function handleExistingAccountJoin(event) {
  event.preventDefault();
  if (!currentUser) return;
  setError("join-error", "");
  const nickname = cleanName($("join-name").value);
  const classPassword = $("join-class-password").value;
  if (!validFirstName(nickname)) return setError("join-error", "Gib deinen echten Vornamen mit 2 bis 24 Buchstaben korrekt ein.");
  if (!classPassword) return setError("join-error", "Gib das Klassenpasswort ein.");
  const button = $("join-submit");
  setButtonBusy(button, true, "Schaltet frei …");
  showLoading("Konto wird freigeschaltet …");
  let ticket = null;
  try {
    ticket = await createRegistrationTicket(currentUser, nickname, classPassword);
    await finishRegistration(currentUser, nickname, ticket.ticketId, ticket.nicknameKey);
    await closeRegistrationTicket(ticket.ticketId);
    $("join-class-password").value = "";
    await loadSession(currentUser);
    toast("✓ Konto erfolgreich freigeschaltet");
  } catch (error) {
    console.error(error);
    await closeRegistrationTicket(ticket?.ticketId);
    setError("join-error", authErrorMessage(error));
  } finally {
    hideLoading();
    setButtonBusy(button, false);
  }
}

async function logout() {
  sessionRun += 1;
  stopEntryListeners();
  stopReportsListener();
  closeAllModals();
  currentUser = null;
  currentProfile = null;
  allUsers = [];
  await signOut(auth);
  $("login-password").value = "";
  showScreen("screen-login");
}

// Authentication and screen events
$("login-form").addEventListener("submit", handleLogin);
$("register-form").addEventListener("submit", handleRegistration);
$("join-form").addEventListener("submit", handleExistingAccountJoin);
$("show-register-btn").addEventListener("click", () => { setError("register-error", ""); showScreen("screen-register"); });
$("show-login-btn").addEventListener("click", () => { setError("login-error", ""); showScreen("screen-login"); });
$("join-logout-btn").addEventListener("click", logout);
$("logout-btn").addEventListener("click", logout);
$("own-profile-btn").addEventListener("click", () => currentUser && openProfile(currentUser.uid));
$("reports-btn").addEventListener("click", openReportsCenter);

// Calendar events
$("previous-period-btn").addEventListener("click", () => navigatePeriod(-1));
$("next-period-btn").addEventListener("click", () => navigatePeriod(1));
$("today-btn").addEventListener("click", () => {
  selectedDate = startOfToday();
  activeDay = null;
  renderCalendar(true);
});
$("week-view-btn").addEventListener("click", () => setCalendarView("week"));
$("month-view-btn").addEventListener("click", () => setCalendarView("month"));
$("entry-filter").addEventListener("change", event => { currentFilter = event.target.value; renderCalendar(); });
$("open-search-btn").addEventListener("click", openCalendarSearch);
$("desktop-add-btn").addEventListener("click", openAddEntry);
$("mobile-add-btn").addEventListener("click", openAddEntry);

function handleCalendarClick(event) {
  const entryButton = event.target.closest("[data-entry-id]");
  if (entryButton) return openEntryDetail(decodeId(entryButton.dataset.entryId));
  const dateButton = event.target.closest("[data-calendar-date]");
  if (dateButton) {
    selectCalendarDay(parseDate(dateButton.dataset.calendarDate));
  }
}

$("calendar-surface").addEventListener("click", handleCalendarClick);
$("agenda-list").addEventListener("click", handleCalendarClick);

$("calendar-surface").addEventListener("keydown", event => {
  if (!['Enter', ' '].includes(event.key) || event.target.closest("[data-entry-id]")) return;
  const dateTarget = event.target.closest("[data-calendar-date]");
  if (!dateTarget) return;
  event.preventDefault();
  selectCalendarDay(parseDate(dateTarget.dataset.calendarDate));
});

$("calendar-search").addEventListener("input", renderSearchResults);
$("search-results").addEventListener("click", event => {
  const button = event.target.closest("[data-search-entry-id]");
  if (button) jumpToSearchEntry(decodeId(button.dataset.searchEntryId));
});

// Entry form and person selection
$("entry-type-switch").addEventListener("click", event => {
  const button = event.target.closest("[data-type]");
  if (button) setEntryType(button.dataset.type);
});

$("visibility-switch").addEventListener("click", event => {
  const button = event.target.closest("[data-visibility]");
  if (button) setEntryVisibility(button.dataset.visibility);
});

$("people-search").addEventListener("input", renderPeopleResults);
$("people-search").addEventListener("keydown", event => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  const exact = allUsers.find(user =>
    user.uid !== currentUser.uid &&
    normalizeName(user.nickname) === normalizeName(event.target.value) &&
    !selectedPeople.some(person => person.uid === user.uid)
  );
  if (exact) addSelectedPerson(exact.uid);
  else setError("people-error", "Dieser Name gehört zu keinem vorhandenen Konto. Wähle einen Vorschlag aus.");
});

$("people-results").addEventListener("click", event => {
  const button = event.target.closest("[data-person-uid]");
  if (button) addSelectedPerson(decodeId(button.dataset.personUid));
});

$("selected-people").addEventListener("click", event => {
  const button = event.target.closest("[data-remove-person]");
  if (!button) return;
  const uid = decodeId(button.dataset.removePerson);
  selectedPeople = selectedPeople.filter(person => person.uid !== uid);
  renderSelectedPeople();
});

document.addEventListener("click", event => {
  if (!event.target.closest(".people-search-wrap")) $("people-results").hidden = true;
});

$("entry-form").addEventListener("submit", saveEntry);
$("report-form").addEventListener("submit", submitReport);

// Modal events
document.querySelectorAll("[data-close-modal]").forEach(button => button.addEventListener("click", () => closeModal(button.dataset.closeModal)));
document.querySelectorAll(".modal-backdrop").forEach(backdrop => backdrop.addEventListener("click", event => {
  if (event.target === backdrop) closeModal(backdrop.id);
}));
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  const openModalElement = [...document.querySelectorAll(".modal-backdrop")].reverse().find(modal => !modal.hidden);
  if (openModalElement) closeModal(openModalElement.id);
});

$("reports-list").addEventListener("click", event => {
  const openButton = event.target.closest("[data-open-report-target]");
  const resolveButton = event.target.closest("[data-resolve-report]");
  const blockButton = event.target.closest("[data-block-report-user]");
  const deleteEntryButton = event.target.closest("[data-delete-report-entry]");
  const encodedReportId = openButton?.dataset.openReportTarget || resolveButton?.dataset.resolveReport || blockButton?.dataset.blockReportUser || deleteEntryButton?.dataset.deleteReportEntry;
  if (!encodedReportId) return;
  const report = openReports.find(item => item.id === decodeId(encodedReportId));
  if (!report) return;
  if (openButton) {
    closeModal("reports-modal");
    if (report.targetType === "entry") openEntryDetail(report.targetId);
    else openProfile(report.targetId);
  } else if (resolveButton) {
    resolveReport(report.id);
  } else if (blockButton) {
    blockUser(report.targetId, report.targetLabel);
  } else if (deleteEntryButton) {
    deleteReportedEntry(report);
  }
});

onAuthStateChanged(auth, user => {
  if (authFlowBusy) return;
  if (user) loadSession(user);
  else {
    currentUser = null;
    currentProfile = null;
    stopEntryListeners();
    stopReportsListener();
    hideLoading();
    showScreen("screen-login");
  }
});
