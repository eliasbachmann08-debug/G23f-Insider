import {
  collection, deleteDoc, doc, getDoc, getDocs, onSnapshot, query, runTransaction,
  serverTimestamp, setDoc, Timestamp, updateDoc, where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  createUserWithEmailAndPassword, deleteUser, onAuthStateChanged,
  sendEmailVerification, sendPasswordResetEmail, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { auth, authReady, db, isAdminUser } from "./shared/firebase.js";
import { mountGlobalShell } from "./shared/shell.js";

const $ = id => document.getElementById(id);
const COLLECTIONS = { entries: "eintraege", users: "users", members: "members", handles: "handles", tickets: "registrationTickets" };
const TYPE_META = {
  hausaufgabe: { short: "HA", icon: "✏️" }, test: { short: "Test", icon: "📝" }, organisatorisch: { short: "Org.", icon: "📌" }
};

let currentUser = null;
let currentProfile = null;
let entries = [];
let notes = [];
let subjects = [];
let completedEntries = new Set();
let authBusy = false;
let sessionRun = 0;
let shellMounted = false;
let toastTimer = null;
let deferredPrompt = null;
let visitRecorded = false;
let visitThreshold;
let welcomeReturnTarget = null;
const entrySources = new Map();
const entryReady = new Set();
const unsubscribers = [];

function cleanName(value) {
  return String(value || "").normalize("NFC").trim().replace(/\s+/g, " ");
}

function normalizeName(value) {
  return cleanName(value).toLowerCase();
}

function validFirstName(value) {
  const name = cleanName(value);
  return name.length >= 2 && name.length <= 24 && /^[\p{L}][\p{L}\p{M}' -]*$/u.test(name);
}

function escapeHTML(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function timestampDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value === "number") return new Date(value);
  if (value.seconds) return new Date(value.seconds * 1000);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function todayString() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseDate(value) {
  const [year, month, day] = String(value || todayString()).split("-").map(Number);
  return new Date(year, month - 1, day);
}

function dateLabel(value) {
  const date = parseDate(value);
  if (value === todayString()) return "Heute";
  return date.toLocaleDateString("de-CH", { weekday: "short", day: "numeric", month: "short" });
}

function normalized(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("de-CH").trim();
}

function entryTitle(entry) {
  return entry.type === "organisatorisch" ? (entry.thema || "Organisatorisches") : (entry.fach || "Ohne Fach");
}

function entrySecondary(entry) {
  return entry.type === "organisatorisch" ? (entry.infos || "") : (entry.thema || "");
}

function entryUrl(entry) {
  return `stundenplan/?date=${encodeURIComponent(entry.date)}&entry=${encodeURIComponent(entry.id)}`;
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

function setBusy(button, busy, busyText = "Bitte warten …") {
  if (!button.dataset.defaultText) button.dataset.defaultText = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? busyText : button.dataset.defaultText;
}

function toast(message) {
  clearTimeout(toastTimer);
  $("page-toast").textContent = message;
  $("page-toast").classList.add("show");
  toastTimer = setTimeout(() => $("page-toast").classList.remove("show"), 3200);
}

function openWelcome(returnTarget = null) {
  welcomeReturnTarget = returnTarget;
  $("welcome-modal").hidden = false;
  document.body.classList.add("welcome-open");
  setTimeout(() => $("welcome-close-btn").focus(), 30);
}

function closeWelcome() {
  $("welcome-modal").hidden = true;
  document.body.classList.remove("welcome-open");
  const target = welcomeReturnTarget;
  welcomeReturnTarget = null;
  if (target) location.replace(target);
}

function authMessage(error) {
  const messages = {
    "auth/email-already-in-use": "Diese E-Mail ist bereits registriert. Melde dich stattdessen an.",
    "auth/invalid-email": "Die E-Mail-Adresse ist ungültig.",
    "auth/weak-password": "Das persönliche Passwort muss mindestens 6 Zeichen haben.",
    "auth/invalid-credential": "E-Mail oder persönliches Passwort stimmt nicht.",
    "auth/wrong-password": "E-Mail oder persönliches Passwort stimmt nicht.",
    "auth/too-many-requests": "Zu viele Versuche. Warte kurz und probiere es nochmals.",
    "auth/network-request-failed": "Keine Verbindung. Prüfe dein Internet.",
    "permission-denied": "Das Klassenpasswort stimmt nicht oder die Berechtigung fehlt."
  };
  if (error?.code === "name-taken" || error?.message === "NAME_TAKEN") return "Dieser Vorname wird bereits verwendet. Melde dich bei Elias, falls das nicht stimmen kann.";
  if (error?.code === "class-password" || error?.message === "CLASS_PASSWORD") return "Das Klassenpasswort stimmt nicht.";
  return messages[error?.code] || "Das hat nicht funktioniert. Versuch es nochmals oder melde dich bei Elias.";
}

function showAuth(mode = "login", message = "") {
  stopDataListeners();
  $("auth-gate").hidden = false;
  $("app-content").hidden = true;
  $("main-nav").hidden = true;
  $("header-tools").hidden = true;
  $("site-footer").hidden = true;
  $("quick-create-btn").hidden = true;
  ["login", "register", "join"].forEach(name => $( `auth-${name}` ).hidden = name !== mode);
  if (message) setError(`${mode}-error`, message);
  hideLoading();
}

function showApp() {
  $("auth-gate").hidden = true;
  $("app-content").hidden = false;
  $("main-nav").hidden = false;
  $("header-tools").hidden = false;
  $("site-footer").hidden = false;
  $("quick-create-btn").hidden = false;
}

async function createRegistrationTicket(user, nickname, classPassword) {
  const ticketId = user.uid;
  const nicknameKey = normalizeName(nickname);
  try {
    await setDoc(doc(db, COLLECTIONS.tickets, ticketId), {
      uid: user.uid, email: user.email.trim().toLowerCase(), nickname: cleanName(nickname), nicknameKey,
      classPassword, createdAt: serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + 9 * 60 * 1000)
    });
  } catch (error) {
    if (error?.code === "permission-denied") {
      const wrapped = new Error("CLASS_PASSWORD"); wrapped.code = "class-password"; throw wrapped;
    }
    throw error;
  }
  return { ticketId, nicknameKey };
}

async function closeRegistrationTicket(ticketId) {
  if (!ticketId || !auth.currentUser) return;
  try { await deleteDoc(doc(db, COLLECTIONS.tickets, ticketId)); } catch { /* expires automatically */ }
}

async function finishRegistration(user, nickname, ticketId, nicknameKey) {
  const memberRef = doc(db, COLLECTIONS.members, user.uid);
  const handleRef = doc(db, COLLECTIONS.handles, nicknameKey);
  const profileRef = doc(db, COLLECTIONS.users, user.uid);
  await runTransaction(db, async transaction => {
    const [handleSnapshot, profileSnapshot] = await Promise.all([transaction.get(handleRef), transaction.get(profileRef)]);
    if (handleSnapshot.exists() && handleSnapshot.data().uid !== user.uid) {
      const error = new Error("NAME_TAKEN"); error.code = "name-taken"; throw error;
    }
    const previous = profileSnapshot.exists() ? profileSnapshot.data() : {};
    transaction.set(memberRef, {
      email: user.email.toLowerCase(), nickname: cleanName(nickname), nicknameKey,
      ticketId, blocked: false, createdAt: serverTimestamp()
    });
    transaction.set(handleRef, {
      uid: user.uid, nickname: cleanName(nickname), nicknameKey,
      createdAt: handleSnapshot.exists() ? (handleSnapshot.data().createdAt || serverTimestamp()) : serverTimestamp()
    });
    transaction.set(profileRef, {
      nickname: cleanName(nickname), nicknameKey, photoData: previous.photoData || null,
      createdAt: previous.createdAt || serverTimestamp()
    });
  });
}

async function ensureAdminProfile(user) {
  const profileRef = doc(db, COLLECTIONS.users, user.uid);
  const handleRef = doc(db, COLLECTIONS.handles, "elias");
  const [profileSnapshot, handleSnapshot] = await Promise.all([getDoc(profileRef), getDoc(handleRef)]);
  const existing = profileSnapshot.exists() ? profileSnapshot.data() : {};
  await setDoc(profileRef, { nickname: "Elias", nicknameKey: "elias", photoData: existing.photoData || null, createdAt: existing.createdAt || serverTimestamp() });
  await setDoc(handleRef, { uid: user.uid, nickname: "Elias", nicknameKey: "elias", createdAt: handleSnapshot.exists() ? (handleSnapshot.data().createdAt || serverTimestamp()) : serverTimestamp() });
  return { uid: user.uid, nickname: "Elias", nicknameKey: "elias", photoData: existing.photoData || null, createdAt: existing.createdAt || null };
}

function safeReturnTarget() {
  const value = new URLSearchParams(location.search).get("returnTo");
  if (!value) return null;
  try {
    const target = new URL(value, location.origin);
    if (target.origin !== location.origin) return null;
    if (!["/stundenplan", "/notes", "/faecher"].some(prefix => target.pathname.startsWith(prefix))) return null;
    return target.href;
  } catch { return null; }
}

async function loadSession(user, { welcome = false } = {}) {
  const run = ++sessionRun;
  currentUser = user;
  showLoading("Klassenkonto wird geladen …");
  try {
    let member = null;
    if (!isAdminUser(user)) {
      const memberSnapshot = await getDoc(doc(db, COLLECTIONS.members, user.uid));
      if (!memberSnapshot.exists()) {
        let oldName = "";
        const oldProfile = await getDoc(doc(db, COLLECTIONS.users, user.uid)).catch(() => null);
        if (oldProfile?.exists()) oldName = oldProfile.data().nickname || "";
        $("join-name").value = oldName;
        showAuth("join");
        return;
      }
      member = memberSnapshot.data();
      if (member.blocked) {
        await signOut(auth);
        showAuth("login", "Dieses Konto wurde gesperrt. Melde dich bei Elias.");
        return;
      }
    }
    if (run !== sessionRun) return;
    if (isAdminUser(user)) currentProfile = await ensureAdminProfile(user);
    else {
      const profileSnapshot = await getDoc(doc(db, COLLECTIONS.users, user.uid));
      currentProfile = profileSnapshot.exists() ? { uid: user.uid, ...profileSnapshot.data() } : { uid: user.uid, nickname: member.nickname, nicknameKey: member.nicknameKey, photoData: null };
    }
    const returnTarget = safeReturnTarget();
    if (returnTarget && !welcome) {
      location.replace(returnTarget);
      return;
    }
    if (!shellMounted) {
      mountGlobalShell({ user, profile: currentProfile, rootPath: "./", pageLabel: "Startseite", onProfileUpdated: profile => { currentProfile = profile; } });
      shellMounted = true;
    }
    showApp();
    await loadSubjects();
    startDataListeners();
    if (welcome) openWelcome(returnTarget);
  } catch (error) {
    console.error(error);
    showAuth("login", "Das Konto konnte nicht geladen werden. Prüfe die Firebase-Regeln oder melde dich bei Elias.");
  } finally {
    hideLoading();
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const email = $("login-email").value.trim().toLowerCase();
  const password = $("login-password").value;
  setError("login-error", "");
  if (!email || !password) return setError("login-error", "Gib E-Mail und persönliches Passwort ein.");
  const button = $("login-submit");
  setBusy(button, true, "Meldet an …"); authBusy = true;
  try { const credential = await signInWithEmailAndPassword(auth, email, password); await loadSession(credential.user); }
  catch (error) { setError("login-error", authMessage(error)); }
  finally { authBusy = false; setBusy(button, false); }
}

async function handleRegistration(event) {
  event.preventDefault();
  const nickname = cleanName($("register-name").value);
  const email = $("register-email").value.trim().toLowerCase();
  const password = $("register-password").value;
  const classPassword = $("register-class-password").value;
  setError("register-error", "");
  if (!validFirstName(nickname)) return setError("register-error", "Gib deinen echten Vornamen mit 2 bis 24 Buchstaben korrekt ein.");
  if (!email || !password || !classPassword) return setError("register-error", "Fülle alle Felder aus.");
  if (password.length < 6) return setError("register-error", "Das persönliche Passwort muss mindestens 6 Zeichen haben.");
  const button = $("register-submit");
  setBusy(button, true, "Erstellt Konto …"); showLoading("Klassenpasswort wird geprüft …"); authBusy = true;
  let credential = null; let ticket = null; let membershipCreated = false;
  try {
    credential = await createUserWithEmailAndPassword(auth, email, password);
    ticket = await createRegistrationTicket(credential.user, nickname, classPassword);
    await finishRegistration(credential.user, nickname, ticket.ticketId, ticket.nicknameKey);
    membershipCreated = true;
    await closeRegistrationTicket(ticket.ticketId);
    try {
      await sendEmailVerification(credential.user, { url: new URL("./", location.href).href });
      toast("✓ Konto erstellt – Bestätigungsmail wurde gesendet");
    } catch { toast("✓ Konto erstellt. Die Bestätigungsmail kann im Profil nochmals gesendet werden."); }
    $("register-class-password").value = "";
    await loadSession(credential.user, { welcome: true });
  } catch (error) {
    console.error(error);
    await closeRegistrationTicket(ticket?.ticketId);
    if (credential?.user && !membershipCreated) { try { await deleteUser(credential.user); } catch {} }
    setError("register-error", authMessage(error));
  } finally { authBusy = false; hideLoading(); setBusy(button, false); }
}

async function handleJoin(event) {
  event.preventDefault();
  if (!currentUser) return;
  const nickname = cleanName($("join-name").value);
  const classPassword = $("join-class-password").value;
  setError("join-error", "");
  if (!validFirstName(nickname)) return setError("join-error", "Gib deinen echten Vornamen korrekt ein.");
  if (!classPassword) return setError("join-error", "Gib das Klassenpasswort ein.");
  const button = $("join-submit");
  setBusy(button, true, "Schaltet frei …"); showLoading("Konto wird freigeschaltet …");
  let ticket = null;
  try {
    ticket = await createRegistrationTicket(currentUser, nickname, classPassword);
    await finishRegistration(currentUser, nickname, ticket.ticketId, ticket.nicknameKey);
    await closeRegistrationTicket(ticket.ticketId);
    if (!currentUser.emailVerified) { try { await sendEmailVerification(currentUser, { url: new URL("./", location.href).href }); } catch {} }
    $("join-class-password").value = "";
    await loadSession(currentUser);
    toast("✓ Konto freigeschaltet");
  } catch (error) {
    await closeRegistrationTicket(ticket?.ticketId);
    setError("join-error", authMessage(error));
  } finally { hideLoading(); setBusy(button, false); }
}

async function forgotPassword() {
  const email = $("login-email").value.trim().toLowerCase();
  setError("login-error", "");
  if (!email) return setError("login-error", "Gib zuerst deine E-Mail-Adresse ein.");
  try { await sendPasswordResetEmail(auth, email); toast("✓ E-Mail zum Zurücksetzen wurde gesendet"); }
  catch (error) { setError("login-error", authMessage(error)); }
}

function stopDataListeners() {
  while (unsubscribers.length) { try { unsubscribers.pop()(); } catch {} }
  entrySources.clear(); entryReady.clear(); entries = []; notes = []; completedEntries = new Set(); visitRecorded = false; visitThreshold = undefined;
}

function startDataListeners() {
  stopDataListeners();
  const entriesRef = collection(db, COLLECTIONS.entries);
  const sources = [
    ["all", query(entriesRef, where("visibility", "==", "alle"))],
    ["own", query(entriesRef, where("authorUid", "==", currentUser.uid))],
    ["selected", query(entriesRef, where("visibleToUids", "array-contains", currentUser.uid))]
  ];
  sources.forEach(([name, source]) => {
    unsubscribers.push(onSnapshot(source, snapshot => {
      entrySources.set(name, new Map(snapshot.docs.map(item => [item.id, { id: item.id, ...item.data() }])));
      entryReady.add(name);
      mergeEntries();
    }, () => toast("Einträge konnten nicht geladen werden.")));
  });
  unsubscribers.push(onSnapshot(collection(db, "notes", currentUser.uid, "items"), snapshot => {
    notes = snapshot.docs.map(item => ({ id: item.id, ...item.data() })).filter(note => !note.trashed);
    renderFinderSearch();
  }, () => { notes = []; }));
  unsubscribers.push(onSnapshot(collection(db, "entryProgress", currentUser.uid, "items"), snapshot => {
    completedEntries = new Set(snapshot.docs.filter(item => item.data().completed).map(item => item.id));
    renderUpcoming();
  }, () => { completedEntries = new Set(); }));
}

function mergeEntries() {
  const merged = new Map();
  entrySources.forEach(source => source.forEach((entry, id) => merged.set(id, entry)));
  entries = [...merged.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  renderUpcoming(); renderFinderSearch();
  if (entryReady.size === 3) renderNewSinceVisit();
}

function compactEntry(entry, includeComplete = true) {
  const meta = TYPE_META[entry.type] || TYPE_META.organisatorisch;
  const done = completedEntries.has(entry.id);
  return `<article class="compact-item"><span class="compact-kind">${escapeHTML(meta.icon)} ${escapeHTML(meta.short)}</span><a class="compact-main" href="${entryUrl(entry)}"><strong>${escapeHTML(entryTitle(entry))}</strong><span>${escapeHTML(entrySecondary(entry) || entry.authorName || "")}</span></a>${includeComplete && entry.type === "hausaufgabe" ? `<button class="complete-btn ${done ? "done" : ""}" type="button" data-complete-entry="${encodeURIComponent(entry.id)}" aria-label="${done ? "Als offen markieren" : "Als erledigt markieren"}">${done ? "✓" : ""}</button>` : `<time class="compact-date">${escapeHTML(dateLabel(entry.date))}</time>`}</article>`;
}

function renderUpcoming() {
  const today = todayString();
  const upcoming = entries.filter(entry => (entry.dateTo || entry.date) >= today).slice(0, 4);
  $("upcoming-list").innerHTML = upcoming.length ? upcoming.map(entry => compactEntry(entry)).join("") : '<p class="empty-copy">Aktuell steht nichts an.</p>';
}

function renderNewSinceVisit() {
  const key = `g23f-last-visit-${currentUser.uid}`;
  if (visitThreshold === undefined) {
    const previous = localStorage.getItem(key);
    visitThreshold = previous ? Number(previous) : null;
  }
  const threshold = visitThreshold;
  const changed = threshold ? entries.filter(entry => {
    const when = timestampDate(entry.editedAt || entry.createdAt || entry.ts)?.getTime() || 0;
    return when > threshold;
  }).sort((a, b) => (timestampDate(b.editedAt || b.createdAt)?.getTime() || 0) - (timestampDate(a.editedAt || a.createdAt)?.getTime() || 0)).slice(0, 3) : [];
  $("new-list").innerHTML = changed.length ? changed.map(entry => compactEntry(entry, false)).join("") : `<p class="empty-copy">${threshold ? "Nichts Neues seit deinem letzten Besuch." : "Ab deinem nächsten Besuch siehst du hier neue oder geänderte Einträge."}</p>`;
  if (!visitRecorded) { localStorage.setItem(key, String(Date.now())); visitRecorded = true; }
}

async function toggleCompleted(entryId) {
  const completed = !completedEntries.has(entryId);
  try {
    await setDoc(doc(db, "entryProgress", currentUser.uid, "items", entryId), { entryId, completed, updatedAt: serverTimestamp() });
    toast(completed ? "✓ Als erledigt markiert" : "Wieder als offen markiert");
  } catch { toast("Der persönliche Status konnte nicht gespeichert werden."); }
}

async function loadSubjects() {
  try {
    const response = await fetch("faecher/faecher.json", { cache: "no-store" });
    subjects = await response.json();
    const ready = subjects.filter(subject => subject.verfuegbar).length;
    $("subject-summary").textContent = `${ready} von ${subjects.length} verfügbar`;
    $("faecher-grid").innerHTML = subjects.map(subject => subject.verfuegbar
      ? `<a href="${escapeHTML(subject.pfad)}" class="subject-card" style="--card-color:${escapeHTML(subject.color)}"><div class="subject-top"><span class="subject-icon">${subject.icon}</span><span class="subject-tag">✓ Verfügbar</span></div><h3>${escapeHTML(subject.name)}</h3><p>${escapeHTML(subject.beschreibung || "Lernmaterial verfügbar.")}</p><div class="subject-pills">${(subject.themen || []).map(topic => `<span>${escapeHTML(topic)}</span>`).join("")}</div></a>`
      : `<article class="subject-card inactive" style="--card-color:${escapeHTML(subject.color)}"><div class="subject-top"><span class="subject-icon">${subject.icon}</span><span class="subject-tag">Noch offen</span></div><h3>${escapeHTML(subject.name)}</h3><p>Wird hinzugefügt, sobald das Thema behandelt wird.</p></article>`).join("");
    renderFinderSearch();
  } catch {
    subjects = [];
    $("subject-summary").textContent = "Konnte nicht geladen werden";
    $("faecher-grid").innerHTML = '<p class="empty-copy">Fächer konnten nicht geladen werden.</p>';
  }
}

function resultGroup(title, items) {
  if (!items.length) return "";
  return `<section class="result-group"><h3>${escapeHTML(title)}</h3><div class="result-list">${items.join("")}</div></section>`;
}

function showFinderEntries(list, title) {
  $("finder-results").hidden = false;
  $("finder-results").innerHTML = resultGroup(title, list.length ? list.slice(0, 12).map(entry => `<a class="result-item" href="${entryUrl(entry)}"><strong>${escapeHTML(entryTitle(entry))}</strong><span>${escapeHTML(dateLabel(entry.date))}</span></a>`) : ['<div class="empty-copy">Keine passenden Einträge.</div>']);
}

function finderPreset(type) {
  const today = todayString();
  if (type === "today") return showFinderEntries(entries.filter(entry => entry.date <= today && (entry.dateTo || entry.date) >= today), "Heute");
  if (type === "test") {
    const next = entries.filter(entry => entry.type === "test" && entry.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 1);
    return showFinderEntries(next, "Nächster Test");
  }
  const now = parseDate(today); const day = now.getDay(); const untilSunday = day === 0 ? 0 : 7 - day;
  const sunday = new Date(now); sunday.setDate(now.getDate() + untilSunday);
  const end = `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, "0")}-${String(sunday.getDate()).padStart(2, "0")}`;
  showFinderEntries(entries.filter(entry => entry.date <= end && (entry.dateTo || entry.date) >= today), "Diese Woche");
}

function renderFinderSearch() {
  const raw = $("global-search").value.trim();
  const search = normalized(raw);
  if (!search) { $("finder-results").hidden = true; $("finder-results").innerHTML = ""; return; }
  const entryMatches = entries.filter(entry => normalized(`${entryTitle(entry)} ${entry.thema || ""} ${entry.infos || ""} ${entry.authorName || ""}`).includes(search)).slice(0, 12);
  const subjectMatches = subjects.filter(subject => normalized(`${subject.name} ${subject.beschreibung || ""} ${(subject.themen || []).join(" ")}`).includes(search)).slice(0, 8);
  const noteMatches = notes.filter(note => normalized(`${note.title || ""} ${note.contentText || ""}`).includes(search)).slice(0, 8);
  const entryHtml = entryMatches.map(entry => `<a class="result-item" href="${entryUrl(entry)}"><strong>${escapeHTML(entryTitle(entry))}</strong><span>${escapeHTML(dateLabel(entry.date))}</span></a>`);
  const subjectHtml = subjectMatches.map(subject => subject.verfuegbar ? `<a class="result-item" href="${escapeHTML(subject.pfad)}"><strong>${escapeHTML(subject.name)}</strong><span>Lernapp</span></a>` : `<div class="result-item"><strong>${escapeHTML(subject.name)}</strong><span>Noch offen</span></div>`);
  const noteHtml = noteMatches.map(note => `<a class="result-item" href="notes/?note=${encodeURIComponent(note.id)}"><strong>${escapeHTML(note.title || "Ohne Titel")}</strong><span>Private Note</span></a>`);
  $("finder-results").hidden = false;
  $("finder-results").innerHTML = resultGroup("Stundenplan", entryHtml) + resultGroup("Fächer", subjectHtml) + resultGroup("Eigene Notes", noteHtml) || `<p class="empty-copy">Nichts zu „${escapeHTML(raw)}“ gefunden.</p>`;
}

function setupInstall() {
  window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); deferredPrompt = event; });
  window.addEventListener("appinstalled", () => { $("install-btn").hidden = true; deferredPrompt = null; });
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (standalone) $("install-btn").hidden = true;
  $("install-btn").addEventListener("click", async () => {
    if (deferredPrompt) { deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; return; }
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
    $("install-help").textContent = ios ? "Tippe auf Teilen und danach auf «Zum Home-Bildschirm»." : "Öffne das Browsermenü und wähle «App installieren» oder «Zum Startbildschirm hinzufügen».";
    $("install-popup").hidden = false;
  });
  $("close-install").addEventListener("click", () => $("install-popup").hidden = true);
}

$("login-form").addEventListener("submit", handleLogin);
$("register-form").addEventListener("submit", handleRegistration);
$("join-form").addEventListener("submit", handleJoin);
$("forgot-password-btn").addEventListener("click", forgotPassword);
$("show-register-btn").addEventListener("click", () => showAuth("register"));
$("show-login-btn").addEventListener("click", () => showAuth("login"));
$("join-logout-btn").addEventListener("click", async () => { await signOut(auth); showAuth("login"); });
$("upcoming-list").addEventListener("click", event => { const button = event.target.closest("[data-complete-entry]"); if (button) toggleCompleted(decodeURIComponent(button.dataset.completeEntry)); });
$("global-search").addEventListener("input", renderFinderSearch);
$("clear-search").addEventListener("click", () => { $("global-search").value = ""; renderFinderSearch(); $("global-search").focus(); });
document.querySelectorAll("[data-finder]").forEach(button => button.addEventListener("click", () => finderPreset(button.dataset.finder)));
$("quick-create-btn").addEventListener("click", event => { event.stopPropagation(); $("quick-menu").hidden = !$("quick-menu").hidden; });
$("welcome-close-btn").addEventListener("click", closeWelcome);
document.addEventListener("click", event => { if (!event.target.closest("#quick-menu")) $("quick-menu").hidden = true; });
setupInstall();

await authReady;
onAuthStateChanged(auth, user => {
  if (authBusy) return;
  if (user) loadSession(user);
  else {
    currentUser = null; currentProfile = null; shellMounted = false; sessionRun += 1;
    const params = new URLSearchParams(location.search);
    const message = params.get("error") === "blocked" ? "Dieses Konto wurde gesperrt. Melde dich bei Elias." : "";
    showAuth(params.get("mode") === "join" ? "login" : "login", message);
  }
});
