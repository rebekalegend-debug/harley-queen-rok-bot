// modules/storage.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use Railway volume if DATA_DIR is set (same as verify)
const BASE_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const CONFIG_PATH = path.join(BASE_DIR, "templeConfig.json");

const DEFAULTS = {
  targetChannelId: process.env.TEMPLE_CHANNEL_ID ?? null,
  pingRoleId: process.env.TEMPLE_PING_ROLE_ID ?? null,

  allowedRoleId: null, // if you use access-role feature

  cycleDays: Number(process.env.TEMPLE_CYCLE_DAYS ?? "7"),
  pingHoursBefore: Number(process.env.TEMPLE_PING_HOURS_BEFORE ?? "24"),
  unshieldedHours: Number(process.env.TEMPLE_UNSHIELDED_HOURS ?? "2"),

  nextShieldDropISO: null
};

// ensure dir exists
try {
  fs.mkdirSync(BASE_DIR, { recursive: true });
} catch (e) {
  console.error("❌ Cannot create BASE_DIR:", BASE_DIR, e);
}

console.log("📦 templeConfig storage:", CONFIG_PATH);

export function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2), "utf8");
      return { ...DEFAULTS };
    }
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed }; // merge defaults
  } catch (e) {
    console.error("[TEMPLE][CONFIG] load error:", e);
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
  } catch (e) {
    console.error("[TEMPLE][CONFIG] save error:", e);
  }
}

