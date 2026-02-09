// modules/storageRuins.js
import fs from "node:fs";
import path from "node:path";

const BASE_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");

const DEFAULTS = {
  channelId: null,
  pingRoleId: null,
  ruins: [],   // ISO strings
  altar: [],   // ISO strings
  notified: {} // iso -> true
};

fs.mkdirSync(BASE_DIR, { recursive: true });

function file(guildId) {
  return path.join(BASE_DIR, `ruins_${guildId}.json`);
}

export function loadRuins(guildId) {
  const f = file(guildId);
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, JSON.stringify(DEFAULTS, null, 2));
    return structuredClone(DEFAULTS);
  }
  return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(f, "utf8")) };
}

export function saveRuins(guildId, cfg) {
  fs.writeFileSync(file(guildId), JSON.stringify(cfg, null, 2));
}
