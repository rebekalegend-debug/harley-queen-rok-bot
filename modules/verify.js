// modules/verify.js
console.log("🔥 VERIFY MODULE BUILD CLEAN CHANNEL VERSION");

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
const ICON_FILES = ["1.png","2.png","3.png"].map(f=>path.join(__dirname,f));

/* ================= MEMORY ================= */

const verifiedDone = new Map();
const lockedUntilRejoin = new Map();
const rejectCount = new Map();
const lockedContactAdmin = new Map();

let avgVerifySeconds = 30;
const AVG_MIN = 15;
const AVG_MAX = 120;
const SMOOTHING = 0.30;

const verifyQueue = [];
let verifyRunning = false;

/* ================= DISMISS BUTTON ================= */

function dismissRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("verify_dismiss")
      .setLabel("Dismiss")
      .setStyle(ButtonStyle.Secondary)
  );
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
      return row.Name || null;
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

/* ================= VERIFY CORE ================= */

async function analyzeAndVerify({ guild, member, verifyCfg, attachment }) {

  const buf = await downloadToBuffer(attachment.url);
  const img = await Jimp.read(await sharp(buf).png().toBuffer());

  const worker = await getOcrWorker();
  const { data } = await worker.recognize(await img.getBufferAsync(Jimp.MIME_PNG));

  const govId = extractGovernorIdFromText(data.text);
  if (!govId) return { ok:false, reason:"NO_ID" };

  const nameFromDb = lookupNameByGovernorId(govId);
  if (!nameFromDb) return { ok:false, reason:"ID_NOT_FOUND", govId };

  const cleanName = sanitizeName(nameFromDb);
  if (!cleanName) return { ok:false, reason:"BAD_NAME" };

  const me = await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.ManageNicknames) ||
      !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return { ok:false, reason:"BOT_MISSING_PERMS" };
  }

  await member.setNickname(cleanName).catch(()=>{});
  await member.roles.add(verifyCfg.roleId).catch(()=>{});

  return { ok:true, govId, cleanName };
}

/* ================= RESULT HANDLER ================= */

async function handleVerifyResult({ message, member, result }) {

  if (!result.ok) {
    await message.delete().catch(()=>{});

    await member.send({
      content:`❌ Verification failed (${result.reason}).`,
      components:[dismissRow()]
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

/* ================= QUEUE ================= */

async function processVerifyQueue() {
  if (verifyRunning) return;
  verifyRunning = true;

  while (verifyQueue.length > 0) {
    const job = verifyQueue.shift();
    await runVerificationJob(job);
  }

  verifyRunning = false;
}

async function runVerificationJob(job) {
  const { message, member, verifyCfg, attachment } = job;
  const result = await analyzeAndVerify({ 
    guild: message.guild, 
    member, 
    verifyCfg, 
    attachment 
  });
  await handleVerifyResult({ message, member, result });
}

/* ================= EXPORT ================= */

export function setupVerify(client) {

  client.on(Events.InteractionCreate, async interaction=>{
    if(!interaction.isButton()) return;
    if(interaction.customId!=="verify_dismiss") return;
    await interaction.update({content:"Dismissed.",components:[]}).catch(()=>{});
  });

  client.on(Events.MessageCreate, async message=>{

    if(message.author.bot) return;

    if(!message.guild){
      if(message.author.id===HARLEY_QUINN_USER_ID) return;
      return message.reply(
        `Hi! I’m just a bot 🤖\n\nPlease contact <@${HARLEY_QUINN_USER_ID}> for help.`
      ).catch(()=>{});
    }

    const guildId = message.guild.id;
    const verifyCfg = getGuild(guildId).verify || {};
    if(!verifyCfg.channelId) return;
    if(message.channel.id!==verifyCfg.channelId) return;

    const member = await message.guild.members.fetch(message.author.id);
    if(!member) return;

    if(verifyCfg.roleId && member.roles.cache.has(verifyCfg.roleId))
      return message.delete().catch(()=>{});

    const imgAtt = message.attachments.find(isImageAttachment);
    if(!imgAtt) return message.delete().catch(()=>{});

    verifyQueue.push({message, member, verifyCfg, attachment: imgAtt});

    await member.send({
      content:"⏳ Screenshot received. Verifying...",
      components:[dismissRow()]
    }).catch(()=>{});

    processVerifyQueue();
  });
}
