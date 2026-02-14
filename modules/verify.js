// modules/verify.js
console.log("🔥 VERIFY MODULE BUILD 2026-02-13 FINAL (QUEUE + OCR FIRST -> ICON CHECK -> WEBP -> 3-REJECT LOCK)");

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { Events, PermissionFlagsBits } from "discord.js";
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

// runtime memory
const verifiedDone = new Map();       // userId -> verified success this session
const lockedUntilRejoin = new Map();  // userId -> locked until rejoin (ID not in DB)
const rejectCount = new Map();        // userId -> rejected attempts
const lockedContactAdmin = new Map(); // userId -> hard stop after 3 rejects

/* ================= DM HELPER ================= */
// Send to DM; if user has DMs closed, fallback to channel mention.
async function sendUser(member, channel, text) {
  try {
    await member.send(text);
  } catch {
    await channel.send(`${member} ${text}`).catch(() => {});
  }
}

/* ================= VERIFY QUEUE ================= */

const VERIFY_TIME_PER_IMAGE = 20; // seconds (your observed average)
const verifyQueue = [];           // jobs waiting
let verifyRunning = false;        // true while processing

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// includes currently running job
function getQueuePositionIncludingRunning(userId) {
  let pos = 0;
  if (verifyRunning) pos += 1; // someone is being processed now

  for (const job of verifyQueue) {
    pos += 1;
    if (job.member.id === userId) return pos;
  }
  return null;
}

function estimateSeconds(position) {
  // simple, predictable estimate
  return Math.max(VERIFY_TIME_PER_IMAGE, position * VERIFY_TIME_PER_IMAGE);
}

function isUserAlreadyQueued(userId) {
  return verifyQueue.some((j) => j.member.id === userId);
}

async function processVerifyQueue() {
  if (verifyRunning) return;
  verifyRunning = true;

  try {
    while (verifyQueue.length > 0) {
      const job = verifyQueue.shift();
      await runVerificationJob(job);
    }
  } finally {
    verifyRunning = false;
  }
}

async function runVerificationJob(job) {
  const { message, member, verifyCfg, attachment } = job;

  // user might have left / been verified / etc.
  const freshMember = await message.guild.members.fetch(member.id).catch(() => null);
  if (!freshMember) return;

  // if locked meanwhile, delete new upload and skip
  if (lockedContactAdmin.get(freshMember.id) || lockedUntilRejoin.get(freshMember.id)) {
    await message.delete().catch(() => {});
    return;
  }

  // if already got verified while waiting
  if (verifyCfg.roleId && freshMember.roles.cache.has(verifyCfg.roleId)) {
    await message.delete().catch(() => {});
    return;
  }

  try {
    const result = await analyzeAndVerifyFromScreenshot({
      guild: message.guild,
      member: freshMember,
      verifyCfg,
      attachment,
    });

    await handleVerifyResult({ message, member: freshMember, result, verifyCfg });
  } catch (e) {
    console.error("[VERIFY] queue job error:", e?.message ?? e);
    await message.delete().catch(() => {});
    await sendUser(freshMember, message.channel, "❌ Something went wrong reading your screenshot. Try again.");
  }
}

/* ================= KEEP-ALIVE HTTP ================= */

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

/* ================= PERMS ================= */

function isAdminPerm(member) {
  return member?.permissions?.has?.(PermissionFlagsBits.Administrator);
}
function isOwner(guild, userId) {
  return guild?.ownerId === userId;
}

/* ================= HELPERS ================= */

async function loadImageForJimp(buffer) {
  try {
    return await Jimp.read(buffer);
  } catch {
    // webp -> png
    const pngBuffer = await sharp(buffer).png().toBuffer();
    return await Jimp.read(pngBuffer);
  }
}

function sanitizeName(raw) {
  const name = String(raw ?? "").trim();
  if (name.length < 2 || name.length > 32) return null;
  const ok = /^[\p{L}\p{N} ._\-'\[\]#]+$/u.test(name);
  return ok ? name : null;
}

function readCsvRecords() {
  if (!fs.existsSync(DATA_FILE)) throw new Error(`DATA.csv not found at ${DATA_FILE}`);
  const csvText = fs.readFileSync(DATA_FILE, "utf8");
  return parse(csvText, { columns: true, skip_empty_lines: true, trim: true });
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
  if (!att) return false;
  if (att.contentType?.startsWith("image/")) return true;

  const name = (att.name || "").toLowerCase();
  const url = (att.url || "").toLowerCase();

  if (/\.(png|jpg|jpeg|webp)$/.test(name)) return true;
  if (url.includes(".webp") || url.includes(".png") || url.includes(".jpg") || url.includes(".jpeg")) return true;

  return false;
}

async function downloadToBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image (${res.status})`);
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

function addReject(memberId) {
  const n = (rejectCount.get(memberId) ?? 0) + 1;
  rejectCount.set(memberId, n);
  return n;
}

function extractGovernorIdFromText(text) {
  const t = String(text ?? "");
  const m = t.match(/ID\s*[:#]\s*([0-9]{6,20})/i);
  return m ? m[1] : null;
}

function cropByPercent(img, x1, y1, x2, y2) {
  const w = img.bitmap.width;
  const h = img.bitmap.height;

  const x = Math.max(0, Math.floor(w * x1));
  const y = Math.max(0, Math.floor(h * y1));
  const cw = Math.max(1, Math.floor(w * (x2 - x1)));
  const ch = Math.max(1, Math.floor(h * (y2 - y1)));

  return img.clone().crop(x, y, Math.min(cw, w - x), Math.min(ch, h - y));
}

async function preprocessForOcr(jimpImg) {
  const img = jimpImg.clone();

  const minW = 900;
  if (img.bitmap.width < minW) img.resize(minW, Jimp.AUTO);

  img.grayscale().contrast(0.6).normalize().posterize(6);

  return await img.getBufferAsync(Jimp.MIME_PNG);
}

async function ocrBuffer(worker, buffer) {
  const { data } = await worker.recognize(buffer);
  return String(data?.text ?? "").replace(/\s+/g, " ").trim();
}

/* ================= OCR (tesseract.js) ================= */

let ocrWorker = null;
async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;

  const w = await createWorker();
  await w.loadLanguage("eng");
  await w.initialize("eng");
  await w.setParameters({
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789():#- ",
  });

  ocrWorker = w;
  console.log("✅ [VERIFY] OCR worker ready");
  return ocrWorker;
}

/* ================= ICON MATCH (Jimp) ================= */

const ICON_MATCH_MAX_DIFF = 0.18;
const ICON_SCAN_STEP = 8;
const DOWNSCALE_WIDTH = 900;

let iconTemplates = null;

async function loadIconTemplatesOnce() {
  if (iconTemplates) return iconTemplates;

  const loaded = [];
  for (const p of ICON_FILES) {
    if (!fs.existsSync(p)) {
      console.warn(`[VERIFY] Missing icon template: ${p}`);
      continue;
    }
    const img = await Jimp.read(p); // templates are PNG
    loaded.push({ path: p, img, w: img.bitmap.width, h: img.bitmap.height });
  }

  if (!loaded.length) console.warn("[VERIFY] No icon templates loaded (1.png/2.png/3.png). Icon check will always fail.");
  else console.log(`[VERIFY] Loaded ${loaded.length} icon templates.`);

  iconTemplates = loaded;
  return iconTemplates;
}

async function containsAnyIcon(fullImgJimp) {
  const templates = await loadIconTemplatesOnce();
  if (!templates.length) return false;

  const img = fullImgJimp.clone();
  if (img.bitmap.width > DOWNSCALE_WIDTH) img.resize(DOWNSCALE_WIDTH, Jimp.AUTO);

  const scale = img.bitmap.width / fullImgJimp.bitmap.width;

  for (const t of templates) {
    const temp = t.img.clone();
    if (scale !== 1) temp.resize(Math.max(6, Math.round(t.w * scale)), Math.max(6, Math.round(t.h * scale)));

    if (temp.bitmap.width >= img.bitmap.width || temp.bitmap.height >= img.bitmap.height) continue;

    const maxX = img.bitmap.width - temp.bitmap.width;
    const maxY = img.bitmap.height - temp.bitmap.height;

    for (let y = 0; y <= maxY; y += ICON_SCAN_STEP) {
      for (let x = 0; x <= maxX; x += ICON_SCAN_STEP) {
        const crop = img.clone().crop(x, y, temp.bitmap.width, temp.bitmap.height);
        const diff = Jimp.diff(crop, temp).percent;
        if (diff <= ICON_MATCH_MAX_DIFF) return true;
      }
    }
  }

  return false;
}

/* ================= MAIN VERIFY PIPELINE =================
   IMPORTANT: OCR FIRST, THEN ICON CHECK
*/

async function analyzeAndVerifyFromScreenshot({ guild, member, verifyCfg, attachment }) {
  const buf = await downloadToBuffer(attachment.url);

  // load screenshot (supports webp)
  const img = await loadImageForJimp(buf);

  const worker = await getOcrWorker();

  // 1) OCR for ID first
  const candidateCrops = [
    // PC-ish regions
    cropByPercent(img, 0.28, 0.12, 0.75, 0.28),
    cropByPercent(img, 0.45, 0.10, 0.95, 0.30),
    // Mobile-ish regions
    cropByPercent(img, 0.05, 0.20, 0.45, 0.40),
    cropByPercent(img, 0.25, 0.20, 0.50, 0.35),
  ];

  let govId = null;
  for (const c of candidateCrops) {
    const cBuf = await preprocessForOcr(c);
    const txt = await ocrBuffer(worker, cBuf);
    const id = extractGovernorIdFromText(txt);
    if (id) {
      govId = id;
      break;
    }
  }

  if (!govId) return { ok: false, reason: "NO_ID" };

  // 2) Icon check second
  const iconOk = await containsAnyIcon(img);
  if (!iconOk) return { ok: false, reason: "MISSING_ICONS", govId };

  // 3) Database lookup
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

  // perms
  const me = await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.ManageNicknames) || !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { ok: false, reason: "BOT_MISSING_PERMS" };
  }

  // apply
  await member.setNickname(cleanName).catch(() => {});
  await member.roles.add(verifyCfg.roleId).catch(() => {});

  return { ok: true, govId, cleanName };
}

/* ================= RESULT HANDLER (used by queue) ================= */

async function handleVerifyResult({ message, member, result, verifyCfg }) {
  if (!result.ok) {
    // delete failed screenshots
    await message.delete().catch(() => {});

    if (result.reason === "NO_ID") {
      const n = addReject(member.id);
      if (n >= 3) {
        lockedContactAdmin.set(member.id, true);
        await sendUser(
          member,
          message.channel,
          `❌ I still can’t read your ID after **3 tries**.\nStop uploading. Please **contact an admin/officer** for manual verification.`
        );
        return;
      }
      await sendUser(
        member,
        message.channel,
        `❌ I couldn’t read your **Governor ID**.\nUpload a clearer full profile screenshot (no crop).\nAttempts: **${n}/3**`
      );
      return;
    }

    if (result.reason === "MISSING_ICONS") {
      const n = addReject(member.id);
      if (n >= 3) {
        lockedContactAdmin.set(member.id, true);
        await sendUser(
          member,
          message.channel,
          `❌ Screenshot rejected **3 times**.\nStop uploading. Please **contact an admin/officer** for manual verification.`
        );
        return;
      }

      await sendUser(
        member,
        message.channel,
        `❌ This screenshot does **not** look like it was taken from **your own in-game profile screen**.\n` +
          `⚠️ It may be a **cropped / edited / forwarded** image or an attempt to **impersonate or bypass** the verification.\n\n` +
          `✅ Please open **your RoK profile**, take a **fresh full screenshot yourself** (no crop), and upload it again.\n` +
          `If you believe this is a mistake, **contact an admin**.\n` +
          `Attempts: **${n}/3**`
      );
      return;
    }

    if (result.reason === "ID_NOT_FOUND") {
      lockedUntilRejoin.set(member.id, true);
      lockedContactAdmin.set(member.id, true);
      await sendUser(
        member,
        message.channel,
        `❌ Your ID (**${result.govId}**) is not in our database.\nYou are now locked. Please **contact an admin/officer**.`
      );
      return;
    }

    if (result.reason === "CSV_ERROR") {
      await sendUser(member, message.channel, `${member} ❌ Database error. Contact an admin.`);
      return;
    }

    if (result.reason === "BOT_MISSING_PERMS") {
      await sendUser(member, message.channel, `${member} ❌ Bot missing permissions (Manage Nicknames / Manage Roles).`);
      return;
    }

    await sendUser(member, message.channel, `${member} ❌ Verification failed. Upload again.`);
    return;
  }

  // success: keep screenshot for manual review (DO NOT delete)
  verifiedDone.set(member.id, true);

  // ✅ keep success message in channel (you wanted this)
  await message.channel.send(
    `✅ Verified ${member} as **${result.cleanName}** (ID: ${result.govId}). Role granted.`
  );
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

    // reset user state on rejoin
    verifiedDone.delete(member.id);
    rejectCount.delete(member.id);
    lockedContactAdmin.delete(member.id);
    lockedUntilRejoin.delete(member.id);

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
      return message
        .reply(`Hi! I’m just a bot 🤖\n\nPlease contact <@${HARLEY_QUINN_USER_ID}> for help.`)
        .catch(() => {});
    }

    const guildId = message.guild.id;
    const verifyCfg = getGuild(guildId).verify || {};

    // VERIFY ADMIN COMMANDS
    if (message.content.startsWith("!verify")) {
      const args = message.content.split(/\s+/);
      const sub = (args[1] || "help").toLowerCase();

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

    // hard locks
    if (lockedContactAdmin.get(member.id)) return message.delete().catch(() => {});
    if (lockedUntilRejoin.get(member.id)) return message.delete().catch(() => {});

    // already verified -> delete anything they post in verify channel
    if (verifyCfg.roleId && member.roles.cache.has(verifyCfg.roleId)) {
      return message.delete().catch(() => {});
    }

    // allow only image; delete other content
    const imgAtt = message.attachments.find(isImageAttachment);
    if (!imgAtt) return message.delete().catch(() => {});

    // if already verified in this session, block more uploads
    if (verifiedDone.get(member.id)) return message.delete().catch(() => {});

    // prevent spam: only 1 pending job per user
    if (isUserAlreadyQueued(member.id)) {
      return message.delete().catch(() => {});
    }

    // must be configured
    if (!verifyCfg.roleId) {
      await message.reply("❌ Verify role not configured. Admin: `!verify set role @role`");
      return;
    }

    // enqueue job
    verifyQueue.push({
      message,
      member,
      verifyCfg,
      attachment: imgAtt,
    });

    const position = getQueuePositionIncludingRunning(member.id) ?? 1;
    const eta = estimateSeconds(position);

    const etaText = eta >= 60 ? `~${Math.ceil(eta / 60)} min` : `~${eta} sec`;

    // ✅ Queue message -> DM (fallback to channel if DM is closed)
    await sendUser(
      member,
      message.channel,
      `⏳ Please wait, I'm verifying your image…\n` +
      `You are **${ordinal(position)} in queue**.\n` +
      `Estimated time: **${etaText}**.`
    );

    // start processing
    processVerifyQueue();
  });
}
