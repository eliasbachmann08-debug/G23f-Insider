import {
  collection, addDoc, deleteDoc, doc, getDoc, getDocs, onSnapshot, query, runTransaction,
  serverTimestamp, setDoc, updateDoc, where, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  sendEmailVerification, sendPasswordResetEmail, signOut
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { auth, db, isAdminUser } from "./firebase.js";
import { DEFAULT_ARCADE_PROFILE, DEFAULT_SCORES, badgeProgress } from "./arcade-data.js";

const STATUS_LABELS = { open: "Eingegangen", review: "Wird geprüft", done: "Erledigt" };
const CATEGORY_LABELS = {
  fehler: "Fehler", idee: "Verbesserungsidee", inhalt: "Falscher Inhalt",
  name: "Namenskorrektur", konto: "Konto / Daten", sonstiges: "Sonstiges"
};
const EMAIL_NOTIFICATION_ID = "email-verification";

let currentContext = null;
let feedbackUnsubscribe = null;
let reportsUnsubscribe = null;
let accountBlockUnsubscribe = null;
let notificationAllUnsubscribe = null;
let notificationSpecificUnsubscribe = null;
let notificationStateUnsubscribe = null;
let ownFeedback = [];
let adminFeedback = [];
let adminReports = [];
let adminAccounts = [];
let notificationSources = { all: [], specific: [] };
let notificationStates = new Map();
let notificationSelectedUids = new Set();
let adminTab = "feedback";
let toastTimer = null;
let arcadeProfileUnsubscribe = null;
let ownWallet = {};
let ownArcadeProfile = { ...DEFAULT_ARCADE_PROFILE };
let ownScores = { ...DEFAULT_SCORES };

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
    <div class="g23f-shell-modal" id="g23f-public-profile-modal" hidden>
      <section class="g23f-shell-panel" role="dialog" aria-modal="true" aria-labelledby="g23f-public-profile-title">
        <button class="g23f-shell-close" type="button" data-g23f-close="g23f-public-profile-modal" aria-label="Schliessen">✕</button>
        <p class="g23f-shell-kicker">Klassenprofil</p><h2 id="g23f-public-profile-title">Profil</h2>
        <div id="g23f-public-profile-content"><p class="g23f-shell-muted">Profil wird geladen …</p></div>
      </section>
    </div>
    <div class="g23f-shell-modal" id="g23f-notifications-modal" hidden>
      <section class="g23f-shell-panel wide" role="dialog" aria-modal="true" aria-labelledby="g23f-notifications-title">
        <button class="g23f-shell-close" type="button" data-g23f-close="g23f-notifications-modal" aria-label="Schliessen">✕</button>
        <div class="g23f-notification-heading">
          <div>
            <p class="g23f-shell-kicker">Dein Bereich</p>
            <h2 id="g23f-notifications-title">Benachrichtigungen</h2>
            <p class="g23f-shell-muted">Die Zahl bei der Glocke zeigt deine unerledigten Benachrichtigungen.</p>
          </div>
          <button class="g23f-shell-btn primary" id="g23f-new-notification" type="button" hidden>＋ Erstellen</button>
        </div>
        <form class="g23f-shell-form g23f-notification-form" id="g23f-notification-form" hidden>
          <h3>Neue Benachrichtigung</h3>
          <label for="g23f-notification-title">Titel</label>
          <input id="g23f-notification-title" type="text" maxlength="100" placeholder="Kurzer Titel" required>
          <label for="g23f-notification-message">Nachricht</label>
          <textarea id="g23f-notification-message" rows="4" maxlength="800" placeholder="Was sollen die Empfänger wissen?" required></textarea>
          <label for="g23f-notification-target">Empfänger</label>
          <select id="g23f-notification-target">
            <option value="all">Alle</option>
            <option value="specific">Bestimmte Personen</option>
          </select>
          <div class="g23f-notification-people-wrap" id="g23f-notification-people-wrap" hidden>
            <label for="g23f-notification-people-search">Personen suchen</label>
            <input id="g23f-notification-people-search" type="search" autocomplete="off" placeholder="Vorname">
            <div class="g23f-notification-people" id="g23f-notification-people"></div>
          </div>
          <p class="g23f-shell-error" id="g23f-notification-error"></p>
          <div class="g23f-shell-actions">
            <button class="g23f-shell-btn primary" id="g23f-notification-submit" type="submit">Senden</button>
            <button class="g23f-shell-btn" id="g23f-notification-cancel" type="button">Abbrechen</button>
          </div>
        </form>
        <div class="g23f-notification-list" id="g23f-notification-list"></div>
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
          <button class="g23f-shell-btn" type="button" data-admin-tab="coins">Münzen</button>
        </div>
        <div class="g23f-admin-section" id="g23f-admin-content"></div>
      </section>
    </div>
    <div class="g23f-notification-stack">
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
    <div class="g23f-arcade-summary"><strong>🪙 ${Number(ownWallet.balance || 0)} Münzen</strong><span>${badgeProgress(ownWallet, ownScores).filter(item => item.tier >= 0).length} Abzeichen verdient</span><a href="${escapeHTML(currentContext.rootPath)}arcade/">Arcade, Shop und Spiele öffnen</a></div>
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

function renderBadgeGrid(wallet, scores) {
  return `<div class="g23f-badge-grid">${badgeProgress(wallet, scores).map(item => `<div class="g23f-badge ${item.tier < 0 ? "locked" : `tier-${item.tier}`}"><span>${item.icon}</span><strong>${escapeHTML(item.name)}</strong><small>${escapeHTML(item.tierName)}</small><em>${item.tier >= 4 ? "Maximum" : `${item.value} / ${item.next}`}</em></div>`).join("")}</div>`;
}

export async function openPublicProfile(uid) {
  if (!currentContext || !uid) return;
  setModal("g23f-public-profile-modal", true);
  const target = document.getElementById("g23f-public-profile-content");
  target.innerHTML = '<p class="g23f-shell-muted">Profil wird geladen …</p>';
  try {
    const [profileSnap, walletSnap, arcadeSnap, scoreSnap] = await Promise.all([
      getDoc(doc(db, "users", uid)), getDoc(doc(db, "coinWallets", uid)),
      getDoc(doc(db, "arcadeProfiles", uid)), getDoc(doc(db, "gameScores", uid))
    ]);
    if (!profileSnap.exists()) throw new Error("missing");
    const person = profileSnap.data(), publicWallet = walletSnap.data() || {}, publicArcade = arcadeSnap.data() || DEFAULT_ARCADE_PROFILE;
    target.innerHTML = `<div class="g23f-public-head"><span class="g23f-shell-avatar g23f-frame ${escapeHTML(publicArcade.equippedFrame || "default")}">${avatarInner(person)}</span><div><h3>${escapeHTML(person.nickname || "Profil")}</h3><p>🪙 ${Number(publicWallet.balance || 0)} Münzen</p></div></div><h3 class="g23f-badge-heading">Abzeichen</h3>${renderBadgeGrid(publicWallet, scoreSnap.data() || {})}`;
  } catch { target.innerHTML = '<p class="g23f-shell-muted">Dieses Profil konnte nicht geladen werden.</p>'; }
}

function startArcadeProfile() {
  arcadeProfileUnsubscribe?.();
  const uid = currentContext.user.uid;
  const stops = [
    onSnapshot(doc(db,"coinWallets",uid), snap => { ownWallet=snap.data()||{}; document.querySelectorAll("[data-g23f-coins]").forEach(x=>x.textContent=String(ownWallet.balance||0)); if(!document.getElementById("g23f-profile-modal")?.hidden) renderProfile(); }),
    onSnapshot(doc(db,"arcadeProfiles",uid), snap => { ownArcadeProfile={...DEFAULT_ARCADE_PROFILE,...snap.data()}; document.documentElement.dataset.g23fTheme=(ownArcadeProfile.equippedTheme||"classic").replace("theme-",""); updateProfileTriggers(); }),
    onSnapshot(doc(db,"gameScores",uid), snap => { ownScores={...DEFAULT_SCORES,...snap.data()}; if(!document.getElementById("g23f-profile-modal")?.hidden) renderProfile(); })
  ];
  arcadeProfileUnsubscribe=()=>stops.forEach(stop=>stop());
}

function updateProfileTriggers() {
  document.querySelectorAll("[data-g23f-profile]").forEach(button => {
    button.classList.add("g23f-profile-trigger");
    button.innerHTML = `<span class="g23f-shell-avatar g23f-frame ${escapeHTML(ownArcadeProfile.equippedFrame || "default")}">${avatarInner(currentContext.profile)}</span><span class="g23f-profile-name">${escapeHTML(currentContext.profile.nickname || "Profil")}</span>`;
    button.hidden = false;
  });
  document.querySelectorAll("[data-g23f-admin]").forEach(button => {
    button.classList.add("g23f-admin-trigger");
    button.hidden = !currentContext.admin;
  });
  document.querySelectorAll("[data-g23f-notifications]").forEach(button => {
    button.classList.add("g23f-notification-trigger");
    button.hidden = false;
  });
  const createButton = document.getElementById("g23f-new-notification");
  if (createButton) createButton.hidden = !currentContext.admin;
}

function ensureNotificationTriggers() {
  document.querySelectorAll("[data-g23f-profile]").forEach(profileButton => {
    const parent = profileButton.parentElement;
    if (!parent || parent.querySelector("[data-g23f-notifications]")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.g23fNotifications = "";
    button.setAttribute("aria-label", "Benachrichtigungen öffnen");
    button.innerHTML = '<span aria-hidden="true">🔔</span>';
    const adminButton = parent.querySelector("[data-g23f-admin]");
    parent.insertBefore(button, adminButton || profileButton);
  });
}

function mergedNotifications() {
  const merged = new Map();
  [...notificationSources.all, ...notificationSources.specific].forEach(item => merged.set(item.id, item));
  return [...merged.values()];
}

function notificationCompleted(item) {
  if (item.id === EMAIL_NOTIFICATION_ID) return Boolean(currentContext?.user?.emailVerified);
  return Boolean(notificationStates.get(item.id)?.completed);
}

function visibleNotifications() {
  const values = mergedNotifications()
    .filter(item => !notificationStates.get(item.id)?.deleted)
    .map(item => ({ ...item, completed: notificationCompleted(item) }));

  const emailState = notificationStates.get(EMAIL_NOTIFICATION_ID);
  if (currentContext?.user?.email && !(currentContext.user.emailVerified && emailState?.deleted)) {
    values.push({
      id: EMAIL_NOTIFICATION_ID,
      title: currentContext.user.emailVerified ? "E-Mail bestätigt" : "E-Mail noch bestätigen",
      message: currentContext.user.emailVerified
        ? "Deine E-Mail-Adresse wurde bestätigt. Diese Aufgabe ist automatisch erledigt."
        : `Die Mail wird an ${currentContext.user.email} geschickt. Öffne darin den Bestätigungslink. WICHTIG, prüfe direkt den SPAM-ORDNER, die Mail landet häufig dort.`,
      kind: "automatic",
      sourceType: "email",
      createdAt: null,
      completed: Boolean(currentContext.user.emailVerified),
      emailTask: true
    });
  }

  return values.sort((a, b) => Number(a.completed) - Number(b.completed) ||
    (timestampDate(b.createdAt)?.getTime() || 0) - (timestampDate(a.createdAt)?.getTime() || 0));
}

function updateNotificationCount() {
  if (!currentContext) return;
  const count = visibleNotifications().filter(item => !item.completed).length;
  document.querySelectorAll("[data-g23f-notifications]").forEach(button => {
    let badge = button.querySelector(".g23f-shell-count");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "g23f-shell-count";
      button.append(badge);
    }
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.hidden = count === 0;
    button.setAttribute("aria-label", count === 1
      ? "Benachrichtigungen öffnen, 1 unerledigt"
      : `Benachrichtigungen öffnen, ${count} unerledigt`);
  });
}

function notificationTypeLabel(item) {
  if (item.sourceType === "email") return "E-Mail-Bestätigung";
  if (item.sourceType === "feedback") return "Feedback";
  if (item.sourceType === "report") return "Meldung";
  if (item.sourceType === "coins") return "Münzen";
  return item.kind === "automatic" ? "Automatisch" : "Mitteilung von Elias";
}

function renderNotifications() {
  const container = document.getElementById("g23f-notification-list");
  if (!container || !currentContext) return;
  const list = visibleNotifications();
  container.innerHTML = list.length ? list.map(item => {
    const completed = Boolean(item.completed);
    const id = encodeId(item.id);
    const actions = item.emailTask
      ? (completed
          ? `<button class="g23f-shell-btn danger" type="button" data-delete-notification="${id}">Löschen</button>`
          : '<button class="g23f-shell-btn primary" type="button" data-resend-verification>Mail erneut senden</button><button class="g23f-shell-btn" type="button" data-check-verification>Status prüfen</button>')
      : `${completed ? "" : `<button class="g23f-shell-btn primary" type="button" data-complete-notification="${id}">Als erledigt markieren</button>`}<button class="g23f-shell-btn danger" type="button" data-delete-notification="${id}">Löschen</button>`;
    return `<article class="g23f-notification-card ${completed ? "completed" : ""}">
      <div class="g23f-card-head">
        <div><span class="g23f-notification-type">${escapeHTML(notificationTypeLabel(item))}</span><h3>${escapeHTML(item.title)}</h3></div>
        <span class="g23f-status-pill ${completed ? "done" : "review"}">${completed ? "Erledigt" : "Offen"}</span>
      </div>
      <p>${escapeHTML(item.message)}</p>
      ${item.createdAt ? `<p class="g23f-notification-date">${escapeHTML(formatDate(item.createdAt))}</p>` : ""}
      <div class="g23f-shell-actions">${actions}</div>
    </article>`;
  }).join("") : '<div class="g23f-shell-empty">Keine Benachrichtigungen.</div>';
  updateNotificationCount();
}

async function refreshEmailVerification(showResult = false) {
  if (!currentContext?.user?.email) return;
  try {
    await currentContext.user.reload();
    currentContext.user = auth.currentUser || currentContext.user;
    if (currentContext.user.emailVerified) await currentContext.user.getIdToken(true);
    renderProfile();
    renderNotifications();
    if (showResult) toast(currentContext.user.emailVerified ? "✓ E-Mail ist bestätigt" : "Die E-Mail ist noch nicht bestätigt. Prüfe auch den Spam-Ordner.");
  } catch {
    if (showResult) toast("Der Status konnte gerade nicht geprüft werden.");
  }
}

async function setNotificationState(notificationId, deleted) {
  await setDoc(doc(db, "notificationStates", currentContext.user.uid, "items", notificationId), {
    notificationId,
    completed: true,
    deleted,
    updatedAt: serverTimestamp()
  });
}

async function handleNotificationAction(event) {
  const completeButton = event.target.closest("[data-complete-notification]");
  const deleteButton = event.target.closest("[data-delete-notification]");
  const resendButton = event.target.closest("[data-resend-verification]");
  const checkButton = event.target.closest("[data-check-verification]");
  try {
    if (resendButton) return sendVerification(resendButton);
    if (checkButton) return refreshEmailVerification(true);
    if (completeButton) {
      await setNotificationState(decodeId(completeButton.dataset.completeNotification), false);
      toast("✓ Als erledigt markiert");
      return;
    }
    if (deleteButton) {
      if (!confirm("Diese Benachrichtigung wirklich löschen? Sie verschwindet aus deinem Bereich.")) return;
      await setNotificationState(decodeId(deleteButton.dataset.deleteNotification), true);
      toast("✓ Benachrichtigung gelöscht");
    }
  } catch {
    toast("Die Benachrichtigung konnte nicht geändert werden.");
  }
}

function startNotificationListeners() {
  notificationAllUnsubscribe?.();
  notificationSpecificUnsubscribe?.();
  notificationStateUnsubscribe?.();
  notificationSources = { all: [], specific: [] };
  notificationStates = new Map();
  const uid = currentContext.user.uid;
  const consume = key => snapshot => {
    notificationSources[key] = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    renderNotifications();
  };
  notificationAllUnsubscribe = onSnapshot(
    query(collection(db, "notifications"), where("targetType", "==", "all")),
    consume("all"),
    () => { notificationSources.all = []; renderNotifications(); }
  );
  notificationSpecificUnsubscribe = onSnapshot(
    query(collection(db, "notifications"), where("targetUids", "array-contains", uid)),
    consume("specific"),
    () => { notificationSources.specific = []; renderNotifications(); }
  );
  notificationStateUnsubscribe = onSnapshot(
    collection(db, "notificationStates", uid, "items"),
    snapshot => {
      notificationStates = new Map(snapshot.docs.map(item => [item.id, item.data()]));
      renderNotifications();
    },
    () => { notificationStates = new Map(); renderNotifications(); }
  );
  renderNotifications();
}

function notificationData({ title, message, targetUids, targetNames, kind = "automatic", sourceType = null, sourceId = null }) {
  const specific = targetUids.length > 0;
  return {
    title,
    message,
    kind,
    targetType: specific ? "specific" : "all",
    targetUids,
    targetNames,
    authorUid: currentContext.user.uid,
    authorName: currentContext.profile.nickname,
    sourceType,
    sourceId,
    createdAt: serverTimestamp()
  };
}

function renderNotificationPeople() {
  const container = document.getElementById("g23f-notification-people");
  if (!container) return;
  const search = String(document.getElementById("g23f-notification-people-search")?.value || "").trim().toLocaleLowerCase("de-CH");
  const accounts = adminAccounts.filter(account => !account.blocked && (!search || itemName(account).toLocaleLowerCase("de-CH").includes(search)));
  container.innerHTML = accounts.length ? accounts.map(account => `<label class="g23f-notification-person"><input type="checkbox" value="${escapeHTML(account.uid)}" ${notificationSelectedUids.has(account.uid) ? "checked" : ""}><span>${escapeHTML(account.nickname)}${account.uid === currentContext.user.uid ? " (du)" : ""}</span></label>`).join("") : '<span class="g23f-shell-muted">Keine passende Person gefunden.</span>';
}

function toggleNotificationForm(open) {
  const form = document.getElementById("g23f-notification-form");
  if (!form || !currentContext?.admin) return;
  form.hidden = !open;
  document.getElementById("g23f-notification-error").textContent = "";
  if (!open) {
    form.reset();
    notificationSelectedUids = new Set();
    document.getElementById("g23f-notification-people-wrap").hidden = true;
    renderNotificationPeople();
  }
  if (open) {
    loadAccounts();
    setTimeout(() => document.getElementById("g23f-notification-title")?.focus(), 30);
  }
}

async function submitNotification(event) {
  event.preventDefault();
  if (!currentContext?.admin) return;
  const title = document.getElementById("g23f-notification-title").value.trim();
  const message = document.getElementById("g23f-notification-message").value.trim();
  const target = document.getElementById("g23f-notification-target").value;
  const selectedUids = target === "specific" ? [...notificationSelectedUids] : [];
  const recipients = adminAccounts.filter(account => selectedUids.includes(account.uid));
  const error = document.getElementById("g23f-notification-error");
  if (!title || !message) return void (error.textContent = "Titel und Nachricht dürfen nicht leer sein.");
  if (target === "specific" && recipients.length === 0) return void (error.textContent = "Wähle mindestens eine Person aus.");
  const button = document.getElementById("g23f-notification-submit");
  button.disabled = true;
  try {
    await addDoc(collection(db, "notifications"), notificationData({
      title,
      message,
      targetUids: recipients.map(account => account.uid),
      targetNames: recipients.map(account => account.nickname),
      kind: "manual"
    }));
    event.currentTarget.reset();
    notificationSelectedUids = new Set();
    document.getElementById("g23f-notification-people-wrap").hidden = true;
    toggleNotificationForm(false);
    toast("✓ Benachrichtigung gesendet");
  } catch {
    error.textContent = "Die Benachrichtigung konnte nicht gesendet werden.";
  } finally {
    button.disabled = false;
  }
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

async function sendVerification(buttonOrEvent = null) {
  const button = buttonOrEvent?.currentTarget || buttonOrEvent;
  if (button instanceof HTMLButtonElement) button.disabled = true;
  try {
    await sendEmailVerification(currentContext.user, { url: new URL(currentContext.rootPath, location.href).href });
    toast("✓ Firebase hat den Versand angenommen. Prüfe in einigen Minuten den Posteingang und den SPAM-ORDNER.");
  } catch (error) {
    toast(error?.code === "auth/too-many-requests" ? "Warte kurz, bevor du die Mail nochmals sendest." : "Die Mail konnte nicht gesendet werden.");
  } finally {
    if (button instanceof HTMLButtonElement) button.disabled = false;
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
    const [notes, folders, progress, feedback, entries, tripCards] = await Promise.all([
      getDocs(collection(db, "notes", uid, "items")),
      getDocs(collection(db, "noteFolders", uid, "folders")),
      getDocs(collection(db, "entryProgress", uid, "items")),
      getDocs(query(collection(db, "feedback"), where("authorUid", "==", uid))),
      getDocs(query(collection(db, "eintraege"), where("authorUid", "==", uid))),
      getDocs(query(collection(db, "maturareiseBoard"), where("authorUid", "==", uid)))
    ]);
    const clean = snapshot => snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    download(`g23f-daten-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({
      exportedAt: new Date().toISOString(), profile: currentContext.profile,
      notes: clean(notes), folders: clean(folders), completedEntries: clean(progress),
      feedback: clean(feedback), ownTimetableEntries: clean(entries),
      ownMaturareiseCards: clean(tripCards)
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
    notificationAllUnsubscribe?.();
    notificationSpecificUnsubscribe?.();
    notificationStateUnsubscribe?.();
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
    renderNotificationPeople();
  } catch {
    adminAccounts = [];
    renderNotificationPeople();
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
  if (adminTab === "coins") {
    container.innerHTML = `<div class="g23f-coin-admin-intro"><h3>Münzen vergeben</h3><p class="g23f-shell-muted">Du entscheidest selbst, wie viele Münzen eine schulische Hilfe wert ist. Null Münzen speichert nichts.</p></div>${adminAccounts.filter(account => account.uid !== currentContext.user.uid).map(account => `<article class="g23f-admin-card g23f-coin-row"><div><strong>${escapeHTML(account.nickname)}</strong><small>Persönliche Belohnung</small></div><input type="text" maxlength="120" placeholder="Grund, z. B. Eintrag ergänzt" data-coin-reason="${encodeId(account.uid)}"><div class="g23f-coin-buttons">${[1,3,5,10].map(amount => `<button class="g23f-shell-btn" type="button" data-award-coins="${encodeId(account.uid)}" data-amount="${amount}">＋${amount}</button>`).join("")}<input class="g23f-custom-coins" type="number" min="1" max="100" value="1" aria-label="Eigener Münzbetrag" data-custom-coins="${encodeId(account.uid)}"><button class="g23f-shell-btn" type="button" data-award-coins="${encodeId(account.uid)}" data-amount="custom">Eigene</button></div></article>`).join("") || '<div class="g23f-shell-empty">Konten werden geladen …</div>'}`;
    return;
  }
  container.innerHTML = adminAccounts.length ? adminAccounts.map(account => `<article class="g23f-admin-card g23f-account-row"><div class="g23f-account-name"><strong>${escapeHTML(account.nickname)}</strong>${account.blocked ? '<span class="g23f-status-pill">Gesperrt</span>' : ""}</div>${account.uid === currentContext.user.uid ? '<span class="g23f-shell-muted">Du</span>' : `<button class="g23f-shell-btn ${account.blocked ? "" : "danger"}" type="button" data-toggle-account="${encodeId(account.uid)}" data-blocked="${account.blocked}">${account.blocked ? "Entsperren" : "Sperren"}</button>`}</article>`).join("") : '<div class="g23f-shell-empty">Konten konnten nicht geladen werden.</div>';
}

async function handleAdminAction(event) {
  const awardButton = event.target.closest("[data-award-coins]");
  if (awardButton) {
    const uid = decodeId(awardButton.dataset.awardCoins);
    const amount = awardButton.dataset.amount === "custom" ? Number(document.querySelector(`[data-custom-coins="${encodeId(uid)}"]`)?.value) : Number(awardButton.dataset.amount);
    if (!Number.isInteger(amount) || amount < 1 || amount > 100) { toast("Wähle 1 bis 100 Münzen."); return; }
    const account = adminAccounts.find(item => item.uid === uid);
    const reasonInput = document.querySelector(`[data-coin-reason="${encodeId(uid)}"]`);
    const reason = reasonInput?.value.trim() || "Hilfreicher Beitrag zur Klassen-App";
    try {
      const walletRef = doc(db,"coinWallets",uid), txRef = doc(collection(db,"coinTransactions"));
      await runTransaction(db, async transaction => {
        const walletSnap = await transaction.get(walletRef);
        const wallet = walletSnap.data() || { uid, balance:0, earned:0, spent:0, awardCount:0 };
        transaction.set(walletRef,{...wallet,balance:(wallet.balance||0)+amount,earned:(wallet.earned||0)+amount,awardCount:(wallet.awardCount||0)+1,updatedAt:serverTimestamp()});
        transaction.set(txRef,{uid,nickname:account?.nickname||"Profil",amount,type:"award",reason,sourceType:"school",sourceId:txRef.id,createdAt:serverTimestamp(),createdByUid:currentContext.user.uid});
      });
      await addDoc(collection(db,"notifications"), notificationData({title:`${amount} Münzen erhalten`,message:`${reason}: Du hast ${amount} Münzen erhalten.`,targetUids:[uid],targetNames:[account?.nickname||"Profil"],sourceType:"coins",sourceId:txRef.id}));
      if (reasonInput) reasonInput.value="";
      toast(`✓ ${amount} Münzen an ${account?.nickname || "das Konto"} vergeben`);
    } catch (error) { console.error(error); toast("Die Münzen konnten nicht vergeben werden."); }
    return;
  }
  const status = event.target.closest("[data-feedback-status]");
  if (status) {
    if (event.type !== "change") return;
    try {
      const feedbackId = decodeId(status.dataset.feedbackStatus);
      const feedback = adminFeedback.find(item => item.id === feedbackId);
      if (!feedback || feedback.status === status.value) return;
      const batch = writeBatch(db);
      batch.update(doc(db, "feedback", feedbackId), {
        status: status.value,
        updatedAt: serverTimestamp(),
        updatedByUid: currentContext.user.uid
      });
      const preview = feedback.message.length > 70 ? `${feedback.message.slice(0, 67)}…` : feedback.message;
      batch.set(doc(collection(db, "notifications")), notificationData({
        title: "Feedback aktualisiert",
        message: `Deine Rückmeldung «${preview}» hat jetzt den Status «${STATUS_LABELS[status.value]}».`,
        targetUids: [feedback.authorUid],
        targetNames: [feedback.authorName],
        sourceType: "feedback",
        sourceId: feedbackId
      }));
      await batch.commit();
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
      const reportId = decodeId(resolveReportButton.dataset.resolveReport);
      const report = adminReports.find(item => item.id === reportId);
      if (!report) return;
      const batch = writeBatch(db);
      batch.update(doc(db, "reports", reportId), { status: "resolved", resolvedAt: serverTimestamp(), resolvedByUid: currentContext.user.uid });
      batch.set(doc(collection(db, "notifications")), notificationData({
        title: "Meldung bearbeitet",
        message: "Deine Meldung wurde geprüft und als erledigt markiert.",
        targetUids: [report.reporterUid],
        targetNames: [report.reporterName],
        sourceType: "report",
        sourceId: reportId
      }));
      await batch.commit();
    } else if (deleteEntryButton && confirm("Diesen gemeldeten Eintrag wirklich löschen? Der geschützte Inhalt wird nicht geöffnet.")) {
      const report = adminReports.find(item => item.id === decodeId(deleteEntryButton.dataset.deleteReportedEntry));
      if (report) {
        const batch = writeBatch(db);
        batch.delete(doc(db, "eintraege", report.targetId));
        batch.update(doc(db, "reports", report.id), { status: "resolved", resolvedAt: serverTimestamp(), resolvedByUid: currentContext.user.uid });
        batch.set(doc(collection(db, "notifications")), notificationData({
          title: "Gemeldeter Eintrag entfernt",
          message: "Der von dir gemeldete Stundenplaneintrag wurde geprüft und entfernt.",
          targetUids: [report.reporterUid],
          targetNames: [report.reporterName],
          sourceType: "report",
          sourceId: report.id
        }));
        await batch.commit();
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
  notificationAllUnsubscribe?.();
  notificationSpecificUnsubscribe?.();
  notificationStateUnsubscribe?.();
  arcadeProfileUnsubscribe?.();
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

export function mountGlobalShell({ user, profile, rootPath = "./", pageLabel = "G23f-Insider", onProfileUpdated = null }) {
  currentContext = { user, profile, rootPath, pageLabel, admin: isAdminUser(user), onProfileUpdated };
  injectShell();
  ensureNotificationTriggers();
  updateProfileTriggers();
  renderProfile();
  startArcadeProfile();

  document.querySelectorAll("[data-g23f-profile]").forEach(button => button.addEventListener("click", () => { renderProfile(); setModal("g23f-profile-modal", true); }));
  document.querySelectorAll("[data-g23f-notifications]").forEach(button => button.addEventListener("click", () => {
    setModal("g23f-notifications-modal", true);
    renderNotifications();
    refreshEmailVerification();
  }));
  document.querySelectorAll("[data-g23f-admin]").forEach(button => button.addEventListener("click", () => { adminTab = "feedback"; setModal("g23f-admin-modal", true); renderAdmin(); loadAccounts(); }));
  document.querySelectorAll("[data-g23f-logout]").forEach(button => button.addEventListener("click", logout));
  document.querySelectorAll("[data-g23f-feedback]").forEach(button => button.addEventListener("click", () => openFeedback()));
  document.querySelectorAll("[data-g23f-close]").forEach(button => button.addEventListener("click", () => setModal(button.dataset.g23fClose, false)));
  document.querySelectorAll(".g23f-shell-modal").forEach(modal => modal.addEventListener("click", event => { if (event.target === modal) setModal(modal.id, false); }));
  document.addEventListener("click", event => {
    const publicTrigger = event.target.closest("[data-g23f-user]");
    if (publicTrigger && !publicTrigger.closest("[data-g23f-profile]")) openPublicProfile(publicTrigger.dataset.g23fUser);
  });
  document.getElementById("g23f-feedback-form").addEventListener("submit", submitFeedback);
  document.getElementById("g23f-admin-tabs").addEventListener("click", event => {
    const button = event.target.closest("[data-admin-tab]");
    if (!button) return;
    adminTab = button.dataset.adminTab;
    renderAdmin();
    if (adminTab === "accounts" || adminTab === "coins") loadAccounts();
  });
  document.getElementById("g23f-admin-content").addEventListener("click", handleAdminAction);
  document.getElementById("g23f-admin-content").addEventListener("change", handleAdminAction);
  document.getElementById("g23f-notification-list").addEventListener("click", handleNotificationAction);
  document.getElementById("g23f-new-notification").addEventListener("click", () => toggleNotificationForm(true));
  document.getElementById("g23f-notification-cancel").addEventListener("click", () => toggleNotificationForm(false));
  document.getElementById("g23f-notification-form").addEventListener("submit", submitNotification);
  document.getElementById("g23f-notification-target").addEventListener("change", event => {
    const specific = event.target.value === "specific";
    document.getElementById("g23f-notification-people-wrap").hidden = !specific;
    if (specific) renderNotificationPeople();
  });
  document.getElementById("g23f-notification-people-search").addEventListener("input", renderNotificationPeople);
  document.getElementById("g23f-notification-people").addEventListener("change", event => {
    const input = event.target.closest('input[type="checkbox"]');
    if (!input) return;
    if (input.checked) notificationSelectedUids.add(input.value);
    else notificationSelectedUids.delete(input.value);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !currentContext?.user?.emailVerified) refreshEmailVerification();
  });

  startNotificationListeners();
  startFeedbackListener();
  startAdminListeners();
  startAccountBlockListener();
  registerServiceWorker();
  return { openFeedback, openProfile: () => setModal("g23f-profile-modal", true), toast };
}
