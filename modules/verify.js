// modules/verify.js
console.log("🔥 VERIFY MODULE BUILD 2026-02-13 FINAL (QUEUE + DM)");

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

const DATA_FILE = path.join(__dirname, "DATA.csv");
const ICON_FILES = ["1.png", "2.png", "3.png"].map(f => path.join(__dirname, f));

/* ================= STATE ================= */

const verifiedDone = new Map();
const lockedUntilRejoin = new Map();
const rejectCount = new Map();
const lockedContactAdmin = new Map();

/* ================= DM HELPER ================= */

async function dmOrChannel(member, channel, text) {
  try {
    await member.send(text);
  } catch {
    await channel.send(`${member} ${text}`);
  }
}

/* ================= QUEUE ================= */

const VERIFY_TIME_PER_IMAGE = 20;
const verifyQueue = [];
let verifyRunning = false;

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function getQueuePositionIncludingRunning(userId) {
  let pos = verifyRunning ? 1 : 0;
  for (const job of verifyQueue) {
    pos++;
    if (job.member.id === userId) return pos;
  }
  return null;
}

function estimateSeconds(position) {
  return Math.max(VERIFY_TIME_PER_IMAGE, position * VERIFY_TIME_PER_IMAGE);
}

function isUserAlreadyQueued(userId) {
  return verifyQueue.some(j => j.member.id === userId);
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

  const freshMember = await message.guild.members.fetch(member.id).catch(() => null);
  if (!freshMember) return;

  if (lockedContactAdmin.get(freshMember.id) || lockedUntilRejoin.get(freshMember.id)) {
    await message.delete().catch(() => {});
    return;
  }

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

    await handleVerifyResult({ message, member: freshMember, result });

  } catch (e) {
    console.error("[VERIFY] queue job error:", e?.message ?? e);
    await message.delete().catch(() => {});
    await dmOrChannel(freshMember, message.channel, "❌ Something went wrong reading your screenshot. Try again.");
  }
}

/* ================= KEEP ALIVE ================= */

let httpStarted = false;
function startHttpKeepAliveOnce() {
  if (httpStarted) return;
  httpStarted = true;

  const PORT = process.env.PORT || 8080;
  http.createServer((req, res) => {
    res.writeHead(200);
    res.end("OK");
  }).listen(PORT);
}

/* ================= HELPERS ================= */

async function loadImageForJimp(buffer) {
  try { return await Jimp.read(buffer); }
  catch {
    const png = await sharp(buffer).png().toBuffer();
    return await Jimp.read(png);
  }
}

function sanitizeName(raw) {
  const name = String(raw ?? "").trim();
  if (name.length < 2 || name.length > 32) return null;
  const ok = /^[\p{L}\p{N} ._\-'\[\]#]+$/u.test(name);
  return ok ? name : null;
}

function readCsvRecords() {
  return parse(fs.readFileSync(DATA_FILE, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });
}

function lookupNameByGovernorId(id) {
  for (const row of readCsvRecords()) {
    if (String(row.ID).trim() === String(id).trim()) return row.Name;
  }
  return null;
}

function isImageAttachment(att) {
  if (!att) return false;
  if (att.contentType?.startsWith("image/")) return true;
  const n = (att.name || "").toLowerCase();
  return /\.(png|jpg|jpeg|webp)$/.test(n);
}

async function downloadToBuffer(url) {
  const res = await fetch(url);
  return Buffer.from(await res.arrayBuffer());
}

function addReject(id) {
  const n = (rejectCount.get(id) ?? 0) + 1;
  rejectCount.set(id, n);
  return n;
}

function extractGovernorIdFromText(text) {
  const m = text.match(/ID\s*[:#]\s*([0-9]{6,20})/i);
  return m ? m[1] : null;
}

/* ================= OCR ================= */

let ocrWorker = null;
async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;

  const w = await createWorker();
  await w.loadLanguage("eng");
  await w.initialize("eng");

  ocrWorker = w;
  return w;
}

/* ================= VERIFY PIPELINE ================= */

async function analyzeAndVerifyFromScreenshot({ guild, member, verifyCfg, attachment }) {
  const buf = await downloadToBuffer(attachment.url);
  const img = await loadImageForJimp(buf);
  const worker = await getOcrWorker();

  const txt = await worker.recognize(await img.getBufferAsync(Jimp.MIME_PNG));
  const govId = extractGovernorIdFromText(txt.data.text);

  if (!govId) return { ok: false, reason: "NO_ID" };

  const nameFromDb = lookupNameByGovernorId(govId);
  if (!nameFromDb) return { ok: false, reason: "ID_NOT_FOUND", govId };

  const cleanName = sanitizeName(nameFromDb);
  if (!cleanName) return { ok: false, reason: "BAD_NAME" };

  const me = await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.ManageNicknames) ||
      !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { ok: false, reason: "BOT_MISSING_PERMS" };
  }

  await member.setNickname(cleanName).catch(() => {});
  await member.roles.add(verifyCfg.roleId).catch(() => {});

  return { ok: true, govId, cleanName };
}

/* ================= RESULT HANDLER ================= */

async function handleVerifyResult({ message, member, result }) {

  if (!result.ok) {
    await message.delete().catch(() => {});

    if (result.reason === "NO_ID") {
      const n = addReject(member.id);
      return dmOrChannel(member, message.channel,
        `❌ I couldn’t read your Governor ID.\nAttempts: **${n}/3**`
      );
    }

    if (result.reason === "ID_NOT_FOUND") {
      lockedUntilRejoin.set(member.id, true);
      return dmOrChannel(member, message.channel,
        `❌ Your ID (**${result.govId}**) is not in database.\nContact an admin.`
      );
    }

    return dmOrChannel(member, message.channel, "❌ Verification failed. Upload again.");
  }

  verifiedDone.set(member.id, true);

  await message.channel.send(
    `✅ Verified ${member} as **${result.cleanName}** (ID: ${result.govId}). Role granted.`
  );
}

/* ================= EXPORT ================= */

export function setupVerify(client) {

  startHttpKeepAliveOnce();

  client.on(Events.MessageCreate, async message => {

    if (message.author.bot) return;

    const guildId = message.guild?.id;
    if (!guildId) return;

    const verifyCfg = getGuild(guildId).verify || {};
    if (!verifyCfg.channelId || message.channel.id !== verifyCfg.channelId) return;

    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member) return;

    const imgAtt = message.attachments.find(isImageAttachment);
    if (!imgAtt) return message.delete().catch(() => {});

    if (isUserAlreadyQueued(member.id)) return message.delete().catch(() => {});

    verifyQueue.push({ message, member, verifyCfg, attachment: imgAtt });

    const position = getQueuePositionIncludingRunning(member.id) ?? 1;
    const eta = estimateSeconds(position);

    await dmOrChannel(
      member,
      message.channel,
      `⏳ Please wait, I'm verifying your image…\nYou are **${ordinal(position)} in queue**.\nEstimated time: **~${eta} seconds**.`
    );

    processVerifyQueue();
  });
}
