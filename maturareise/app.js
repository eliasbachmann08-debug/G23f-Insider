import {
  addDoc, collection, deleteDoc, doc, onSnapshot, serverTimestamp, updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { db } from "../shared/firebase.js";
import { requireClassSession } from "../shared/session.js";
import { mountGlobalShell } from "../shared/shell.js";

const COLORS = new Set(["sand", "yellow", "rose", "blue", "green"]);
const CARD_WIDTH = 280;
const $ = id => document.getElementById(id);

let currentUser = null;
let currentProfile = null;
let admin = false;
let cards = [];
let editingId = null;
let draftPosition = { x: 80, y: 80 };
let unsubscribe = null;
let drag = null;
let toastTimer = null;

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function timestampDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (value.seconds) return new Date(value.seconds * 1000);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = timestampDate(value);
  return date ? date.toLocaleString("de-CH", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "gerade eben";
}

function toast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").classList.add("show");
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 3000);
}

function canEdit(card) {
  return admin || card?.authorUid === currentUser?.uid;
}

function clampPosition(x, y) {
  const board = $("trip-board");
  return {
    x: Math.max(12, Math.min(Number(x) || 12, board.clientWidth - CARD_WIDTH - 12)),
    y: Math.max(12, Math.min(Number(y) || 12, board.clientHeight - 170))
  };
}

function tiltFor(id) {
  const score = [...String(id)].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return ((score % 7) - 3) * .22;
}

function renderCards() {
  const board = $("trip-board");
  board.querySelectorAll(".trip-card").forEach(card => card.remove());
  $("board-empty").hidden = cards.length > 0;
  $("card-count").textContent = `${cards.length} ${cards.length === 1 ? "Beitrag" : "Beiträge"}`;

  cards.forEach((card, index) => {
    const position = clampPosition(card.x, card.y);
    const editable = canEdit(card);
    const article = document.createElement("article");
    article.className = `trip-card${editable ? " owned" : ""}`;
    article.dataset.cardId = card.id;
    article.dataset.color = COLORS.has(card.color) ? card.color : "sand";
    article.style.left = `${position.x}px`;
    article.style.top = `${position.y}px`;
    article.style.zIndex = String(index + 1);
    article.style.setProperty("--tilt", `${tiltFor(card.id)}deg`);
    article.innerHTML = `
      <div class="trip-card-handle"><span>${editable ? "↕ Verschieben" : "Beitrag"}</span><span>${escapeHTML(card.authorName || "Unbekannt")}</span></div>
      <button class="trip-card-open" type="button" ${editable ? "" : "tabindex=\"-1\""}>${escapeHTML(card.content)}</button>
      <small class="trip-card-meta">Von ${escapeHTML(card.authorName || "Unbekannt")} · zuletzt bearbeitet von ${escapeHTML(card.editedByName || card.authorName || "Unbekannt")} · ${escapeHTML(formatDate(card.updatedAt || card.createdAt))}</small>`;
    board.append(article);
  });
}

function newCardPosition() {
  const viewport = $("board-viewport");
  return clampPosition(
    viewport.scrollLeft + viewport.clientWidth / 2 - CARD_WIDTH / 2,
    viewport.scrollTop + viewport.clientHeight / 2 - 90
  );
}

function setEditorOpen(open) {
  $("card-editor").hidden = !open;
  document.body.style.overflow = open ? "hidden" : "";
  if (open) setTimeout(() => $("card-content").focus(), 30);
}

function openEditor(card = null, position = null) {
  if (card && !canEdit(card)) return;
  editingId = card?.id || null;
  draftPosition = position ? clampPosition(position.x, position.y) : newCardPosition();
  $("editor-title").textContent = card ? "Beitrag bearbeiten" : "Text hinzufügen";
  $("card-content").value = card?.content || "";
  const color = COLORS.has(card?.color) ? card.color : "sand";
  document.querySelector(`input[name="card-color"][value="${color}"]`).checked = true;
  $("editor-meta").textContent = card
    ? `Von ${card.authorName || "Unbekannt"}, zuletzt bearbeitet von ${card.editedByName || card.authorName || "Unbekannt"} am ${formatDate(card.updatedAt || card.createdAt)}`
    : "Der Beitrag ist für die ganze Klasse sichtbar.";
  $("editor-error").textContent = "";
  $("delete-card-btn").hidden = !card;
  setEditorOpen(true);
}

async function saveCard() {
  const content = $("card-content").value.trim();
  const color = document.querySelector('input[name="card-color"]:checked')?.value || "sand";
  if (!content) {
    $("editor-error").textContent = "Schreib zuerst etwas in den Beitrag.";
    return;
  }
  const button = $("save-card-btn");
  button.disabled = true;
  try {
    if (editingId) {
      const card = cards.find(item => item.id === editingId);
      if (!card || !canEdit(card)) throw new Error("not-allowed");
      await updateDoc(doc(db, "maturareiseBoard", editingId), {
        content,
        color,
        updatedAt: serverTimestamp(),
        editedByUid: currentUser.uid,
        editedByName: currentProfile.nickname
      });
      toast("✓ Beitrag gespeichert");
    } else {
      await addDoc(collection(db, "maturareiseBoard"), {
        authorUid: currentUser.uid,
        authorName: currentProfile.nickname,
        content,
        color,
        x: Math.round(draftPosition.x),
        y: Math.round(draftPosition.y),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        editedByUid: currentUser.uid,
        editedByName: currentProfile.nickname
      });
      toast("✓ Beitrag hinzugefügt");
    }
    setEditorOpen(false);
  } catch {
    $("editor-error").textContent = "Der Beitrag konnte nicht gespeichert werden.";
  } finally {
    button.disabled = false;
  }
}

async function removeCard() {
  const card = cards.find(item => item.id === editingId);
  if (!card || !canEdit(card) || !confirm("Diesen Beitrag wirklich löschen?")) return;
  const button = $("delete-card-btn");
  button.disabled = true;
  try {
    await deleteDoc(doc(db, "maturareiseBoard", card.id));
    setEditorOpen(false);
    toast("✓ Beitrag gelöscht");
  } catch {
    $("editor-error").textContent = "Der Beitrag konnte nicht gelöscht werden.";
  } finally {
    button.disabled = false;
  }
}

function beginDrag(event) {
  const handle = event.target.closest(".trip-card-handle");
  if (!handle || event.button !== 0) return;
  const element = handle.closest(".trip-card");
  const card = cards.find(item => item.id === element?.dataset.cardId);
  if (!element || !card || !canEdit(card)) return;
  const position = clampPosition(card.x, card.y);
  drag = {
    id: card.id,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    x: position.x,
    y: position.y,
    nextX: position.x,
    nextY: position.y,
    element
  };
  element.classList.add("dragging");
  element.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function moveDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const position = clampPosition(drag.x + event.clientX - drag.startX, drag.y + event.clientY - drag.startY);
  drag.nextX = position.x;
  drag.nextY = position.y;
  drag.element.style.left = `${position.x}px`;
  drag.element.style.top = `${position.y}px`;
  event.preventDefault();
}

async function endDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const finished = drag;
  drag = null;
  finished.element.classList.remove("dragging");
  const moved = Math.abs(finished.nextX - finished.x) > 1 || Math.abs(finished.nextY - finished.y) > 1;
  if (!moved) return;
  try {
    await updateDoc(doc(db, "maturareiseBoard", finished.id), {
      x: Math.round(finished.nextX),
      y: Math.round(finished.nextY),
      updatedAt: serverTimestamp(),
      editedByUid: currentUser.uid,
      editedByName: currentProfile.nickname
    });
  } catch {
    toast("Die Position konnte nicht gespeichert werden.");
    renderCards();
  }
}

function startBoardListener() {
  unsubscribe?.();
  unsubscribe = onSnapshot(collection(db, "maturareiseBoard"), snapshot => {
    cards = snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
      .sort((a, b) => (timestampDate(a.createdAt)?.getTime() || 0) - (timestampDate(b.createdAt)?.getTime() || 0));
    renderCards();
  }, () => toast("Die gemeinsame Fläche konnte nicht geladen werden."));
}

function bindEvents() {
  $("add-card-btn").addEventListener("click", () => openEditor());
  $("floating-add-btn").addEventListener("click", () => openEditor());
  $("close-editor-btn").addEventListener("click", () => setEditorOpen(false));
  $("card-editor").addEventListener("click", event => { if (event.target === $("card-editor")) setEditorOpen(false); });
  $("save-card-btn").addEventListener("click", saveCard);
  $("delete-card-btn").addEventListener("click", removeCard);
  $("trip-board").addEventListener("dblclick", event => {
    if (event.target.closest(".trip-card")) return;
    const rect = $("trip-board").getBoundingClientRect();
    openEditor(null, { x: event.clientX - rect.left - CARD_WIDTH / 2, y: event.clientY - rect.top - 30 });
  });
  $("trip-board").addEventListener("click", event => {
    const button = event.target.closest(".trip-card-open");
    if (!button) return;
    const card = cards.find(item => item.id === button.closest(".trip-card")?.dataset.cardId);
    if (card && canEdit(card)) openEditor(card);
  });
  $("trip-board").addEventListener("pointerdown", beginDrag);
  document.addEventListener("pointermove", moveDrag, { passive: false });
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);
}

const session = await requireClassSession("../");
if (session) {
  currentUser = session.user;
  currentProfile = session.profile;
  admin = session.admin;
  mountGlobalShell({
    user: session.user,
    profile: session.profile,
    rootPath: "../",
    pageLabel: "Maturareise",
    onProfileUpdated: profile => { currentProfile = profile; }
  });
  bindEvents();
  startBoardListener();
  $("header-account").hidden = false;
  $("page-content").hidden = false;
  $("site-footer").hidden = false;
  $("floating-add-btn").hidden = false;
  $("loading-layer").hidden = true;
}
