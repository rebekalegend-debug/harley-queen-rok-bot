// modules/verify.js
console.log("🔥 VERIFY MODULE BUILD 2026-02-13 IMAGE OCR + ICON CHECK");

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

import {
  Events,
  PermissionFlagsBits
} from "discord.js";

import { parse } from "csv-parse/sync";
import { getGuild, setGuild } from "./guildConfig.js";

import Jimp from "jimp";
import { createWorker } from "tesseract.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HARLEY_QUINN_USER_ID = "297057337590546434";

// CSV must be in SAME folder as this verify.js
// headers: Name,ID
const DATA_FILE = path.join(__dirname, "DATA.csv");

// icon templates must be in same folder as verify.js
const ICON_FILES = ["1.png", "2.png", "3.png"].map((f) => path.join(__dirname, f));

// runtime memory: userId -> screenshot verified done?
const verifiedDone = new Map();

// ===== Keep Railway container alive (Web Service healthcheck) =====
let httpStarted = false;
function startHttpKeepAliveOnce() {
  if (httpStarted) return;
  httpStarted = true;

  const PORT = process.env.PORT || 8080;
  http
    .createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
    })
    .listen(PORT, () => console.log(`🌐 HTTP server listening on ${PORT}`));
}

function isAdminPerm(member) {
  return member?.permissions?.has?.(PermissionFlagsBits.Administrator);
}
function isOwner(guild, userId) {
  return guild?.ownerId === userId;
}

// -------- helpers --------
function sanitizeName(raw) {
  const name = String(raw ?? "").trim();
  if (name.length < 2 || name.length > 32) return null;
  const ok = /^[\p{L}\p{N} ._\-'\[\]#]+$/u.test(name);
  return ok ? name : null;
}

function readCsvRecords() {
  if (!fs.existsSync(DATA_FILE)) throw new Error(`DATA.csv not found at ${DATA_FILE}`);
  const csvText = fs.readFileSync(DATA_FILE, "utf8");
  return parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });
}

function lookupNameByGovernorId(governorId) {
  const records = readCsvRecords();
  const target = String(governorId).trim();
  for (const row of records) {
    const id = String(row.ID ?? "").trim();
    const name = String(row.Name ?? "").trim();
    if (id === target) return name || null;
  }
  return null;
}

function isImageAttachment(att) {
  return (
    att?.contentType?.startsWith("image/") ||
    /\.(png|jpg|jpeg|webp)$/i.test(att?.name || "")
  );
}

async function downloadToBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image (${res.status})`);
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

/* ================= OCR (tesseract.js) ================= */

let ocrWorker = null;
async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  const w = await createWorker();
  await w.loadLanguage("eng");
  await w.initialize("eng");
  // help OCR a bit: favor digits/letters and colon/paren
  await w.setParameters({
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789():#- ",
  });
  ocrWorker = w;
  console.log("✅ [VERIFY] OCR worker ready");
  return ocrWorker;
}

function normalizeText(s) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractGovernorIdFromText(text) {
  const t = String(text ?? "");
  // common patterns: "Governor (ID: 58532591)" or "(ID:58532591)" etc
  const m = t.match(/ID\s*[:#]\s*([0-9]{6,20})/i);
  if (m) return m[1];
  const m2 = t.match(/\(ID\s*[:#]?\s*([0-9]{6,20})\)/i);
  if (m2) return m2[1];
  return null;
}

/* ================= ICON MATCH (Jimp) =================
   We do a coarse template search on a downscaled copy to keep CPU acceptable.
   - This is not OpenCV-level, but works well when UI is consistent.
*/

const ICON_MATCH_MAX_DIFF = 0.18; // lower = stricter (0.12..0.22 typical)
const ICON_SCAN_STEP = 8;         // smaller = slower but more accurate
const DOWNSCALE_WIDTH = 900;      // reduce CPU

let iconTemplates = null;

async function loadIconTemplatesOnce() {
  if (iconTemplates) return iconTemplates;

  const loaded = [];
  for (const p of ICON_FILES) {
    if (!fs.existsSync(p)) {
      console.warn(`[VERIFY] Missing icon template: ${p}`);
      continue;
    }
    const img = await Jimp.read(p);
    loaded.push({
      path: p,
      img,
      w: img.bitmap.width,
      h: img.bitmap.height,
    });
  }

  if (!loaded.length) {
    console.warn("[VERIFY] No icon templates loaded (1.png/2.png/3.png). Icon check will always fail.");
  } else {
    console.log(`[VERIFY] Loaded ${loaded.length} icon templates.`);
  }

  iconTemplates = loaded;
  return iconTemplates;
}

// Return true if ANY icon template is found in screenshot
async function containsAnyIcon(fullImgJimp) {
  const templates = await loadIconTemplatesOnce();
  if (!templates.length) return false;

  // downscale screenshot for faster scan
  const img = fullImgJimp.clone();
  if (img.bitmap.width > DOWNSCALE_WIDTH) img.resize(DOWNSCALE_WIDTH, Jimp.AUTO);

  // also downscale templates proportionally if screenshot was downscaled
  // We'll compute scale ratio using width.
  const scale = img.bitmap.width / fullImgJimp.bitmap.width;

  // scan each template
  for (const t of templates) {
    const temp = t.img.clone();
    if (scale !== 1) temp.resize(Math.max(6, Math.round(t.w * scale)), Math.max(6, Math.round(t.h * scale)));

    // skip impossible
    if (temp.bitmap.width >= img.bitmap.width || temp.bitmap.height >= img.bitmap.height) continue;

    const maxX = img.bitmap.width - temp.bitmap.width;
    const maxY = img.bitmap.height - temp.bitmap.height;

    // coarse scan
    for (let y = 0; y <= maxY; y += ICON_SCAN_STEP) {
      for (let x = 0; x <= maxX; x += ICON_SCAN_STEP) {
        const crop = img.clone().crop(x, y, temp.bitmap.width, temp.bitmap.height);
        const diff = Jimp.diff(crop, temp).percent; // 0 = identical
        if (diff <= ICON_MATCH_MAX_DIFF) {
          return true;
        }
      }
    }
  }

  return false;
}

/* ================= MAIN VERIFY PIPELINE ================= */

async function analyzeAndVerifyFromScreenshot({ guild, member, channel, verifyCfg, attachment }) {
  // download attachment
  const buf = await downloadToBuffer(attachment.url);

  // load as image
  const img = await Jimp.read(buf);

  // OCR full image (simple and robust; slower but ok for single upload)
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(buf);
  const ocrText = normalizeText(data?.text ?? "");

  // detect type:
  // if contains "GOVERNOR PROFILE" => mobile-type requiring icon check (per your instruction)
  const isMobileType = /GOVERNOR\s+PROFILE/i.test(ocrText);

  // if mobile type, enforce icon presence (any of 1.png/2.png/3.png)
  if (isMobileType) {
    const ok = await containsAnyIcon(img);
    if (!ok) {
      return { ok: false, reason: "MISSING_ICONS" };
    }
  }

  // extract ID
  const govId = extractGovernorIdFromText(ocrText);
  if (!govId) return { ok: false, reason: "NO_ID" };

  // lookup name
  let nameFromDb = null;
  try {
    nameFromDb = lookupNameByGovernorId(govId);
  } catch (err) {
    console.error("CSV error:", err);
    return { ok: false, reason: "CSV_ERROR" };
  }
  if (!nameFromDb) return { ok: false, reason: "ID_NOT_FOUND", govId };

  const cleanName = sanitizeName(nameFromDb);
  if (!cleanName) return { ok: false, reason: "BAD_NAME" };

  // permission check
  const me = await guild.members.fetchMe();
  if (
    !me.permissions.has(PermissionFlagsBits.ManageNicknames) ||
    !me.permissions.has(PermissionFlagsBits.ManageRoles)
  ) {
    return { ok: false, reason: "BOT_MISSING_PERMS" };
  }

  // apply
  await member.setNickname(cleanName).catch(() => {});
  await member.roles.add(verifyCfg.roleId).catch(() => {});

  return { ok: true, govId, cleanName, isMobileType };
}

/* ===================== EXPORT: setupVerify(client) ===================== */

export function setupVerify(client) {
  startHttpKeepAliveOnce();

  client.once(Events.ClientReady, () => {
    console.log(`✅ [VERIFY] Logged in as ${client.user.tag}`);
  });

  // MEMBER JOIN
  client.on(Events.GuildMemberAdd, async (member) => {
    const cfg = getGuild(member.guild.id).verify;
    if (!cfg?.channelId) return;

    const channel = await member.guild.channels.fetch(cfg.channelId).catch(() => null);
    if (!channel) return;

    verifiedDone.delete(member.id);

    await channel.send(
`Welcome ${member}💗!

Please upload a screenshot of your **Rise of Kingdoms profile** here.
📸👉🪪.`
    );
  });

  // MESSAGE CREATE
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    // DM auto reply
    if (!message.guild) {
      if (message.author.id === HARLEY_QUINN_USER_ID) return;
      return message.reply(
        `Hi! I’m just a bot 🤖\n\nPlease contact <@${HARLEY_QUINN_USER_ID}> for help.`
      ).catch(() => {});
    }

    const guildId = message.guild.id;
    const verifyCfg = getGuild(guildId).verify || {};

    // VERIFY ADMIN COMMANDS
    if (message.content.startsWith("!verify")) {
      const args = message.content.split(/\s+/);
      const sub = (args[1] || "help").toLowerCase();

      // Owner or Administrator only
      if (!isOwner(message.guild, message.author.id) && !isAdminPerm(message.member)) {
        return message.reply("❌ You don’t have permission to use verify admin commands.");
      }

      if (sub === "help") {
        return message.reply(
          "**Verify Commands**\n\n" +
          "`!verify set channel #channel` – set verify channel\n" +
          "`!verify set role @role` – role given after verify\n" +
          "`!verify status` – show current setup\n" +
          "`!verify dump` – show saved JSON for this server\n" +
          "`!verify testsave` – write a test value and show JSON"
        );
      }

      if (sub === "status") {
        return message.reply(
          "**Verify Status**\n" +
          `• Channel: ${verifyCfg.channelId ? `<#${verifyCfg.channelId}>` : "not set"}\n` +
          `• Role: ${verifyCfg.roleId ? `<@&${verifyCfg.roleId}>` : "not set"}`
        );
      }

      if (sub === "dump") {
        const cfg = getGuild(guildId);
        return message.reply("```json\n" + JSON.stringify(cfg, null, 2) + "\n```");
      }

      if (sub === "testsave") {
        setGuild(guildId, { _test: { savedAt: new Date().toISOString() } });
        const cfg = getGuild(guildId);
        return message.reply("Saved. Current config:\n```json\n" + JSON.stringify(cfg, null, 2) + "\n```");
      }

      if (sub === "set") {
        if (args[2] === "channel") {
          const ch = message.mentions.channels.first();
          if (!ch) return message.reply("❌ Use: `!verify set channel #channel`");
          setGuild(guildId, { verify: { channelId: ch.id } });
          return message.reply(`✅ Verify channel set to ${ch}`);
        }

        if (args[2] === "role") {
          const role = message.mentions.roles.first();
          if (!role) return message.reply("❌ Use: `!verify set role @role`");
          setGuild(guildId, { verify: { roleId: role.id } });
          return message.reply(`✅ Verify role set to ${role.name}`);
        }
      }

      return message.reply("❌ Unknown command. Use `!verify help`");
    }

    // VERIFY CHANNEL ONLY
    if (!verifyCfg.channelId || message.channel.id !== verifyCfg.channelId) return;

    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member) return message.delete().catch(() => {});

    // already verified -> delete anything they post
    if (verifyCfg.roleId && member.roles.cache.has(verifyCfg.roleId)) {
      return message.delete().catch(() => {});
    }

    // allow only image; delete other content
    const imgAtt = message.attachments.find(isImageAttachment);
    if (!imgAtt) {
      return message.delete().catch(() => {});
    }

    // if we already verified them, block further posts
    if (verifiedDone.get(member.id)) {
      return message.delete().catch(() => {});
    }

    // run verification from screenshot
    try {
      // basic guard: must be configured
      if (!verifyCfg.roleId) {
        await message.reply("❌ Verify role not configured. Admin: `!verify set role @role`");
        return;
      }

      const result = await analyzeAndVerifyFromScreenshot({
        guild: message.guild,
        member,
        channel: message.channel,
        verifyCfg,
        attachment: imgAtt
      });

      if (!result.ok) {
        // delete the image to keep channel clean, then tell user what to do
        await message.delete().catch(() => {});
        if (result.reason === "MISSING_ICONS") {
          await message.channel.send(
            `${member} ❌ Wrong screenshot.\n` +
            `For **mobile-type** screenshots (GOVERNOR PROFILE), the image must include the required UI icons.\n` +
            `Please upload the correct RoK profile screen again.`
          );
          return;
        }
        if (result.reason === "NO_ID") {
          await message.channel.send(
            `${member} ❌ I couldn’t read your **Governor ID**.\n` +
            `Upload a clearer screenshot (no crop, full profile screen).`
          );
          return;
        }
        if (result.reason === "ID_NOT_FOUND") {
          await message.channel.send(
            `${member} ❌ Your ID (**${result.govId}**) is not in our database.\n` +
            `Contact an officer.`
          );
          return;
        }
        if (result.reason === "CSV_ERROR") {
          await message.channel.send(`${member} ❌ Database error. Contact an admin.`);
          return;
        }
        if (result.reason === "BOT_MISSING_PERMS") {
          await message.channel.send(`${member} ❌ Bot missing permissions (Manage Nicknames / Manage Roles).`);
          return;
        }
        await message.channel.send(`${member} ❌ Verification failed. Upload again.`);
        return;
      }

      // success
      verifiedDone.set(member.id, true);

      // keep channel clean: delete screenshot after success (optional)
      await message.delete().catch(() => {});

      await message.channel.send(
        `✅ Verified ${member} as **${result.cleanName}** (ID: ${result.govId}). Role granted.`
      );
    } catch (e) {
      console.error("[VERIFY] screenshot verify error:", e?.message ?? e);
      await message.delete().catch(() => {});
      await message.channel.send(`${member} ❌ Something went wrong reading your screenshot. Try again.`);
    }
  });
}
