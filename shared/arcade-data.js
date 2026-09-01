export const SHOP_ITEMS = [
  { id: "frame-copper", type: "frame", name: "Kupferrahmen", price: 30, preview: "◉" },
  { id: "frame-neon", type: "frame", name: "Neonrahmen", price: 65, preview: "✦" },
  { id: "frame-laurel", type: "frame", name: "Lorbeerrahmen", price: 110, preview: "❧" },
  { id: "frame-diamond", type: "frame", name: "Diamantrahmen", price: 180, preview: "◆" },
  { id: "theme-lake", type: "theme", name: "Bergsee", price: 80, preview: "🏔️" },
  { id: "theme-forest", type: "theme", name: "Wald", price: 100, preview: "🌲" },
  { id: "theme-night", type: "theme", name: "Nacht", price: 120, preview: "🌙" },
  { id: "theme-grid", type: "theme", name: "Arcade Grid", price: 140, preview: "▦" },
  { id: "board-tape", type: "board", name: "Klebeband", price: 40, preview: "📎" },
  { id: "board-notebook", type: "board", name: "Notizbuch", price: 55, preview: "📓" },
  { id: "board-ticket", type: "board", name: "Reiseticket", price: 70, preview: "🎫" },
  { id: "board-polaroid", type: "board", name: "Polaroid", price: 85, preview: "📷" },
  { id: "skin-snake-coral", type: "skin", game: "snake", name: "Coral Snake", price: 35, preview: "🐍" },
  { id: "skin-snake-neon", type: "skin", game: "snake", name: "Neon Snake", price: 65, preview: "⚡" },
  { id: "skin-2048-ocean", type: "skin", game: "2048", name: "Ocean 2048", price: 45, preview: "🌊" },
  { id: "skin-2048-candy", type: "skin", game: "2048", name: "Candy 2048", price: 70, preview: "🍬" },
  { id: "skin-memory-travel", type: "skin", game: "memory", name: "Travel Memory", price: 40, preview: "✈️" },
  { id: "skin-memory-neon", type: "skin", game: "memory", name: "Neon Memory", price: 65, preview: "💡" }
];

export const DEFAULT_ARCADE_PROFILE = {
  ownedItems: [], equippedFrame: "default", equippedTheme: "classic",
  boardDesign: "classic", snakeSkin: "default", tileSkin: "default", memorySkin: "default"
};

export const DEFAULT_SCORES = {
  snakeBest: 0, snakePlays: 0, game2048Best: 0, game2048Tile: 0, game2048Plays: 0,
  memoryBestMs: 0, memoryPlays: 0, reactionBestMs: 0, reactionPlays: 0,
  wordleWins: 0, wordleStreak: 0, wordleBestStreak: 0, dailyWins: 0
};

export const BADGES = [
  { id: "helper", name: "Klassenhelfer", icon: "✍️", field: "awardCount", levels: [1, 5, 15, 30, 60] },
  { id: "collector", name: "Münzsammler", icon: "🪙", field: "earned", levels: [10, 50, 150, 400, 1000] },
  { id: "snake", name: "Snake", icon: "🐍", field: "snakeBest", levels: [5, 12, 25, 50, 90] },
  { id: "2048", name: "2048", icon: "🔢", field: "game2048Tile", levels: [128, 256, 512, 1024, 2048] },
  { id: "memory", name: "Memory", icon: "🧠", field: "memoryPlays", levels: [1, 5, 15, 35, 75] },
  { id: "reaction", name: "Reaktion", icon: "⚡", field: "reactionPlays", levels: [1, 5, 15, 35, 75] },
  { id: "wordle", name: "Wordle", icon: "🔤", field: "wordleWins", levels: [1, 5, 15, 40, 100] },
  { id: "daily", name: "Daily Streak", icon: "☀️", field: "dailyWins", levels: [3, 10, 30, 75, 200] }
];

export const TIER_NAMES = ["Bronze", "Silber", "Gold", "Platin", "Diamant"];

export function shopItem(id) { return SHOP_ITEMS.find(item => item.id === id) || null; }

export function badgeProgress(wallet = {}, scores = {}) {
  const values = { ...scores, ...wallet };
  return BADGES.map(badge => {
    const value = Number(values[badge.field] || 0);
    let tier = -1;
    badge.levels.forEach((limit, index) => { if (value >= limit) tier = index; });
    const next = badge.levels[Math.min(tier + 1, badge.levels.length - 1)];
    return { ...badge, value, tier, tierName: tier >= 0 ? TIER_NAMES[tier] : "Noch nicht verdient", next };
  });
}

export function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function seededIndex(seed, length) {
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return Math.abs(hash >>> 0) % length;
}
