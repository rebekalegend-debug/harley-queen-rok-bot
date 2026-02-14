// modules/verify.js
console.log("🔥 VERIFY MODULE BUILD 2026-02-14 CLEAN DM VERSION");

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import {
  Events,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from "discord.js";

import { parse } from "csv-parse/sync";
import { getGuild, setGuild } from "./guildConfig.js";

import Jimp from "jimp";
import { createWorker } from "tesseract.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HARLEY_QUINN_USER_ID = "297057337590546434";

const DATA_FILE = path.join(__dirname, "DATA.csv");
const ICON_FILES = ["1.png", "2.png", "3.png"].map(f => path.join(__dirname, f));

/* ================= MEMORY ================= */

const verifiedDone = new Map();
const lockedUntilRejoin = new Map();
const rejectCount = new Map();
const lockedContactAdmin = new Map();

/* ================= QUEUE ================= */

let avgVerifySeconds = 30;
const AVG_MIN = 15;
const AVG_MAX = 120;
const SMOOTHING = 0.30;

const verifyQueue = [];
let verifyRunning = false;

function ordinal(n) {
  const s = ["th","st","nd","rd"];
  const v = n % 100;
  return n + (s[(v-20)%10] || s[v] || s[0]);
}

function estimateSeconds(position) {
  const per = Math.min(AVG_MAX, Math.max(AVG_MIN, avgVerifySeconds));
  return Math.round(position * per);
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

/* ================= DISMISS BUTTON ================= */

function dismissRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("verify_dismiss")
      .setLabel("Dismiss")
      .setStyle(ButtonStyle.Secondary)
  );
}

/* ================= KEEP ALIVE ================= */

let httpStarted = false;
function startHttpKeepAliveOnce() {
  if (httpStarted) return;
  httpStarted = true;

  const PORT = process.env.PORT || 8080;
  http.createServer((req,res)=>{
    res.writeHead(200,{"Content-Type":"text/plain"});
    res.end("OK");
  }).listen(PORT,()=>console.log("🌐 HTTP running"));
}

/* ================= HELPERS ================= */

function sanitizeName(raw) {
  const name = String(raw ?? "").trim();
  if (name.length < 2 || name.length > 32) return null;
  const ok = /^[\p{L}\p{N} ._\-'\[\]#]+$/u.test(name);
  return ok ? name : null;
}

function readCsvRecords() {
  if (!fs.existsSync(DATA_FILE)) throw new Error("DATA.csv missing");
  const csvText = fs.readFileSync(DATA_FILE, "utf8");
  return parse(csvText, { columns:true, skip_empty_lines:true, trim:true });
}

function lookupNameByGovernorId(governorId) {
  const records = readCsvRecords();
  for (const row of records) {
    if (String(row.ID).trim() === String(governorId).trim())
      return row.Name;
  }
  return null;
}

function extractGovernorIdFromText(text) {
  const m = String(text).match(/ID\s*[:#]\s*([0-9]{6,20})/i);
  return m ? m[1] : null;
}

function isImageAttachment(att) {
  if (!att) return false;
  if (att.contentType?.startsWith("image/")) return true;
  const name = (att.name||"").toLowerCase();
  return /\.(png|jpg|jpeg|webp)$/.test(name);
}

async function downloadToBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Image download failed");
  return Buffer.from(await res.arrayBuffer());
}

/* ================= OCR ================= */

let ocrWorker = null;
async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  const w = await createWorker();
  await w.loadLanguage("eng");
  await w.initialize("eng");
  ocrWorker = w;
  return ocrWorker;
}

/* ================= ICON CHECK ================= */

let iconTemplates = null;

async function loadIcons() {
  if (iconTemplates) return iconTemplates;
  iconTemplates = [];
  for (const p of ICON_FILES) {
    if (fs.existsSync(p)) {
      iconTemplates.push(await Jimp.read(p));
    }
  }
  return iconTemplates;
}

async function containsAnyIcon(img) {
  const templates = await loadIcons();
  if (!templates.length) return false;

  for (const t of templates) {
    const diff = Jimp.diff(img.clone().resize(200,200), t.clone().resize(200,200)).percent;
    if (diff < 0.20) return true;
  }
  return false;
}

/* ================= VERIFY PIPELINE ================= */

async function analyzeAndVerify({ guild, member, verifyCfg, attachment }) {

  const buf = await downloadToBuffer(attachment.url);
  const img = await Jimp.read(await sharp(buf).png().toBuffer());

  const worker = await getOcrWorker();
  const { data } = await worker.recognize(await img.getBufferAsync(Jimp.MIME_PNG));

  const govId = extractGovernorIdFromText(data.text);
  if (!govId) return { ok:false, reason:"NO_ID" };

  const iconOk = await containsAnyIcon(img);
  if (!iconOk) return { ok:false, reason:"MISSING_ICONS", govId };

  const nameFromDb = lookupNameByGovernorId(govId);
  if (!nameFromDb) return { ok:false, reason:"ID_NOT_FOUND", govId };

  const cleanName = sanitizeName(nameFromDb);
  if (!cleanName) return { ok:false, reason:"BAD_NAME" };

  await member.setNickname(cleanName).catch(()=>{});
  await member.roles.add(verifyCfg.roleId).catch(()=>{});

  return { ok:true, govId, cleanName };
}

/* ================= RESULT HANDLER ================= */

async function handleVerifyResult({ message, member, result }) {

  if (!result.ok) {
    await message.delete().catch(()=>{});

    await member.send({
      content: `❌ Verification failed (${result.reason}).`,
      components: [dismissRow()]
    }).catch(()=>{});

    return;
  }

  verifiedDone.set(member.id,true);

  await member.send({
    content:
      `✅ Verified successfully!\n\n`+
      `Name: ${result.cleanName}\n`+
      `ID: ${result.govId}`,
    components:[dismissRow()]
  }).catch(()=>{});

  await message.channel.send(`✅ ${member} verified.`);
}

/* ================= EXPORT ================= */

export function setupVerify(client) {

  startHttpKeepAliveOnce();

  client.on(Events.InteractionCreate, async interaction=>{
    if (!interaction.isButton()) return;
    if (interaction.customId !== "verify_dismiss") return;
    await interaction.update({ content:"Dismissed.", components:[] }).catch(()=>{});
  });

  client.on(Events.GuildMemberAdd, async member=>{
    const cfg = getGuild(member.guild.id).verify;
    if (!cfg?.channelId) return;

    const channel = await member.guild.channels.fetch(cfg.channelId).catch(()=>null);
    if (!channel) return;

    verifiedDone.delete(member.id);
    rejectCount.delete(member.id);
    lockedContactAdmin.delete(member.id);
    lockedUntilRejoin.delete(member.id);

    await channel.send(
`Welcome ${member} 💗

Please upload a full screenshot of your Rise of Kingdoms profile.`
    );
  });

  client.on(Events.MessageCreate, async message=>{

    if (message.author.bot) return;
    if (!message.guild) return;

    const verifyCfg = getGuild(message.guild.id).verify || {};
    if (!verifyCfg.channelId || message.channel.id !== verifyCfg.channelId) return;

    const member = await message.guild.members.fetch(message.author.id).catch(()=>null);
    if (!member) return;

    if (verifyCfg.roleId && member.roles.cache.has(verifyCfg.roleId))
      return message.delete().catch(()=>{});

    const imgAtt = message.attachments.find(isImageAttachment);
    if (!imgAtt) return message.delete().catch(()=>{});

    if (!verifyCfg.roleId) return;

    verifyQueue.push({ message, member, verifyCfg, attachment: imgAtt });

    const position = verifyQueue.length;
    const eta = estimateSeconds(position);

    await member.send({
      content:
        `⏳ You are ${ordinal(position)} in queue.\n`+
        `Estimated time: ${eta}s.`,
      components:[dismissRow()]
    }).catch(()=>{});

    processVerifyQueue();
  });

  async function runVerificationJob(job) {
    const started = Date.now();
    const result = await analyzeAndVerify(job);
    await handleVerifyResult({ ...job, result });

    const seconds = Math.max(1,Math.round((Date.now()-started)/1000));
    avgVerifySeconds =
      (1-SMOOTHING)*avgVerifySeconds + SMOOTHING*seconds;
    avgVerifySeconds =
      Math.min(AVG_MAX,Math.max(AVG_MIN,avgVerifySeconds));
  }
}
