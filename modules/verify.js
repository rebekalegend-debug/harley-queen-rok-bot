// modules/verify.js
console.log("🔥 VERIFY MODULE BUILD 2026-02-14 FIXED");

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import http from "node:http";

import {
  Events,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from "discord.js";

import { parse } from "csv-parse/sync";
import { getGuild } from "./guildConfig.js";
import Jimp from "jimp";
import { createWorker } from "tesseract.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_FILE = path.join(__dirname, "DATA.csv");
const ICON_FILES = ["1.png","2.png","3.png"].map(f=>path.join(__dirname,f));

/* ================= MEMORY ================= */

const verifiedDone = new Map();
const verifyQueue = [];
let verifyRunning = false;

/* ================= BUTTON ================= */

function dismissRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("verify_dismiss")
      .setLabel("Dismiss")
      .setStyle(ButtonStyle.Secondary)
  );
}

/* ================= OCR ================= */

let worker = null;
async function getWorker(){
  if(worker) return worker;
  worker = await createWorker();
  await worker.loadLanguage("eng");
  await worker.initialize("eng");
  return worker;
}

/* ================= CSV ================= */

function lookupName(id){
  if(!fs.existsSync(DATA_FILE)) return null;
  const csv = fs.readFileSync(DATA_FILE,"utf8");
  const rows = parse(csv,{columns:true,trim:true});
  for(const r of rows){
    if(String(r.ID).trim()===String(id).trim())
      return r.Name;
  }
  return null;
}

/* ================= VERIFY CORE ================= */

async function analyze(member, verifyCfg, attachment){

  const res = await fetch(attachment.url);
  const buffer = Buffer.from(await res.arrayBuffer());
  const img = await Jimp.read(await sharp(buffer).png().toBuffer());

  const w = await getWorker();
  const { data } = await w.recognize(await img.getBufferAsync(Jimp.MIME_PNG));

  const match = data.text.match(/ID\s*[:#]\s*([0-9]{6,20})/i);
  if(!match) return { ok:false, reason:"NO_ID" };

  const govId = match[1];
  const dbName = lookupName(govId);
  if(!dbName) return { ok:false, reason:"ID_NOT_FOUND", govId };

  if(!verifyCfg.roleId) return { ok:false, reason:"ROLE_NOT_SET" };

  await member.setNickname(dbName).catch(()=>{});
  await member.roles.add(verifyCfg.roleId).catch(()=>{});

  return { ok:true, govId, cleanName:dbName };
}

/* ================= QUEUE ================= */

async function processQueue(){
  if(verifyRunning) return;
  verifyRunning = true;

  while(verifyQueue.length>0){
    const job = verifyQueue.shift();
    await runJob(job);
  }

  verifyRunning = false;
}

async function runJob({message, member, verifyCfg, attachment}){

  const result = await analyze(member, verifyCfg, attachment);

  if(!result.ok){
    await message.delete().catch(()=>{});
    await member.send({
      content:`❌ Verification failed (${result.reason})`,
      components:[dismissRow()]
    }).catch(()=>{});
    return;
  }

  verifiedDone.set(member.id,true);

  await member.send({
    content:`✅ Verified!\nName: ${result.cleanName}\nID: ${result.govId}`,
    components:[dismissRow()]
  }).catch(()=>{});

  await message.channel.send(`✅ ${member} verified.`);
}

/* ================= EXPORT ================= */

export function setupVerify(client){

  client.on(Events.InteractionCreate, async interaction=>{
    if(!interaction.isButton()) return;
    if(interaction.customId!=="verify_dismiss") return;
    await interaction.update({content:"Dismissed.",components:[]}).catch(()=>{});
  });

  client.on(Events.MessageCreate, async message=>{

    if(message.author.bot) return;
    if(!message.guild) return;

    const verifyCfg = getGuild(message.guild.id).verify || {};
    if(!verifyCfg.channelId) return;
    if(message.channel.id!==verifyCfg.channelId) return;

    const member = await message.guild.members.fetch(message.author.id);

    if(verifyCfg.roleId && member.roles.cache.has(verifyCfg.roleId)){
      return message.delete().catch(()=>{});
    }

    const attachment = message.attachments.first();
    if(!attachment) return message.delete().catch(()=>{});

    verifyQueue.push({message, member, verifyCfg, attachment});
    await member.send({
      content:"⏳ Screenshot received. Verifying...",
      components:[dismissRow()]
    }).catch(()=>{});

    processQueue();
  });
}
