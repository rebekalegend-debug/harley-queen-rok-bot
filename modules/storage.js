// modules/storage.js
import fs from "node:fs";
import path from "node:path";

const BASE_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");

/* ================= FS SETUP ================= */

try {
  fs.mkdirSync(BASE_DIR, { recursive: true });
} catch (e) {
  console.error("❌ Cannot create BASE_DIR:", BASE_DIR, e);
}

/* ================= HELPERS ================= */

function getPath(prefix, guildId) {
  return path.join(BASE_DIR, `${prefix}_${guildId}.json`);
}

/* ================= GENERIC STORAGE ================= */

export function loadConfig(prefix, guildId, defaults = {}) {
  const FILE = getPath(prefix, guildId);

  try {
    if (!fs.existsSync(FILE)) {
      fs.writeFileSync(FILE, JSON.stringify(defaults, null, 2), "utf8");
      return { ...defaults };
    }

    const raw = fs.readFileSync(FILE, "utf8");
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed };
  } catch (e) {
    console.error(`[${prefix.toUpperCase()}][CONFIG] load error:`, e);
    return { ...defaults };
  }
}

export function saveConfig(prefix, guildId, cfg) {
  const FILE = getPath(prefix, guildId);

  try {
    fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2), "utf8");
  } catch (e) {
    console.error(`[${prefix.toUpperCase()}][CONFIG] save error:`, e);
  }
}
