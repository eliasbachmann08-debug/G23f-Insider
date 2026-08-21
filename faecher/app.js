import { requireClassSession } from "../shared/session.js";
import { mountGlobalShell } from "../shared/shell.js";

const subjectsPromise = fetch("faecher.json", { cache: "no-store" }).then(response => {
  if (!response.ok) throw new Error("subject-list");
  return response.json();
});

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function subjectHref(path) {
  return String(path || "").replace(/^faecher\//, "");
}

function subjectColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : "#8b7355";
}

function subjectCard(subject) {
  const topics = Array.isArray(subject.themen) ? subject.themen : [];
  const content = `<div class="subject-top"><span class="subject-icon">${escapeHTML(subject.icon)}</span><span class="subject-tag">${subject.verfuegbar ? "✓ Verfügbar" : "Noch offen"}</span></div>
    <h3>${escapeHTML(subject.name)}</h3>
    <p>${escapeHTML(subject.beschreibung || (subject.verfuegbar ? "Lernmaterial verfügbar." : "Wird hinzugefügt, sobald das Thema behandelt wird."))}</p>
    ${topics.length ? `<div class="subject-pills">${topics.map(topic => `<span>${escapeHTML(topic)}</span>`).join("")}</div>` : ""}`;
  const style = `--card-color:${subjectColor(subject.color)}`;
  return subject.verfuegbar
    ? `<a class="subject-card" href="${escapeHTML(subjectHref(subject.pfad))}" style="${style}">${content}</a>`
    : `<article class="subject-card inactive" style="${style}">${content}</article>`;
}

async function renderSubjects() {
  const grid = document.getElementById("subject-grid");
  const summary = document.getElementById("subject-summary");
  try {
    const subjects = await subjectsPromise;
    const available = subjects.filter(subject => subject.verfuegbar).length;
    summary.textContent = `${available} von ${subjects.length} verfügbar`;
    grid.innerHTML = subjects.length
      ? subjects.map(subjectCard).join("")
      : '<p class="empty-copy">Noch keine Fächer vorhanden.</p>';
  } catch {
    summary.textContent = "Konnte nicht geladen werden";
    grid.innerHTML = '<p class="empty-copy">Die Fächer konnten nicht geladen werden. Lade die Seite nochmals neu.</p>';
  }
}

const session = await requireClassSession("../");
if (session) {
  mountGlobalShell({
    user: session.user,
    profile: session.profile,
    rootPath: "../",
    pageLabel: "Fächer"
  });
  document.getElementById("page-content").hidden = false;
  document.getElementById("site-footer").hidden = false;
  document.getElementById("loading-layer").hidden = true;
  renderSubjects();
}
