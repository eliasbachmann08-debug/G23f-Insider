import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore, collection, doc, getDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  browserLocalPersistence, setPersistence
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
const COLORS = {
  sand: "#fffdf9",
  yellow: "#fff2be",
  rose: "#f8dfe6",
  blue: "#dfeef3",
  green: "#e1efdf",
  violet: "#e9e2f4"
};

const app = initializeApp(FIREBASE_CONFIG);
const db = getFirestore(app);
const auth = getAuth(app);
await setPersistence(auth, browserLocalPersistence);

const $ = id => document.getElementById(id);
let currentUser = null;
let currentProfile = null;
let notes = [];
let folders = [];
let activeFilter = { type: "all", id: null };
let viewMode = localStorage.getItem("g23f-notes-view") === "list" ? "list" : "grid";
let editingNoteId = null;
let editorPinned = false;
let editorColor = "sand";
let editorDirty = false;
let notesUnsubscribe = null;
let foldersUnsubscribe = null;
let toastTimer = null;
let authBusy = false;

function isAdmin() {
  return currentUser?.email?.toLowerCase() === ADMIN_EMAIL;
}

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function encodeId(value) {
  return escapeHTML(encodeURIComponent(String(value || "")));
}

function decodeId(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function timestampDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value.seconds) return new Date(value.seconds * 1000);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatUpdated(value) {
  const date = timestampDate(value);
  if (!date) return "Gerade eben";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return `Heute, ${date.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" })}`;
  }
  return date.toLocaleDateString("de-CH", { day: "numeric", month: "short", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function normalizeSearch(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("de-CH")
    .trim();
}

function initials(name) {
  return String(name || "?").trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(screen => screen.classList.toggle("active", screen.id === id));
  $("header-account").hidden = id !== "screen-notes";
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

function setBusy(button, busy, text = "Bitte warten …") {
  if (!button.dataset.defaultText) button.dataset.defaultText = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? text : button.dataset.defaultText;
}

function toast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").classList.add("show");
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3000);
}

function stopListeners() {
  if (notesUnsubscribe) notesUnsubscribe();
  if (foldersUnsubscribe) foldersUnsubscribe();
  notesUnsubscribe = null;
  foldersUnsubscribe = null;
  notes = [];
  folders = [];
}

function updateHeader() {
  $("header-name").textContent = currentProfile?.nickname || "Profil";
  $("header-avatar").textContent = initials(currentProfile?.nickname);
}

async function loadSession(user) {
  currentUser = user;
  showLoading("Private Notizen werden geladen …");
  try {
    if (!isAdmin()) {
      const member = await getDoc(doc(db, "members", user.uid));
      if (!member.exists() || member.data().blocked) {
        $("blocked-message").textContent = member.exists() && member.data().blocked
          ? "Dieses Klassenkonto ist gesperrt. Melde dich bei Elias."
          : "Öffne zuerst den Stundenplan und schalte dein Konto einmalig mit dem Klassenpasswort frei.";
        showScreen("screen-blocked");
        return;
      }
    }

    const profile = await getDoc(doc(db, "users", user.uid));
    currentProfile = profile.exists()
      ? { uid: user.uid, ...profile.data() }
      : { uid: user.uid, nickname: isAdmin() ? "Elias" : user.email.split("@")[0] };
    updateHeader();
    showScreen("screen-notes");
    startListeners();
  } catch (error) {
    console.error(error);
    setError("login-error", "Die Notes konnten nicht geladen werden. Prüfe die Firebase-Regeln oder melde dich bei Elias.");
    showScreen("screen-login");
  } finally {
    hideLoading();
  }
}

function startListeners() {
  stopListeners();
  notesUnsubscribe = onSnapshot(collection(db, "notes", currentUser.uid, "items"), snapshot => {
    notes = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    renderNotes();
    renderFolderNavigation();
  }, error => {
    console.error(error);
    toast("⚠️ Notizen konnten nicht geladen werden. Veröffentliche die neuen Firebase-Regeln.");
  });

  foldersUnsubscribe = onSnapshot(collection(db, "noteFolders", currentUser.uid, "folders"), snapshot => {
    folders = snapshot.docs
      .map(item => ({ id: item.id, ...item.data() }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "de-CH", { sensitivity: "base" }));
    if (activeFilter.type === "folder" && !folders.some(folder => folder.id === activeFilter.id)) {
      activeFilter = { type: "all", id: null };
    }
    renderFolderNavigation();
    renderFolderOptions();
    renderManageFolders();
    renderNotes();
  }, error => console.error(error));
}

function folderName(folderId) {
  return folders.find(folder => folder.id === folderId)?.name || "";
}

function folderCount(folderId) {
  return notes.filter(note => note.folderId === folderId).length;
}

function filterLabel() {
  if (activeFilter.type === "pinned") return "Angeheftet";
  if (activeFilter.type === "folder") return folderName(activeFilter.id) || "Ordner";
  return "Alle Notizen";
}

function setFilter(type, id = null) {
  activeFilter = { type, id };
  $("notes-search").value = "";
  $("notes-search-wrap").hidden = true;
  closeSidebar();
  renderFolderNavigation();
  renderNotes();
}

function renderFolderNavigation() {
  $("all-count").textContent = String(notes.length);
  $("pinned-count").textContent = String(notes.filter(note => note.pinned).length);
  document.querySelectorAll("[data-note-filter]").forEach(button => {
    button.classList.toggle("active", button.dataset.noteFilter === activeFilter.type);
  });

  $("folder-list").innerHTML = folders.length ? folders.map(folder => `
    <button class="folder-item ${activeFilter.type === "folder" && activeFilter.id === folder.id ? "active" : ""}" type="button" data-folder-filter="${encodeId(folder.id)}">
      <span>📁 ${escapeHTML(folder.name)}</span><strong>${folderCount(folder.id)}</strong>
    </button>`).join("") : '<p class="privacy-note" style="margin:0 .45rem;border:0;padding:.4rem 0">Noch keine Ordner.</p>';

  const chips = [
    `<button class="mobile-filter-chip ${activeFilter.type === "all" ? "active" : ""}" type="button" data-mobile-filter="all">Alle</button>`,
    `<button class="mobile-filter-chip ${activeFilter.type === "pinned" ? "active" : ""}" type="button" data-mobile-filter="pinned">☆ Angeheftet</button>`,
    ...folders.map(folder => `<button class="mobile-filter-chip ${activeFilter.type === "folder" && activeFilter.id === folder.id ? "active" : ""}" type="button" data-mobile-folder="${encodeId(folder.id)}">${escapeHTML(folder.name)}</button>`)
  ];
  $("mobile-folder-strip").innerHTML = chips.join("");
}

function visibleNotes() {
  const queryText = normalizeSearch($("notes-search").value);
  return notes.filter(note => {
    if (activeFilter.type === "pinned" && !note.pinned) return false;
    if (activeFilter.type === "folder" && note.folderId !== activeFilter.id) return false;
    if (!queryText) return true;
    return normalizeSearch(`${note.title || ""} ${note.contentText || ""}`).includes(queryText);
  }).sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return (timestampDate(b.updatedAt)?.getTime() || 0) - (timestampDate(a.updatedAt)?.getTime() || 0);
  });
}

function noteCardHTML(note) {
  const color = COLORS[note.color] || COLORS.sand;
  const folder = folderName(note.folderId);
  const preview = String(note.contentText || "").trim() || "Leere Notiz";
  return `<article class="note-card" style="--note-color:${color}">
    <div class="note-card-head">
      <button class="note-open-btn" type="button" data-open-note="${encodeId(note.id)}"><h3>${escapeHTML(note.title || "Ohne Titel")}</h3></button>
      <button class="quick-pin ${note.pinned ? "active" : ""}" type="button" data-quick-pin="${encodeId(note.id)}" aria-label="${note.pinned ? "Nicht mehr anheften" : "Anheften"}">${note.pinned ? "★" : "☆"}</button>
    </div>
    <button class="note-open-btn" type="button" data-open-note="${encodeId(note.id)}"><p class="note-preview">${escapeHTML(preview)}</p></button>
    <div class="note-card-foot"><span class="folder-badge">${folder ? `📁 ${escapeHTML(folder)}` : "Ohne Ordner"}</span><time>${escapeHTML(formatUpdated(note.updatedAt || note.createdAt))}</time></div>
  </article>`;
}

function noteSectionHTML(title, list) {
  if (!list.length) return "";
  return `<section class="note-section"><h2 class="note-section-title">${escapeHTML(title)}</h2><div class="note-grid">${list.map(noteCardHTML).join("")}</div></section>`;
}

function renderNotes() {
  const list = visibleNotes();
  const queryText = normalizeSearch($("notes-search").value);
  const title = filterLabel();
  $("current-section-title").textContent = title;
  $("current-section-label").textContent = activeFilter.type === "folder" ? "Privater Ordner" : "Private Notizen";
  $("visible-count").textContent = `${list.length} ${list.length === 1 ? "Notiz" : "Notizen"}`;
  $("notes-content").classList.toggle("list-view", viewMode === "list");
  $("toggle-view-btn").textContent = viewMode === "list" ? "▦" : "☷";
  $("toggle-view-btn").setAttribute("aria-label", viewMode === "list" ? "Kachelansicht" : "Listenansicht");

  if (!list.length) {
    const searched = Boolean(queryText);
    $("notes-content").innerHTML = `<div class="empty-state"><span class="empty-icon">${searched ? "⌕" : "🗒️"}</span><h2>${searched ? "Nichts gefunden" : "Noch keine Notiz"}</h2><p>${searched ? "Versuche einen anderen Suchbegriff." : "Erstelle hier deine erste private Notiz. Nur du kannst sie sehen."}</p>${searched ? "" : '<button class="primary-btn inline" type="button" data-empty-new-note>＋ Neue Notiz</button>'}</div>`;
    return;
  }

  if (activeFilter.type === "all" && !queryText) {
    const pinned = list.filter(note => note.pinned);
    const normal = list.filter(note => !note.pinned);
    $("notes-content").innerHTML = `${noteSectionHTML("Angeheftet", pinned)}${noteSectionHTML("Notizen", normal)}`;
  } else {
    $("notes-content").innerHTML = noteSectionHTML(queryText ? "Suchergebnisse" : title, list);
  }
}

function renderFolderOptions() {
  const current = $("note-folder").value;
  $("note-folder").innerHTML = '<option value="">Kein Ordner</option>' + folders.map(folder => `<option value="${escapeHTML(folder.id)}">${escapeHTML(folder.name)}</option>`).join("");
  if ([...$("note-folder").options].some(option => option.value === current)) $("note-folder").value = current;
}

function sanitizeHTML(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html || "");
  const allowed = new Set(["B", "STRONG", "I", "EM", "U", "S", "DIV", "P", "BR", "UL", "OL", "LI", "BLOCKQUOTE"]);
  [...template.content.querySelectorAll("script, style, iframe, object, embed, link, meta")].forEach(element => element.remove());
  [...template.content.querySelectorAll("*")].reverse().forEach(element => {
    if (!allowed.has(element.tagName)) {
      element.replaceWith(...element.childNodes);
      return;
    }
    [...element.attributes].forEach(attribute => element.removeAttribute(attribute.name));
  });
  return template.innerHTML;
}

function plainTextFromHTML(html) {
  const temp = document.createElement("div");
  temp.innerHTML = sanitizeHTML(html);
  return (temp.innerText || temp.textContent || "").trim();
}

function setEditorColor(color) {
  editorColor = COLORS[color] ? color : "sand";
  $("note-editor").querySelector(".note-editor").style.setProperty("--editor-color", COLORS[editorColor]);
  document.querySelectorAll("[data-note-color]").forEach(button => button.classList.toggle("selected", button.dataset.noteColor === editorColor));
}

function markEditorDirty() {
  editorDirty = true;
  $("editor-status").textContent = "Nicht gespeichert";
  setError("editor-error", "");
}

function openEditor(note = null) {
  editingNoteId = note?.id || null;
  editorPinned = Boolean(note?.pinned);
  editorDirty = false;
  renderFolderOptions();
  $("note-title").value = note?.title || "";
  $("note-body").innerHTML = sanitizeHTML(note?.contentHtml || "");
  $("note-folder").value = note?.folderId && folders.some(folder => folder.id === note.folderId) ? note.folderId : (activeFilter.type === "folder" ? activeFilter.id : "");
  $("pin-note-btn").textContent = editorPinned ? "★" : "☆";
  $("pin-note-btn").setAttribute("aria-pressed", String(editorPinned));
  $("delete-note-btn").hidden = !editingNoteId;
  $("editor-status").textContent = note ? `Gespeichert ${formatUpdated(note.updatedAt || note.createdAt)}` : "Neue Notiz";
  setEditorColor(note?.color || "sand");
  setError("editor-error", "");
  $("note-editor").hidden = false;
  document.body.style.overflow = "hidden";
  setTimeout(() => (note ? $("note-body") : $("note-title")).focus(), 50);
}

function requestCloseEditor() {
  if (editorDirty && !confirm("Notiz ohne Speichern schliessen?")) return;
  $("note-editor").hidden = true;
  document.body.style.overflow = "";
  editingNoteId = null;
  editorDirty = false;
}

async function saveEditor() {
  if (!currentUser) return;
  const titleInput = $("note-title").value.trim();
  const contentHtml = sanitizeHTML($("note-body").innerHTML);
  const contentText = plainTextFromHTML(contentHtml);
  const title = titleInput || (contentText ? "Ohne Titel" : "");
  if (!title && !contentText) return setError("editor-error", "Schreibe zuerst einen Titel oder eine Notiz.");
  if (contentHtml.length > 140000 || contentText.length > 100000) return setError("editor-error", "Diese Notiz ist zu lang. Teile sie in zwei Notizen auf.");
  const folderId = folders.some(folder => folder.id === $("note-folder").value) ? $("note-folder").value : "";
  const button = $("save-note-btn");
  setBusy(button, true, "Speichert …");
  try {
    const data = { title, contentHtml, contentText, folderId, color: editorColor, pinned: editorPinned, updatedAt: serverTimestamp() };
    if (editingNoteId) {
      await updateDoc(doc(db, "notes", currentUser.uid, "items", editingNoteId), data);
    } else {
      data.createdAt = serverTimestamp();
      await addDoc(collection(db, "notes", currentUser.uid, "items"), data);
    }
    editorDirty = false;
    $("note-editor").hidden = true;
    document.body.style.overflow = "";
    editingNoteId = null;
    toast("✓ Notiz gespeichert");
  } catch (error) {
    console.error(error);
    setError("editor-error", "Die Notiz konnte nicht gespeichert werden. Prüfe die Verbindung und Firebase-Regeln.");
  } finally {
    setBusy(button, false);
  }
}

async function deleteCurrentNote() {
  if (!editingNoteId || !confirm("Diese Notiz wirklich löschen?")) return;
  try {
    await deleteDoc(doc(db, "notes", currentUser.uid, "items", editingNoteId));
    editorDirty = false;
    $("note-editor").hidden = true;
    document.body.style.overflow = "";
    editingNoteId = null;
    toast("Notiz gelöscht");
  } catch {
    setError("editor-error", "Die Notiz konnte nicht gelöscht werden.");
  }
}

async function toggleQuickPin(noteId) {
  const note = notes.find(item => item.id === noteId);
  if (!note) return;
  try {
    await updateDoc(doc(db, "notes", currentUser.uid, "items", note.id), { pinned: !note.pinned, updatedAt: serverTimestamp() });
  } catch {
    toast("⚠️ Anheften hat nicht funktioniert");
  }
}

function renderManageFolders() {
  if (!$("manage-folder-list")) return;
  $("manage-folder-list").innerHTML = folders.length ? folders.map(folder => `<div class="manage-folder-row"><span>📁 ${escapeHTML(folder.name)} · ${folderCount(folder.id)} Notizen</span><button type="button" data-delete-folder="${encodeId(folder.id)}">Löschen</button></div>`).join("") : '<div class="empty-state" style="padding:1.3rem">Noch keine Ordner.</div>';
}

function openFoldersModal() {
  $("folder-name").value = "";
  setError("folder-error", "");
  renderManageFolders();
  $("folders-modal").hidden = false;
  document.body.style.overflow = "hidden";
  setTimeout(() => $("folder-name").focus(), 50);
}

function closeFoldersModal() {
  $("folders-modal").hidden = true;
  document.body.style.overflow = "";
}

async function addFolder(event) {
  event.preventDefault();
  const name = $("folder-name").value.trim().replace(/\s+/g, " ");
  setError("folder-error", "");
  if (name.length < 1 || name.length > 40) return setError("folder-error", "Der Ordnername muss 1 bis 40 Zeichen haben.");
  if (folders.some(folder => normalizeSearch(folder.name) === normalizeSearch(name))) return setError("folder-error", "Dieser Ordner existiert bereits.");
  const button = $("folder-save-btn");
  setBusy(button, true, "Fügt hinzu …");
  try {
    await addDoc(collection(db, "noteFolders", currentUser.uid, "folders"), { name, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    $("folder-name").value = "";
    toast("✓ Ordner erstellt");
  } catch {
    setError("folder-error", "Der Ordner konnte nicht erstellt werden.");
  } finally {
    setBusy(button, false);
  }
}

async function removeFolder(folderId) {
  const folder = folders.find(item => item.id === folderId);
  if (!folder || !confirm(`Ordner „${folder.name}“ löschen? Die Notizen bleiben erhalten und werden zu „Kein Ordner“ verschoben.`)) return;
  showLoading("Ordner wird entfernt …");
  try {
    const batch = writeBatch(db);
    notes.filter(note => note.folderId === folderId).forEach(note => {
      batch.update(doc(db, "notes", currentUser.uid, "items", note.id), { folderId: "", updatedAt: serverTimestamp() });
    });
    batch.delete(doc(db, "noteFolders", currentUser.uid, "folders", folderId));
    await batch.commit();
    if (activeFilter.type === "folder" && activeFilter.id === folderId) activeFilter = { type: "all", id: null };
    toast("Ordner gelöscht – Notizen bleiben erhalten");
  } catch {
    toast("⚠️ Der Ordner konnte nicht gelöscht werden");
  } finally {
    hideLoading();
  }
}

function openSidebar() {
  $("notes-sidebar").classList.add("open");
  $("drawer-backdrop").hidden = false;
}

function closeSidebar() {
  $("notes-sidebar").classList.remove("open");
  $("drawer-backdrop").hidden = true;
}

async function handleLogin(event) {
  event.preventDefault();
  const email = $("login-email").value.trim().toLowerCase();
  const password = $("login-password").value;
  setError("login-error", "");
  if (!email || !password) return setError("login-error", "Gib E-Mail und persönliches Passwort ein.");
  const button = $("login-submit");
  setBusy(button, true, "Meldet an …");
  authBusy = true;
  try {
    const credential = await signInWithEmailAndPassword(auth, email, password);
    await loadSession(credential.user);
  } catch (error) {
    const message = error?.code === "auth/invalid-credential" || error?.code === "auth/wrong-password"
      ? "E-Mail oder persönliches Passwort stimmt nicht."
      : "Die Anmeldung hat nicht funktioniert.";
    setError("login-error", message);
  } finally {
    authBusy = false;
    setBusy(button, false);
  }
}

async function logout() {
  stopListeners();
  currentUser = null;
  currentProfile = null;
  await signOut(auth);
  $("login-password").value = "";
  showScreen("screen-login");
}

// Navigation and notes overview
$("login-form").addEventListener("submit", handleLogin);
$("logout-btn").addEventListener("click", logout);
$("blocked-logout-btn").addEventListener("click", logout);
$("open-sidebar-btn").addEventListener("click", openSidebar);
$("close-sidebar-btn").addEventListener("click", closeSidebar);
$("drawer-backdrop").addEventListener("click", closeSidebar);
$("manage-folders-btn").addEventListener("click", openFoldersModal);
$("desktop-new-note-btn").addEventListener("click", () => openEditor());
$("floating-new-note-btn").addEventListener("click", () => openEditor());

document.querySelectorAll("[data-note-filter]").forEach(button => button.addEventListener("click", () => setFilter(button.dataset.noteFilter)));
$("folder-list").addEventListener("click", event => {
  const button = event.target.closest("[data-folder-filter]");
  if (button) setFilter("folder", decodeId(button.dataset.folderFilter));
});
$("mobile-folder-strip").addEventListener("click", event => {
  const filter = event.target.closest("[data-mobile-filter]");
  const folder = event.target.closest("[data-mobile-folder]");
  if (filter) setFilter(filter.dataset.mobileFilter);
  if (folder) setFilter("folder", decodeId(folder.dataset.mobileFolder));
});

$("toggle-search-btn").addEventListener("click", () => {
  const opening = $("notes-search-wrap").hidden;
  $("notes-search-wrap").hidden = !opening;
  if (opening) setTimeout(() => $("notes-search").focus(), 30);
});
$("notes-search").addEventListener("input", renderNotes);
$("clear-notes-search").addEventListener("click", () => { $("notes-search").value = ""; renderNotes(); $("notes-search").focus(); });
$("toggle-view-btn").addEventListener("click", () => {
  viewMode = viewMode === "grid" ? "list" : "grid";
  localStorage.setItem("g23f-notes-view", viewMode);
  renderNotes();
});

$("notes-content").addEventListener("click", event => {
  const pin = event.target.closest("[data-quick-pin]");
  const open = event.target.closest("[data-open-note]");
  if (pin) return toggleQuickPin(decodeId(pin.dataset.quickPin));
  if (open) {
    const note = notes.find(item => item.id === decodeId(open.dataset.openNote));
    if (note) openEditor(note);
    return;
  }
  if (event.target.closest("[data-empty-new-note]")) openEditor();
});

// Editor
$("close-editor-btn").addEventListener("click", requestCloseEditor);
$("save-note-btn").addEventListener("click", saveEditor);
$("delete-note-btn").addEventListener("click", deleteCurrentNote);
$("pin-note-btn").addEventListener("click", () => {
  editorPinned = !editorPinned;
  $("pin-note-btn").textContent = editorPinned ? "★" : "☆";
  $("pin-note-btn").setAttribute("aria-pressed", String(editorPinned));
  markEditorDirty();
});
$("note-title").addEventListener("input", markEditorDirty);
$("note-body").addEventListener("input", markEditorDirty);
$("note-folder").addEventListener("change", markEditorDirty);
$("note-body").addEventListener("paste", event => {
  event.preventDefault();
  document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
});
$("color-picker").addEventListener("click", event => {
  const button = event.target.closest("[data-note-color]");
  if (!button) return;
  setEditorColor(button.dataset.noteColor);
  markEditorDirty();
});
$("format-toolbar").addEventListener("mousedown", event => {
  if (event.target.closest("button")) event.preventDefault();
});
$("format-toolbar").addEventListener("click", event => {
  const command = event.target.closest("[data-command]")?.dataset.command;
  if (!command) return;
  $("note-body").focus();
  document.execCommand(command, false, null);
  markEditorDirty();
});
$("insert-check-btn").addEventListener("click", () => {
  $("note-body").focus();
  document.execCommand("insertText", false, "☐ ");
  markEditorDirty();
});

// Folders
$("folder-form").addEventListener("submit", addFolder);
$("close-folders-btn").addEventListener("click", closeFoldersModal);
$("folders-modal").addEventListener("click", event => { if (event.target === $("folders-modal")) closeFoldersModal(); });
$("manage-folder-list").addEventListener("click", event => {
  const button = event.target.closest("[data-delete-folder]");
  if (button) removeFolder(decodeId(button.dataset.deleteFolder));
});

document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  if (!$("note-editor").hidden) requestCloseEditor();
  else if (!$("folders-modal").hidden) closeFoldersModal();
  else closeSidebar();
});

onAuthStateChanged(auth, user => {
  if (authBusy) return;
  if (user) loadSession(user);
  else {
    stopListeners();
    currentUser = null;
    currentProfile = null;
    hideLoading();
    showScreen("screen-login");
  }
});
