import { requireClassSession } from "../../shared/session.js";
import { mountGlobalShell } from "../../shared/shell.js";

function escapeHTML(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

const session = await requireClassSession("../../");
if (session) {
  mountGlobalShell({ user: session.user, profile: session.profile, rootPath: "../../", pageLabel: "Biologie" });
  document.getElementById("page-content").hidden = false;
  document.getElementById("loading-layer").hidden = true;
  fetch("themen.json", { cache: "no-store" })
    .then(response => response.json())
    .then(topics => {
      const grid = document.getElementById("topics-grid");
      if (!topics.length) {
        grid.innerHTML = '<div style="color:var(--muted);font-size:.85rem;padding:1rem;">Noch keine Themen verfügbar.</div>';
        return;
      }
      grid.innerHTML = topics.map((topic, index) => `<a href="${escapeHTML(topic.pfad)}" class="topic-card"><div class="topic-card-head"><span class="topic-num">BIO-${String(index + 1).padStart(2, "0")}</span><div class="mode-pills">${topic.theorie ? '<span class="mode-pill t">Theorie</span>' : ""}${topic.karten ? '<span class="mode-pill k">Karten</span>' : ""}${topic.quiz ? '<span class="mode-pill q">Quiz</span>' : ""}</div></div><h3>${escapeHTML(topic.name)}</h3><p>${escapeHTML(topic.beschreibung || "")}</p><span class="open-btn">Lernapp öffnen →</span></a>`).join("");
    })
    .catch(() => {
      document.getElementById("topics-grid").innerHTML = '<div style="color:var(--muted);font-size:.85rem;padding:1rem;">Themen konnten nicht geladen werden.</div>';
    });
}
