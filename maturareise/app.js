import {
  addDoc, collection, deleteDoc, doc, onSnapshot, serverTimestamp, updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { db } from "../shared/firebase.js";
import { requireClassSession } from "../shared/session.js";
import { mountGlobalShell } from "../shared/shell.js";

const COLORS = new Set(["sand", "yellow", "rose", "blue", "green"]);
const BOARD_WIDTH = 1600;
const BOARD_HEIGHT = 1100;
const CARD_WIDTH = 280;
const MIN_ZOOM = .2;
const MAX_ZOOM = 2;
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
let boardScale = 1;
let pinchGesture = null;
let initialBoardViewPending = true;

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

function setBoardStatus(message, tone = "saved") {
  const status = $("board-save-status");
  status.textContent = message;
  status.classList.remove("pending", "offline", "error");
  if (tone !== "saved") status.classList.add(tone);
}

function clampZoom(value) {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(value) || 1));
}

function boardCenter() {
  const viewport = $("board-viewport");
  return { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
}

function applyBoardScale(value, focalPoint = null) {
  const viewport = $("board-viewport");
  const stage = $("board-stage");
  const board = $("trip-board");
  const previousScale = boardScale;
  const nextScale = clampZoom(value);
  const anchor = focalPoint ? {
    x: (viewport.scrollLeft + focalPoint.x) / previousScale,
    y: (viewport.scrollTop + focalPoint.y) / previousScale
  } : null;

  boardScale = nextScale;
  stage.style.width = `${Math.round(BOARD_WIDTH * boardScale)}px`;
  stage.style.height = `${Math.round(BOARD_HEIGHT * boardScale)}px`;
  board.style.transform = `scale(${boardScale})`;
  $("zoom-value").textContent = `${Math.round(boardScale * 100)} %`;

  if (anchor) {
    viewport.scrollLeft = anchor.x * boardScale - focalPoint.x;
    viewport.scrollTop = anchor.y * boardScale - focalPoint.y;
  }
}

function zoomAtCenter(value) {
  applyBoardScale(value, boardCenter());
}

function fitCards() {
  const viewport = $("board-viewport");
  const elements = [...$("trip-board").querySelectorAll(".trip-card")];
  let minX = 0;
  let minY = 0;
  let maxX = BOARD_WIDTH;
  let maxY = BOARD_HEIGHT;
  let maximumScale = 1;

  if (elements.length) {
    const padding = 60;
    minX = Math.max(0, Math.min(...elements.map(element => Number.parseFloat(element.style.left) || 0)) - padding);
    minY = Math.max(0, Math.min(...elements.map(element => Number.parseFloat(element.style.top) || 0)) - padding);
    maxX = Math.min(BOARD_WIDTH, Math.max(...elements.map(element => (Number.parseFloat(element.style.left) || 0) + element.offsetWidth)) + padding);
    maxY = Math.min(BOARD_HEIGHT, Math.max(...elements.map(element => (Number.parseFloat(element.style.top) || 0) + element.offsetHeight)) + padding);
    maximumScale = 1.25;
  }

  const availableWidth = Math.max(120, viewport.clientWidth - 28);
  const availableHeight = Math.max(160, viewport.clientHeight - 28);
  const scale = clampZoom(Math.min(
    availableWidth / Math.max(1, maxX - minX),
    availableHeight / Math.max(1, maxY - minY),
    maximumScale
  ));
  applyBoardScale(scale);
  requestAnimationFrame(() => {
    viewport.scrollLeft = Math.max(0, minX * scale - 14);
    viewport.scrollTop = Math.max(0, minY * scale - 14);
  });
}

function touchDistance(first, second) {
  return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
}

function touchCenter(first, second) {
  const rect = $("board-viewport").getBoundingClientRect();
  return {
    x: (first.clientX + second.clientX) / 2 - rect.left,
    y: (first.clientY + second.clientY) / 2 - rect.top
  };
}

function beginPinch(event) {
  if (event.touches.length !== 2) return;
  if (drag) {
    drag.element.style.left = `${drag.x}px`;
    drag.element.style.top = `${drag.y}px`;
    drag.element.classList.remove("dragging");
    drag = null;
  }
  const viewport = $("board-viewport");
  const center = touchCenter(event.touches[0], event.touches[1]);
  pinchGesture = {
    distance: Math.max(1, touchDistance(event.touches[0], event.touches[1])),
    scale: boardScale,
    boardX: (viewport.scrollLeft + center.x) / boardScale,
    boardY: (viewport.scrollTop + center.y) / boardScale
  };
  event.preventDefault();
}

function movePinch(event) {
  if (!pinchGesture || event.touches.length !== 2) return;
  event.preventDefault();
  const viewport = $("board-viewport");
  const center = touchCenter(event.touches[0], event.touches[1]);
  const scale = clampZoom(
    pinchGesture.scale * touchDistance(event.touches[0], event.touches[1]) / pinchGesture.distance
  );
  applyBoardScale(scale);
  viewport.scrollLeft = pinchGesture.boardX * scale - center.x;
  viewport.scrollTop = pinchGesture.boardY * scale - center.y;
}

function endPinch(event) {
  if (event.touches.length < 2) pinchGesture = null;
}

function zoomWithWheel(event) {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  const viewport = $("board-viewport");
  const rect = viewport.getBoundingClientRect();
  const focalPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  applyBoardScale(boardScale * Math.exp(-event.deltaY * .01), focalPoint);
}

function canEdit(card) {
  return admin || card?.authorUid === currentUser?.uid;
}

function draftStorageKey() {
  return currentUser ? `g23f-maturareise-draft-${currentUser.uid}` : null;
}

function readNewCardDraft() {
  const key = draftStorageKey();
  if (!key) return null;
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value && typeof value.content === "string" ? value : null;
  } catch {
    return null;
  }
}

function saveNewCardDraft() {
  if (editingId) return;
  const key = draftStorageKey();
  if (!key) return;
  const content = $("card-content").value;
  try {
    if (!content.trim()) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify({
      content,
      color: document.querySelector('input[name="card-color"]:checked')?.value || "sand"
    }));
  } catch {}
}

function clearNewCardDraft() {
  const key = draftStorageKey();
  if (!key) return;
  try { localStorage.removeItem(key); } catch {}
}

function clampPosition(x, y, cardHeight = 170) {
  return {
    x: Math.max(12, Math.min(Number(x) || 12, BOARD_WIDTH - CARD_WIDTH - 12)),
    y: Math.max(12, Math.min(Number(y) || 12, BOARD_HEIGHT - Math.max(170, cardHeight) - 12))
  };
}

function tiltFor(id) {
  const score = [...String(id)].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return ((score % 7) - 3) * .22;
}

function renderCards(state = "ready") {
  const board = $("trip-board");
  board.querySelectorAll(".trip-card").forEach(card => card.remove());
  const empty = $("board-empty");
  empty.hidden = cards.length > 0;
  if (!cards.length) {
    if (state === "loading") {
      $("board-empty-title").textContent = "Beiträge werden geladen …";
      $("board-empty-copy").textContent = "Deine gespeicherten Inhalte erscheinen gleich.";
      $("card-count").textContent = "Beiträge werden geladen …";
    } else if (state === "error") {
      $("board-empty-title").textContent = "Die Beiträge konnten nicht geladen werden.";
      $("board-empty-copy").textContent = "Prüfe deine Verbindung und lade die Seite nochmals.";
      $("card-count").textContent = "Laden nicht möglich";
    } else {
      $("board-empty-title").textContent = "Noch ist das Blatt leer.";
      $("board-empty-copy").textContent = "Füge den ersten Gedanken zur Maturareise hinzu.";
      $("card-count").textContent = "0 Beiträge";
    }
  } else {
    $("card-count").textContent = `${cards.length} ${cards.length === 1 ? "Beitrag" : "Beiträge"}`;
  }

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
    const adjustedPosition = clampPosition(card.x, card.y, article.offsetHeight);
    article.style.left = `${adjustedPosition.x}px`;
    article.style.top = `${adjustedPosition.y}px`;
  });
}

function newCardPosition() {
  const viewport = $("board-viewport");
  return clampPosition(
    (viewport.scrollLeft + viewport.clientWidth / 2) / boardScale - CARD_WIDTH / 2,
    (viewport.scrollTop + viewport.clientHeight / 2) / boardScale - 90
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
  const recoveredDraft = card ? null : readNewCardDraft();
  draftPosition = position ? clampPosition(position.x, position.y) : newCardPosition();
  $("editor-title").textContent = card ? "Beitrag bearbeiten" : "Text hinzufügen";
  $("card-content").value = card?.content || recoveredDraft?.content || "";
  const color = COLORS.has(card?.color)
    ? card.color
    : (COLORS.has(recoveredDraft?.color) ? recoveredDraft.color : "sand");
  document.querySelector(`input[name="card-color"][value="${color}"]`).checked = true;
  $("editor-meta").textContent = card
    ? `Von ${card.authorName || "Unbekannt"}, zuletzt bearbeitet von ${card.editedByName || card.authorName || "Unbekannt"} am ${formatDate(card.updatedAt || card.createdAt)}`
    : (recoveredDraft
      ? "Dein nicht gespeicherter Entwurf wurde auf diesem Gerät wiederhergestellt."
      : "Der Beitrag ist für die ganze Klasse sichtbar. Dein Entwurf wird auf diesem Gerät gesichert.");
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
  const buttonLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Wird gespeichert …";
  setBoardStatus("Änderungen werden gespeichert …", "pending");
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
      clearNewCardDraft();
      toast("✓ Beitrag hinzugefügt");
    }
    setEditorOpen(false);
  } catch {
    $("editor-error").textContent = "Der Beitrag konnte nicht gespeichert werden.";
    setBoardStatus("Speichern nicht möglich", "error");
  } finally {
    button.disabled = false;
    button.textContent = buttonLabel;
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
  const position = clampPosition(card.x, card.y, element.offsetHeight);
  drag = {
    id: card.id,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    x: position.x,
    y: position.y,
    nextX: position.x,
    nextY: position.y,
    height: element.offsetHeight,
    element
  };
  element.classList.add("dragging");
  element.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function moveDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const position = clampPosition(
    drag.x + (event.clientX - drag.startX) / boardScale,
    drag.y + (event.clientY - drag.startY) / boardScale,
    drag.height
  );
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
  setBoardStatus("Position wird gespeichert …", "pending");
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
    setBoardStatus("Position nicht gespeichert", "error");
    renderCards();
  }
}

function startBoardListener() {
  unsubscribe?.();
  unsubscribe = onSnapshot(collection(db, "maturareiseBoard"), { includeMetadataChanges: true }, snapshot => {
    cards = snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
      .sort((a, b) => (timestampDate(a.createdAt)?.getTime() || 0) - (timestampDate(b.createdAt)?.getTime() || 0));
    const stillLoading = snapshot.empty && snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites;
    renderCards(stillLoading ? "loading" : "ready");

    if (snapshot.metadata.hasPendingWrites) {
      setBoardStatus("Änderungen werden gespeichert …", "pending");
    } else if (snapshot.metadata.fromCache) {
      setBoardStatus("Verbindung wird geprüft …", "offline");
    } else {
      setBoardStatus("Alle Beiträge gespeichert");
    }

    if (initialBoardViewPending && (cards.length || !snapshot.metadata.fromCache)) {
      initialBoardViewPending = false;
      requestAnimationFrame(fitCards);
    }
  }, () => {
    renderCards("error");
    setBoardStatus("Laden nicht möglich", "error");
    toast("Die gemeinsame Fläche konnte nicht geladen werden.");
  });
}

function bindEvents() {
  const viewport = $("board-viewport");
  $("add-card-btn").addEventListener("click", () => openEditor());
  $("floating-add-btn").addEventListener("click", () => openEditor());
  $("close-editor-btn").addEventListener("click", () => setEditorOpen(false));
  $("card-editor").addEventListener("click", event => { if (event.target === $("card-editor")) setEditorOpen(false); });
  $("save-card-btn").addEventListener("click", saveCard);
  $("delete-card-btn").addEventListener("click", removeCard);
  $("card-content").addEventListener("input", saveNewCardDraft);
  document.querySelectorAll('input[name="card-color"]').forEach(input => input.addEventListener("change", saveNewCardDraft));
  $("trip-board").addEventListener("dblclick", event => {
    if (event.target.closest(".trip-card")) return;
    const rect = $("trip-board").getBoundingClientRect();
    openEditor(null, {
      x: (event.clientX - rect.left) / boardScale - CARD_WIDTH / 2,
      y: (event.clientY - rect.top) / boardScale - 30
    });
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
  $("zoom-out-btn").addEventListener("click", () => zoomAtCenter(boardScale / 1.2));
  $("zoom-in-btn").addEventListener("click", () => zoomAtCenter(boardScale * 1.2));
  $("zoom-reset-btn").addEventListener("click", () => zoomAtCenter(1));
  $("zoom-fit-btn").addEventListener("click", fitCards);
  viewport.addEventListener("touchstart", beginPinch, { passive: false });
  viewport.addEventListener("touchmove", movePinch, { passive: false });
  viewport.addEventListener("touchend", endPinch);
  viewport.addEventListener("touchcancel", endPinch);
  viewport.addEventListener("wheel", zoomWithWheel, { passive: false });
  viewport.addEventListener("keydown", event => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomAtCenter(boardScale * 1.2);
    } else if (event.key === "-") {
      event.preventDefault();
      zoomAtCenter(boardScale / 1.2);
    } else if (event.key === "0") {
      event.preventDefault();
      zoomAtCenter(1);
    }
  });
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
  $("header-account").hidden = false;
  $("page-content").hidden = false;
  $("site-footer").hidden = false;
  $("floating-add-btn").hidden = false;
  $("loading-layer").hidden = true;
  applyBoardScale(1);
  bindEvents();
  startBoardListener();
}
