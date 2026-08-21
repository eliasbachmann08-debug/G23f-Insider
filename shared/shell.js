import {
  collection, addDoc, deleteDoc, doc, getDocs, onSnapshot, query,
  serverTimestamp, setDoc, updateDoc, where
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  sendEmailVerification, sendPasswordResetEmail, signOut
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { auth, db, isAdminUser } from "./firebase.js";

const STATUS_LABELS = { open: "Eingegangen", review: "Wird geprüft", done: "Erledigt" };
const CATEGORY_LABELS = {
  fehler: "Fehler", idee: "Verbesserungsidee", inhalt: "Falscher Inhalt",
  name: "Namenskorrektur", konto: "Konto / Daten", sonstiges: "Sonstiges"
};

let currentContext = null;
let feedbackUnsubscribe = null;
let reportsUnsubscribe = null;
let accountBlockUnsubscribe = null;
let ownFeedback = [];
let adminFeedback = [];
let adminReports = [];
let adminAccounts = [];
let adminTab = "feedback";
let toastTimer = null;

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function encodeId(value) {
  return escapeHTML(encodeURIComponent(String(value || "")));
}

function decodeId(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function initials(name) {
  return String(name || "?").trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "?";
}

function timestampDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value.seconds) return new Date(value.seconds * 1000);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(value) {
  const date = timestampDate(value);
  return date ? date.toLocaleString("de-CH", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "Gerade eben";
}

function avatarInner(profile) {
  return profile?.photoData
    ? `<img src="${escapeHTML(profile.photoData)}" alt="">`
    : escapeHTML(initials(profile?.nickname));
}

function toast(message) {
  let element = document.getElementById("g23f-shell-toast");
  if (!element) {
    element = document.createElement("div");
    element.id = "g23f-shell-toast";
    element.style.cssText = "position:fixed;right:1rem;top:max(4.8rem,calc(env(safe-area-inset-top) + 4.8rem));z-index:2000;width:max-content;max-width:min(390px,calc(100% - 2rem));padding:.7rem 1rem;border-radius:12px;background:#1f1b17;color:#fff;transform:translateY(-12px);opacity:0;transition:.2s;font:500 .74rem/1.4 Inter,sans-serif;text-align:left;pointer-events:none";
    document.body.append(element);
  }
  clearTimeout(toastTimer);
  element.textContent = message;
  element.style.opacity = "1";
  element.style.transform = "translateY(0)";
  toastTimer = setTimeout(() => {
    element.style.opacity = "0";
    element.style.transform = "translateY(-12px)";
  }, 3200);
}

function setModal(id, open) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.hidden = !open;
  document.body.style.overflow = open ? "hidden" : "";
  if (open) setTimeout(() => modal.querySelector("button, input, select, textarea")?.focus(), 30);
}

function injectShell() {
  if (document.getElementById("g23f-profile-modal")) return;
  document.body.insertAdjacentHTML("beforeend", `
    <div class="g23f-shell-modal" id="g23f-profile-modal" hidden>
      <section class="g23f-shell-panel" role="dialog" aria-modal="true" aria-labelledby="g23f-profile-title">
        <button class="g23f-shell-close" type="button" data-g23f-close="g23f-profile-modal" aria-label="Schliessen">✕</button>
        <p class="g23f-shell-kicker">Dein Konto</p>
        <h2 id="g23f-profile-title">Profil</h2>
        <div id="g23f-profile-content"></div>
      </section>
    </div>
    <div class="g23f-shell-modal" id="g23f-feedback-modal" hidden>
      <section class="g23f-shell-panel" role="dialog" aria-modal="true" aria-labelledby="g23f-feedback-title">
        <button class="g23f-shell-close" type="button" data-g23f-close="g23f-feedback-modal" aria-label="Schliessen">✕</button>
        <p class="g23f-shell-kicker">Direkt an Elias</p>
        <h2 id="g23f-feedback-title">Fehler oder Idee melden</h2>
        <p class="g23f-shell-muted">Schreib kurz, was nicht gut ist oder was die App besser machen würde. Inhalte aus privaten Notes oder privaten Einträgen werden nie automatisch mitgeschickt.</p>
        <form class="g23f-shell-form" id="g23f-feedback-form">
          <label for="g23f-feedback-category">Art</label>
          <select id="g23f-feedback-category" required>
            <option value="fehler">Fehler</option><option value="idee">Verbesserungsidee</option>
            <option value="inhalt">Falscher Inhalt</option><option value="name">Namenskorrektur</option>
            <option value="konto">Konto / eigene Daten</option><option value="sonstiges">Sonstiges</option>
          </select>
          <label for="g23f-feedback-message">Nachricht</label>
          <textarea id="g23f-feedback-message" rows="4" maxlength="600" placeholder="Was ist dir aufgefallen?" required></textarea>
          <p class="g23f-shell-error" id="g23f-feedback-error"></p>
          <button class="g23f-shell-btn primary" id="g23f-feedback-submit" type="submit">Senden</button>
        </form>
        <div class="g23f-status-list" id="g23f-own-feedback"></div>
      </section>
    </div>
    <div class="g23f-shell-modal" id="g23f-admin-modal" hidden>
      <section class="g23f-shell-panel wide" role="dialog" aria-modal="true" aria-labelledby="g23f-admin-title">
        <button class="g23f-shell-close" type="button" data-g23f-close="g23f-admin-modal" aria-label="Schliessen">✕</button>
        <p class="g23f-shell-kicker">Adminbereich</p>
        <h2 id="g23f-admin-title">Inbox &amp; Konten</h2>
        <div class="g23f-admin-tabs" id="g23f-admin-tabs">
          <button class="g23f-shell-btn active" type="button" data-admin-tab="feedback">Feedback</button>
          <button class="g23f-shell-btn" type="button" data-admin-tab="reports">Meldungen</button>
          <button class="g23f-shell-btn" type="button" data-admin-tab="accounts">Konten</button>
        </div>
        <div class="g23f-admin-section" id="g23f-admin-content"></div>
      </section>
    </div>
    <div class="g23f-notification-stack">
      <div class="g23f-verify-banner" id="g23f-verify-banner" hidden>
        <div class="g23f-verify-copy">
          <strong>⚠️ E-Mail noch bestätigen</strong>
          <span><b>Wichtig:</b> Die Bestätigungsmail landet häufig im Spam-Ordner. Prüfe ihn direkt, falls die Mail fehlt.</span>
          <small>Nach oben wischen oder den Pfeil antippen, um den Hinweis auszublenden.</small>
        </div>
        <div class="g23f-verify-actions">
          <button class="g23f-shell-btn" id="g23f-resend-verification" type="button">Mail erneut senden</button>
          <button class="g23f-verify-dismiss" id="g23f-dismiss-verification" type="button" aria-label="Hinweis bis zum nächsten Seitenaufruf ausblenden">↑</button>
        </div>
      </div>
      <div class="g23f-update-banner" id="g23f-update-banner" hidden>
        <span>Eine neue Version ist verfügbar.</span>
        <button class="g23f-shell-btn primary" id="g23f-update-btn" type="button">Aktualisieren</button>
      </div>
    </div>`);
}

function renderProfile() {
  const { user, profile } = currentContext;
  const verified = user.emailVerified;
  document.getElementById("g23f-profile-content").innerHTML = `
    <div class="g23f-profile-head">
      <span class="g23f-shell-avatar">${avatarInner(profile)}</span>
      <div><h3>${escapeHTML(profile.nickname || "Profil")}</h3><p class="g23f-shell-muted">E-Mail ${verified ? "bestätigt ✓" : "noch nicht bestätigt"}</p></div>
    </div>
    <p class="g23f-shell-muted">Dein Vorname ist deine eindeutige Klassen-ID und kann nicht frei geändert werden.</p>
    <div class="g23f-shell-actions">
      <label class="g23f-shell-btn g23f-photo-label">📷 Profilbild ändern<input id="g23f-photo-input" type="file" accept="image/*"></label>
      <button class="g23f-shell-btn" id="g23f-reset-password" type="button">Passwort zurücksetzen</button>
      ${verified ? "" : '<button class="g23f-shell-btn" id="g23f-profile-verify" type="button">Bestätigungsmail senden</button>'}
      <button class="g23f-shell-btn" id="g23f-export-data" type="button">Eigene Daten exportieren</button>
      <button class="g23f-shell-btn" id="g23f-name-request" type="button">Namenskorrektur anfragen</button>
      <button class="g23f-shell-btn danger" id="g23f-delete-request" type="button">Konto löschen lassen</button>
      <button class="g23f-shell-btn danger" id="g23f-profile-logout" type="button">Abmelden</button>
    </div>
    <div class="g23f-privacy-box g23f-shell-muted">Deine E-Mail-Adresse ist für Mitschüler nicht sichtbar. Als technischer Administrator könnte Elias sie in Firebase einsehen.</div>`;

  document.getElementById("g23f-photo-input")?.addEventListener("change", updatePhoto);
  document.getElementById("g23f-reset-password")?.addEventListener("click", resetPassword);
  document.getElementById("g23f-profile-verify")?.addEventListener("click", sendVerification);
  document.getElementById("g23f-export-data")?.addEventListener("click", exportOwnData);
  document.getElementById("g23f-name-request")?.addEventListener("click", () => openFeedback("name", `Mein Vorname sollte von „${profile.nickname || ""}“ zu … geändert werden.`));
  document.getElementById("g23f-delete-request")?.addEventListener("click", () => openFeedback("konto", "Bitte lösche mein Klassenkonto und meine gespeicherten Daten."));
  document.getElementById("g23f-profile-logout")?.addEventListener("click", logout);
}

function updateProfileTriggers() {
  document.querySelectorAll("[data-g23f-profile]").forEach(button => {
    button.classList.add("g23f-profile-trigger");
    button.innerHTML = `<span class="g23f-shell-avatar">${avatarInner(currentContext.profile)}</span><span class="g23f-profile-name">${escapeHTML(currentContext.profile.nickname || "Profil")}</span>`;
    button.hidden = false;
  });
  document.querySelectorAll("[data-g23f-admin]").forEach(button => {
    button.classList.add("g23f-admin-trigger");
    button.hidden = !currentContext.admin;
  });
}

async function resizeImage(file, maxSize = 220) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const image = new Image();
      image.onerror = reject;
      image.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d");
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", .8));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function updatePhoto(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/") || file.size > 2 * 1024 * 1024) return toast("Wähle ein Bild mit höchstens 2 MB.");
  try {
    const photoData = await resizeImage(file);
    await updateDoc(doc(db, "users", currentContext.user.uid), { photoData });
    currentContext.profile.photoData = photoData;
    updateProfileTriggers();
    renderProfile();
    currentContext.onProfileUpdated?.(currentContext.profile);
    toast("✓ Profilbild gespeichert");
  } catch {
    toast("Das Profilbild konnte nicht gespeichert werden.");
  }
}

async function resetPassword() {
  try {
    await sendPasswordResetEmail(auth, currentContext.user.email);
    toast("✓ E-Mail zum Zurücksetzen wurde gesendet");
  } catch {
    toast("Die E-Mail konnte nicht gesendet werden.");
  }
}

async function sendVerification() {
  try {
    await sendEmailVerification(currentContext.user, { url: new URL(currentContext.rootPath, location.href).href });
    toast("Bestätigungsmail gesendet. Wichtig, prüfe direkt auch den Spam-Ordner.");
  } catch (error) {
    toast(error?.code === "auth/too-many-requests" ? "Warte kurz, bevor du die Mail nochmals sendest." : "Die Mail konnte nicht gesendet werden.");
  }
}

function download(name, content, type = "application/json") {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function exportOwnData() {
  const button = document.getElementById("g23f-export-data");
  button.disabled = true;
  try {
    const uid = currentContext.user.uid;
    const [notes, folders, progress, feedback, entries] = await Promise.all([
      getDocs(collection(db, "notes", uid, "items")),
      getDocs(collection(db, "noteFolders", uid, "folders")),
      getDocs(collection(db, "entryProgress", uid, "items")),
      getDocs(query(collection(db, "feedback"), where("authorUid", "==", uid))),
      getDocs(query(collection(db, "eintraege"), where("authorUid", "==", uid)))
    ]);
    const clean = snapshot => snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    download(`g23f-daten-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({
      exportedAt: new Date().toISOString(), profile: currentContext.profile,
      notes: clean(notes), folders: clean(folders), completedEntries: clean(progress),
      feedback: clean(feedback), ownTimetableEntries: clean(entries)
    }, null, 2));
    toast("✓ Eigene Daten exportiert");
  } catch {
    toast("Der Export konnte nicht erstellt werden.");
  } finally {
    button.disabled = false;
  }
}

function openFeedback(category = "fehler", message = "") {
  setModal("g23f-profile-modal", false);
  document.getElementById("g23f-feedback-category").value = category;
  document.getElementById("g23f-feedback-message").value = message;
  document.getElementById("g23f-feedback-error").textContent = "";
  renderOwnFeedback();
  setModal("g23f-feedback-modal", true);
}

async function submitFeedback(event) {
  event.preventDefault();
  const category = document.getElementById("g23f-feedback-category").value;
  const message = document.getElementById("g23f-feedback-message").value.trim();
  const error = document.getElementById("g23f-feedback-error");
  if (!message) {
    error.textContent = "Schreib bitte kurz, was dir aufgefallen ist.";
    return;
  }
  const button = document.getElementById("g23f-feedback-submit");
  button.disabled = true;
  try {
    await addDoc(collection(db, "feedback"), {
      authorUid: currentContext.user.uid,
      authorName: currentContext.profile.nickname,
      category,
      message,
      page: currentContext.pageLabel,
      status: "open",
      createdAt: serverTimestamp(),
      updatedAt: null,
      updatedByUid: null
    });
    document.getElementById("g23f-feedback-message").value = "";
    error.textContent = "";
    toast("✓ Feedback an Elias gesendet");
  } catch {
    error.textContent = "Das Feedback konnte nicht gespeichert werden.";
  } finally {
    button.disabled = false;
  }
}

function renderOwnFeedback() {
  const container = document.getElementById("g23f-own-feedback");
  const list = [...ownFeedback].sort((a, b) => (timestampDate(b.createdAt)?.getTime() || 0) - (timestampDate(a.createdAt)?.getTime() || 0)).slice(0, 8);
  container.innerHTML = list.length
    ? `<h3>Deine Rückmeldungen</h3>${list.map(item => `<article class="g23f-status-card"><div class="g23f-card-head"><strong>${escapeHTML(CATEGORY_LABELS[item.category] || item.category)}</strong><span class="g23f-status-pill ${escapeHTML(item.status)}">${escapeHTML(STATUS_LABELS[item.status] || item.status)}</span></div><p>${escapeHTML(item.message)}</p><p>${escapeHTML(formatDate(item.createdAt))}</p></article>`).join("")}`
    : "";
}

function startFeedbackListener() {
  feedbackUnsubscribe?.();
  const source = currentContext.admin
    ? collection(db, "feedback")
    : query(collection(db, "feedback"), where("authorUid", "==", currentContext.user.uid));
  feedbackUnsubscribe = onSnapshot(source, snapshot => {
    const values = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    if (currentContext.admin) adminFeedback = values;
    ownFeedback = currentContext.admin ? values.filter(item => item.authorUid === currentContext.user.uid) : values;
    renderOwnFeedback();
    updateAdminCount();
    renderAdmin();
  });
}

function startAdminListeners() {
  if (!currentContext.admin) return;
  reportsUnsubscribe?.();
  reportsUnsubscribe = onSnapshot(collection(db, "reports"), snapshot => {
    adminReports = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    updateAdminCount();
    renderAdmin();
  });
  loadAccounts();
}

function startAccountBlockListener() {
  accountBlockUnsubscribe?.();
  accountBlockUnsubscribe = null;
  if (currentContext.admin) return;
  accountBlockUnsubscribe = onSnapshot(doc(db, "accountBlocks", currentContext.user.uid), snapshot => {
    if (!snapshot.exists()) return;
    feedbackUnsubscribe?.();
    reportsUnsubscribe?.();
    accountBlockUnsubscribe?.();
    signOut(auth).finally(() => location.replace(`${currentContext.rootPath}?error=blocked`));
  }, () => {});
}

async function loadAccounts() {
  if (!currentContext.admin) return;
  try {
    const [profilesSnapshot, membersSnapshot, blocksSnapshot] = await Promise.all([
      getDocs(collection(db, "users")),
      getDocs(collection(db, "members")),
      getDocs(collection(db, "accountBlocks")).catch(() => ({ docs: [] }))
    ]);
    const members = new Map(membersSnapshot.docs.map(item => [item.id, item.data()]));
    const blocks = new Set(blocksSnapshot.docs.map(item => item.id));
    adminAccounts = profilesSnapshot.docs
      .map(item => {
        const member = members.get(item.id);
        const legacyMemberBlocked = Boolean(member?.blocked);
        const hasBlock = blocks.has(item.id);
        return {
          uid: item.id,
          ...item.data(),
          blocked: legacyMemberBlocked || hasBlock,
          legacyMemberBlocked,
          hasBlock,
          hasMember: Boolean(member)
        };
      })
      .filter(item => item.nickname)
      .sort((a, b) => itemName(a).localeCompare(itemName(b), "de-CH", { sensitivity: "base" }));
    renderAdmin();
  } catch {
    adminAccounts = [];
  }
}

function itemName(item) {
  return String(item.nickname || item.authorName || "Unbekannt");
}

async function setAccountBlocked(uid, shouldBlock) {
  if (!currentContext?.admin || uid === currentContext.user.uid) throw new Error("invalid-block-target");
  const blockRef = doc(db, "accountBlocks", uid);
  if (shouldBlock) {
    await setDoc(blockRef, {
      blocked: true,
      createdAt: serverTimestamp(),
      createdByUid: currentContext.user.uid
    });
    return;
  }

  const account = adminAccounts.find(item => item.uid === uid);
  const tasks = [];
  if (!account || account.hasBlock) tasks.push(deleteDoc(blockRef));
  if (account?.hasMember && account.legacyMemberBlocked) {
    tasks.push(updateDoc(doc(db, "members", uid), {
      blocked: false,
      blockedAt: null,
      blockedByUid: null
    }));
  }
  await Promise.all(tasks);
}

function updateAdminCount() {
  if (!currentContext?.admin) return;
  const count = adminFeedback.filter(item => item.status !== "done").length + adminReports.filter(item => item.status === "open").length;
  document.querySelectorAll("[data-g23f-admin]").forEach(button => {
    let badge = button.querySelector(".g23f-shell-count");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "g23f-shell-count";
      button.append(badge);
    }
    badge.textContent = String(count);
    badge.hidden = count === 0;
  });
}

function renderAdmin() {
  if (!currentContext?.admin || document.getElementById("g23f-admin-modal")?.hidden) return;
  document.querySelectorAll("[data-admin-tab]").forEach(button => button.classList.toggle("active", button.dataset.adminTab === adminTab));
  const container = document.getElementById("g23f-admin-content");
  if (adminTab === "feedback") {
    const list = [...adminFeedback].sort((a, b) => (a.status === "done") - (b.status === "done") || (timestampDate(b.createdAt)?.getTime() || 0) - (timestampDate(a.createdAt)?.getTime() || 0));
    container.innerHTML = list.length ? list.map(item => `<article class="g23f-admin-card"><div class="g23f-card-head"><h3>${escapeHTML(CATEGORY_LABELS[item.category] || item.category)} · ${escapeHTML(item.authorName || "Unbekannt")}</h3><span class="g23f-status-pill ${escapeHTML(item.status)}">${escapeHTML(STATUS_LABELS[item.status] || item.status)}</span></div><p>${escapeHTML(item.message)}</p><p>${escapeHTML(item.page)} · ${escapeHTML(formatDate(item.createdAt))}</p><div class="g23f-shell-actions"><select data-feedback-status="${encodeId(item.id)}" aria-label="Status"><option value="open" ${item.status === "open" ? "selected" : ""}>Eingegangen</option><option value="review" ${item.status === "review" ? "selected" : ""}>Wird geprüft</option><option value="done" ${item.status === "done" ? "selected" : ""}>Erledigt</option></select><button class="g23f-shell-btn danger" type="button" data-delete-feedback="${encodeId(item.id)}">Löschen</button></div></article>`).join("") : '<div class="g23f-shell-empty">Noch kein allgemeines Feedback.</div>';
    return;
  }
  if (adminTab === "reports") {
    const list = [...adminReports].sort((a, b) => (a.status !== "open") - (b.status !== "open") || (timestampDate(b.createdAt)?.getTime() || 0) - (timestampDate(a.createdAt)?.getTime() || 0));
    container.innerHTML = list.length ? list.map(item => `<article class="g23f-admin-card"><div class="g23f-card-head"><h3>${item.targetType === "entry" ? "📅 Gemeldeter Eintrag" : `👤 Konto: ${escapeHTML(item.targetLabel)}`}</h3><span class="g23f-status-pill ${item.status === "open" ? "" : "done"}">${item.status === "open" ? "Offen" : "Erledigt"}</span></div><p>${escapeHTML(item.reason)} · gemeldet von ${escapeHTML(item.reporterName || "Unbekannt")}</p>${item.details ? `<p>${escapeHTML(item.details)}</p>` : ""}${item.targetType === "entry" ? '<p>🔒 Titel und Inhalt eines geschützten Eintrags werden hier nicht angezeigt.</p>' : ""}<div class="g23f-shell-actions">${item.status === "open" ? `<button class="g23f-shell-btn" type="button" data-resolve-report="${encodeId(item.id)}">Erledigt</button>` : ""}${item.targetType === "entry" ? `<button class="g23f-shell-btn danger" type="button" data-delete-reported-entry="${encodeId(item.id)}">Eintrag löschen</button>` : `<button class="g23f-shell-btn danger" type="button" data-block-reported-user="${encodeId(item.id)}">Konto sperren</button>`}</div></article>`).join("") : '<div class="g23f-shell-empty">Keine Meldungen.</div>';
    return;
  }
  container.innerHTML = adminAccounts.length ? adminAccounts.map(account => `<article class="g23f-admin-card g23f-account-row"><div class="g23f-account-name"><strong>${escapeHTML(account.nickname)}</strong>${account.blocked ? '<span class="g23f-status-pill">Gesperrt</span>' : ""}</div>${account.uid === currentContext.user.uid ? '<span class="g23f-shell-muted">Du</span>' : `<button class="g23f-shell-btn ${account.blocked ? "" : "danger"}" type="button" data-toggle-account="${encodeId(account.uid)}" data-blocked="${account.blocked}">${account.blocked ? "Entsperren" : "Sperren"}</button>`}</article>`).join("") : '<div class="g23f-shell-empty">Konten konnten nicht geladen werden.</div>';
}

async function handleAdminAction(event) {
  const status = event.target.closest("[data-feedback-status]");
  if (status) {
    if (event.type !== "change") return;
    try {
      await updateDoc(doc(db, "feedback", decodeId(status.dataset.feedbackStatus)), { status: status.value, updatedAt: serverTimestamp(), updatedByUid: currentContext.user.uid });
      toast("✓ Feedback-Status aktualisiert");
    } catch {
      toast("Der Status konnte nicht aktualisiert werden.");
    }
    return;
  }
  const deleteFeedbackButton = event.target.closest("[data-delete-feedback]");
  const resolveReportButton = event.target.closest("[data-resolve-report]");
  const deleteEntryButton = event.target.closest("[data-delete-reported-entry]");
  const blockReportedButton = event.target.closest("[data-block-reported-user]");
  const toggleAccountButton = event.target.closest("[data-toggle-account]");
  try {
    if (deleteFeedbackButton && confirm("Dieses Feedback wirklich löschen?")) {
      await deleteDoc(doc(db, "feedback", decodeId(deleteFeedbackButton.dataset.deleteFeedback)));
    } else if (resolveReportButton) {
      await updateDoc(doc(db, "reports", decodeId(resolveReportButton.dataset.resolveReport)), { status: "resolved", resolvedAt: serverTimestamp(), resolvedByUid: currentContext.user.uid });
    } else if (deleteEntryButton && confirm("Diesen gemeldeten Eintrag wirklich löschen? Der geschützte Inhalt wird nicht geöffnet.")) {
      const report = adminReports.find(item => item.id === decodeId(deleteEntryButton.dataset.deleteReportedEntry));
      if (report) {
        await deleteDoc(doc(db, "eintraege", report.targetId));
        await updateDoc(doc(db, "reports", report.id), { status: "resolved", resolvedAt: serverTimestamp(), resolvedByUid: currentContext.user.uid });
      }
    } else if (blockReportedButton && confirm("Dieses Konto wirklich sperren?")) {
      const report = adminReports.find(item => item.id === decodeId(blockReportedButton.dataset.blockReportedUser));
      if (report) await setAccountBlocked(report.targetId, true);
    } else if (toggleAccountButton) {
      const blocked = toggleAccountButton.dataset.blocked === "true";
      if (!blocked && !confirm("Dieses Konto wirklich sperren?")) return;
      await setAccountBlocked(decodeId(toggleAccountButton.dataset.toggleAccount), !blocked);
      await loadAccounts();
    }
    toast("✓ Adminbereich aktualisiert");
  } catch {
    toast("Die Aktion konnte nicht ausgeführt werden.");
  }
}

async function logout() {
  feedbackUnsubscribe?.();
  reportsUnsubscribe?.();
  accountBlockUnsubscribe?.();
  try { localStorage.removeItem("g23f-session-expected"); } catch {}
  await signOut(auth);
  location.href = currentContext.rootPath;
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register(`${currentContext.rootPath}service-worker.js`, { scope: currentContext.rootPath });
    const showUpdate = worker => {
      if (!worker) return;
      document.getElementById("g23f-update-banner").hidden = false;
      document.getElementById("g23f-update-btn").onclick = () => worker.postMessage({ type: "SKIP_WAITING" });
    };
    if (registration.waiting && navigator.serviceWorker.controller) showUpdate(registration.waiting);
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) showUpdate(worker);
      });
    });
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      location.reload();
    });
    registration.update().catch(() => {});
  } catch { /* Installation remains optional. */ }
}

function dismissVerificationBanner() {
  const banner = document.getElementById("g23f-verify-banner");
  if (!banner || banner.hidden || banner.classList.contains("dismissing")) return;
  banner.style.removeProperty("transform");
  banner.style.removeProperty("opacity");
  banner.classList.add("dismissing");
  setTimeout(() => {
    banner.hidden = true;
    banner.classList.remove("dismissing");
    banner.style.removeProperty("transform");
    banner.style.removeProperty("opacity");
  }, 190);
}

function setupVerificationBanner() {
  const banner = document.getElementById("g23f-verify-banner");
  if (!banner || banner.dataset.dismissReady === "true") return;
  banner.dataset.dismissReady = "true";
  document.getElementById("g23f-dismiss-verification")?.addEventListener("click", dismissVerificationBanner);

  let startX = 0;
  let startY = 0;
  let currentX = 0;
  let currentY = 0;
  let tracking = false;

  const resetPosition = () => {
    banner.style.removeProperty("transform");
    banner.style.removeProperty("opacity");
  };

  banner.addEventListener("touchstart", event => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    startX = currentX = touch.clientX;
    startY = currentY = touch.clientY;
    tracking = true;
  }, { passive: true });

  banner.addEventListener("touchmove", event => {
    if (!tracking || event.touches.length !== 1) return;
    const touch = event.touches[0];
    currentX = touch.clientX;
    currentY = touch.clientY;
    const deltaX = currentX - startX;
    const deltaY = currentY - startY;
    if (deltaY >= 0 || Math.abs(deltaY) <= Math.abs(deltaX)) return resetPosition();
    event.preventDefault();
    const distance = Math.max(deltaY, -90);
    banner.style.transform = `translateY(${distance}px)`;
    banner.style.opacity = String(Math.max(.25, 1 - Math.abs(distance) / 100));
  }, { passive: false });

  banner.addEventListener("touchend", () => {
    if (!tracking) return;
    tracking = false;
    const deltaX = currentX - startX;
    const deltaY = currentY - startY;
    if (deltaY < -42 && Math.abs(deltaY) > Math.abs(deltaX) * 1.2) dismissVerificationBanner();
    else resetPosition();
  }, { passive: true });
  banner.addEventListener("touchcancel", () => { tracking = false; resetPosition(); }, { passive: true });
  banner.addEventListener("wheel", event => {
    if (event.deltaY >= -18) return;
    event.preventDefault();
    dismissVerificationBanner();
  }, { passive: false });
}

export function mountGlobalShell({ user, profile, rootPath = "./", pageLabel = "G23f-Insider", onProfileUpdated = null }) {
  currentContext = { user, profile, rootPath, pageLabel, admin: isAdminUser(user), onProfileUpdated };
  injectShell();
  updateProfileTriggers();
  renderProfile();

  document.querySelectorAll("[data-g23f-profile]").forEach(button => button.addEventListener("click", () => { renderProfile(); setModal("g23f-profile-modal", true); }));
  document.querySelectorAll("[data-g23f-admin]").forEach(button => button.addEventListener("click", () => { adminTab = "feedback"; setModal("g23f-admin-modal", true); renderAdmin(); loadAccounts(); }));
  document.querySelectorAll("[data-g23f-logout]").forEach(button => button.addEventListener("click", logout));
  document.querySelectorAll("[data-g23f-feedback]").forEach(button => button.addEventListener("click", () => openFeedback()));
  document.querySelectorAll("[data-g23f-close]").forEach(button => button.addEventListener("click", () => setModal(button.dataset.g23fClose, false)));
  document.querySelectorAll(".g23f-shell-modal").forEach(modal => modal.addEventListener("click", event => { if (event.target === modal) setModal(modal.id, false); }));
  document.getElementById("g23f-feedback-form").addEventListener("submit", submitFeedback);
  document.getElementById("g23f-admin-tabs").addEventListener("click", event => {
    const button = event.target.closest("[data-admin-tab]");
    if (!button) return;
    adminTab = button.dataset.adminTab;
    renderAdmin();
    if (adminTab === "accounts") loadAccounts();
  });
  document.getElementById("g23f-admin-content").addEventListener("click", handleAdminAction);
  document.getElementById("g23f-admin-content").addEventListener("change", handleAdminAction);
  document.getElementById("g23f-resend-verification").addEventListener("click", sendVerification);

  const verificationBanner = document.getElementById("g23f-verify-banner");
  verificationBanner.classList.remove("dismissing");
  verificationBanner.style.removeProperty("transform");
  verificationBanner.style.removeProperty("opacity");
  verificationBanner.hidden = user.emailVerified || !user.email;
  setupVerificationBanner();
  startFeedbackListener();
  startAdminListeners();
  startAccountBlockListener();
  registerServiceWorker();
  return { openFeedback, openProfile: () => setModal("g23f-profile-modal", true), toast };
}
