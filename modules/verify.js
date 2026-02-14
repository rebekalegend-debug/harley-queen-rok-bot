// modules/verify.js
// 🔥 VERIFY MODULE 2026 - CLEAN CHANNEL + DM FLOW + OCR FIRST

import fs from "fs";
import path from "path";
import sharp from "sharp";
import Tesseract from "tesseract.js";
import { fileURLToPath } from "url";
import {
  Events,
  PermissionFlagsBits
} from "discord.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const lockedUsers = new Set();
const DATA_FILE = path.join(__dirname, "data.csv");
const CONFIG_FILE = "/data/verify.config.json";
const ID_ANCHOR = path.join(__dirname, "id_anchor.png");

if (!fs.existsSync("/data")) {
  fs.mkdirSync("/data", { recursive: true });
}


const ICONS = [
  path.join(__dirname, "1.png"),
  path.join(__dirname, "2.png"),
  path.join(__dirname, "3.png")
];

const PROCESS_TIME = 40; // seconds average per user

let queue = [];
let processing = false;
let userAttempts = new Map();

/* ================= CONFIG ================= */

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return { verifyChannel: null, roleId: null, locked: [] };
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

/* ================= CSV LOAD ================= */

function loadDatabase() {
  const map = new Map();
  if (!fs.existsSync(DATA_FILE)) return map;

  const rows = fs.readFileSync(DATA_FILE, "utf8").split("\n");
  for (const row of rows) {
    const [id, name] = row.split(",");
    if (id && name) map.set(id.trim(), name.trim());
  }
  return map;
}

/* ================= OCR ================= */

async function extractGovernorId(buffer, db) {

  const processed = await sharp(buffer)
    .resize({ width: 1600 })
    .grayscale()
    .threshold(150)
    .toBuffer();

  const { data } = await Tesseract.recognize(processed, "eng", {
    tessedit_char_whitelist: "0123456789ID",
  });

  console.log("=== DIGIT OCR RAW ===");
  console.log(data.text);

  const idMatch = data.text.match(/ID[:\s]*([0-9]{6,9})/i);

  if (idMatch) {
  const id = idMatch[1].trim();
  console.log("Matched ID from pattern:", id);
  return id;
}


  const cleaned = data.text.replace(/\D/g, "");

  for (let len = 6; len <= 9; len++) {
    for (let i = 0; i <= cleaned.length - len; i++) {

      const sub = cleaned.substring(i, i + len);

      if (db.has(sub)) {
        console.log("Matched DB ID from substring:", sub);
        console.log("DB has extracted ID?", db.has(id));
        return sub;
      }
    }
  }

  return null;
}


/* ================= ICON CHECK ================= */

async function iconCheck(imageBuffer) {
  console.log("🔎 Checking for edit icon...");

  const image = sharp(imageBuffer);
  const metadata = await image.metadata();

  const width = metadata.width;
  const height = metadata.height;

  // Crop LEFT PROFILE PANEL ONLY
  const profilePanel = await image
    .extract({
      left: 0,
      top: 0,
      width: Math.floor(width * 0.60),
      height: Math.floor(height * 0.55)
    })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const icon = await sharp(ICONS[0]) // your 1.png
    .resize({ width: 28 }) // realistic size
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const sData = profilePanel.data;
  const iData = icon.data;

  const sWidth = profilePanel.info.width;
  const sHeight = profilePanel.info.height;
  const iWidth = icon.info.width;
  const iHeight = icon.info.height;

  let bestSimilarity = 0;

  for (let y = 0; y < sHeight - iHeight; y += 3) {
    for (let x = 0; x < sWidth - iWidth; x += 3) {

      let matchScore = 0;
      let total = iWidth * iHeight;

      for (let iy = 0; iy < iHeight; iy++) {
        for (let ix = 0; ix < iWidth; ix++) {

          const sIndex = ((y + iy) * sWidth + (x + ix));
          const iIndex = (iy * iWidth + ix);

          if (Math.abs(sData[sIndex] - iData[iIndex]) < 25) {
            matchScore++;
          }
        }
      }

      const similarity = matchScore / total;

      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
      }

      if (similarity > 0.65) {
        console.log("✅ ICON FOUND. Similarity:", similarity);
        return true;
      }
    }
  }

  console.log("Best similarity:", bestSimilarity);
  console.log("❌ Icon not detected.");
  return false;
}


/* ================= QUEUE SYSTEM ================= */

async function processQueue(client) {
  if (processing) return;
  processing = true;

  while (queue.length > 0) {
    const job = queue.shift();
    await handleVerification(client, job);
  }

  processing = false;
}

/* ================= CORE VERIFY ================= */

async function handleVerification(client, { member, attachment }) {
  const cfg = loadConfig();
  const db = loadDatabase();

  const user = member.user;

  try {
    const response = await fetch(attachment.url);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const governorId = await extractGovernorId(buffer, db);


    if (!governorId) {
      return rejectUser(user, member, 1, null);
    }

    const iconValid = await iconCheck(buffer);

    if (!iconValid) {
      return rejectUser(user, member, 2, null);
    }

    if (!db.has(governorId)) {
      await user.send(
        `❌ Attempt to **impersonate or bypass** detected!\nYou are now locked. Please **contact an admin**.`
      );
lockedUsers.add(user.id);

const cfg = loadConfig();

if (!cfg.locked) cfg.locked = [];

if (!cfg.locked.includes(user.id)) {
  cfg.locked.push(user.id);
  saveConfig(cfg);
}

console.log("User permanently locked:", user.id);


      if (!cfg.verifyChannel) {
  console.log("⚠️ Verify channel not set.");
  return;
}

const channel = await client.channels.fetch(cfg.verifyChannel).catch(() => null);
if (!channel) {
  console.log("❌ Could not fetch verify channel.");
  return;
}

      if (channel) {
        await channel.send({
          content: `❌ ${member} tryed an attempt to **impersonate or bypass**!`,
          files: [attachment.url]
        });
      }

      return;
    }

    const name = db.get(governorId);

    await member.setNickname(name).catch(() => {});
    if (cfg.roleId) {
      await member.roles.add(cfg.roleId).catch(() => {});
    }

    await user.send(`✅ You are now verified as **${name}**`);

    const channel = await client.channels.fetch(cfg.verifyChannel);
    if (channel) {
      await channel.send({
        content: `✅ ${member} verified`,
        files: [attachment.url]
      });
    }
  } catch (err) {
    console.error(err);
  }
}

/* ================= REJECT SYSTEM ================= */

async function rejectUser(user, member, type) {
  const attempts = (userAttempts.get(user.id) || 0) + 1;
  userAttempts.set(user.id, attempts);

  if (attempts >= 3) {
    await user.send(
      `❌ Stop uploading. Please **contact an admin**.`
    );
    return;
  }

  if (type === 1) {
    await user.send(
      `❌ I couldn’t read your **Governor ID**.\n🆙 Upload a clearer full profile screenshot (no crop).\nAttempts: **${attempts}/3**`
    );
  }

  if (type === 2) {
    await user.send(
      `❌ This screenshot does **not** look like it was taken from **your own in-game profile screen**.\n⚠️ It may be cropped / edited.\n🔁 Please take a fresh full screenshot.\nAttempts: **${attempts}/3**`
    );
  }
}

/* ================= MAIN EXPORT ================= */

export function setupVerify(client) {
const cfg = loadConfig();
if (cfg.locked && Array.isArray(cfg.locked)) {
  for (const id of cfg.locked) {
    lockedUsers.add(id);
  }
}
 client.on(Events.GuildMemberAdd, async (member) => {

  const cfg = loadConfig();

  // 🚫 If permanently locked → DO NOT send welcome
  if (cfg.locked && cfg.locked.includes(member.id)) {

    console.log("Blocked rejoin attempt:", member.id);

    try {
      await member.send(
`🚫 You are banned from verification due to attempting to bypass the system.

If you believe this was a mistake, please contact an admin.

Thank you.`
      );
    } catch {}

    return; // 🔴 VERY IMPORTANT — stop here
  }

  // ✅ Normal users get welcome
try {
  await member.send(
`Welcome ${member}💗!

🆙 Please upload a screenshot of your **Rise of Kingdoms profile** here.
📸👉🪪

The image must be:
• A real screenshot taken by you recently  
• Full screen (no crop)  
• With visible action points  
• With visible name-change icon  
• Showing your main account (no farm accounts)

⚠️ Edited, cropped, forwarded, or fake images will result in verification lock.`
  );
} catch {}

});

  client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  

  /* ================= DM MESSAGES ================= */
  if (!message.guild) {

    // If user is locked → always reply
    if (lockedUsers.has(message.author.id)) {
      await message.channel.send(
`I'm just a bot, please reach out to <@297057337590546434>`
      );
      return;
    }

    // If DM contains image → verification flow
    if (message.attachments.size > 0) {
      const guild = client.guilds.cache.first();
      if (!guild) return;

      const member = await guild.members.fetch(message.author.id).catch(() => null);
      if (!member) return;

      const position = queue.length;
      const waitTime = position * PROCESS_TIME;

      await message.channel.send(
        `⏳ Please wait, I'm verifying your image.\nEstimated time: ~${waitTime} seconds`
      );

      queue.push({
        member,
        attachment: message.attachments.first()
      });

      processQueue(client);
      return;
    }

    // If DM text but not image → ignore (or you can reply if you want)
    return;
  }

  /* ================= GUILD MESSAGES ================= */

  // Clean verify channel
  if (message.channel.id === cfg.verifyChannel) {
    await message.delete().catch(() => {});
  }
 
    // unlock an locked user
if (message.content.startsWith("!verify unlock")) {
  if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return;

  const user = message.mentions.users.first();
  if (!user) return message.reply("Mention a user to unlock.");

  const cfg = loadConfig();

  lockedUsers.delete(user.id);

  if (cfg.locked) {
    cfg.locked = cfg.locked.filter(id => id !== user.id);
    saveConfig(cfg);
  }

  return message.reply(`✅ ${user.tag} has been unlocked.`);
}

  //list locked users
if (message.content === "!verify locked") {
  if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return;

  const cfg = loadConfig();
  const list = cfg.locked || [];

  if (list.length === 0) return message.reply("No locked users.");

  return message.reply(
    "🔒 Locked Users:\n" + list.map(id => `<@${id}>`).join("\n")
  );
}



    
    
  // Admin commands
  if (message.content.startsWith("!verify set role")) {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return;
    const role = message.mentions.roles.first();
    if (!role) return message.reply("Mention a role.");
    cfg.roleId = role.id;
    saveConfig(cfg);
    return message.reply("✅ Verify role set.");
  }

  if (message.content === "!verify status") {
    return message.reply(
      `Verify Channel: ${cfg.verifyChannel || "Not set"}\nRole: ${
        cfg.roleId ? `<@&${cfg.roleId}>` : "Not set"
      }`
    );
  }

  if (message.content.startsWith("!set verify channel")) {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return;
    cfg.verifyChannel = message.channel.id;
    saveConfig(cfg);
    return message.reply("✅ This channel set as verify log.");
  }

});
}
