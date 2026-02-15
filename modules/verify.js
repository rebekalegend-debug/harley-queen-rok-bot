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
const pendingGuild = new Map(); // userId -> guildId
const DATA_FILE = path.join(__dirname, "DATA.csv");
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

  const rows = fs.readFileSync(DATA_FILE, "utf8")
    .split(/\r?\n/);

  for (const row of rows) {
    if (!row.trim()) continue;

    const parts = row.split(",");
    if (parts.length < 2) continue;

    const name = parts[0].trim();
    const rawId = parts[1];

    const cleanId = rawId.replace(/\D/g, "").trim();

    if (cleanId.length >= 6 && cleanId.length <= 9) {
      map.set(cleanId, name);
    }
  }

  console.log("Loaded DB IDs count:", map.size);

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

  const idMatch = data.text.match(/(ID|1D)[:\s]*([0-9]{6,9})/i);

  if (idMatch) {
  const id = idMatch[2].replace(/\D/g, "");
  console.log("Matched ID from pattern:", id);
  return id;
}


  const cleaned = data.text.replace(/\D/g, "");

  for (let len = 6; len <= 9; len++) {
    for (let i = 0; i <= cleaned.length - len; i++) {

      const sub = cleaned.substring(i, i + len);

      if (db.has(sub)) {
        console.log("Matched DB ID from substring:", sub);
        
        return sub;
      }
    }
  }

  return null;
}

/* ================= PROFILE SCREEN CHECK ================= */

async function profileScreenCheck(buffer) {
  console.log("🔎 Checking for profile screen via text...");

  const processed = await sharp(buffer)
    .resize({ width: 1600 })
    .grayscale()
    .normalize()
    .toBuffer();

  const { data } = await Tesseract.recognize(processed, "eng");

  const text = data.text.toLowerCase();

  console.log("=== PROFILE OCR TEXT ===");
  console.log(text);

  const anchors = [
    "troops",
    "commander",
    "rankings",
    "achievements",
    "alliance",
    "civilization",
    "governor"
  ];

  const found = anchors.some(word => text.includes(word));

  if (found) {
    console.log("✅ Profile screen confirmed via text anchor.");
    return true;
  }

  console.log("❌ Profile screen text anchor not found.");
  return false;
}


/* ================= QUEUE SYSTEM ================= */

async function processQueue(client) {
  if (processing) return;

  processing = true;

  try {
    while (queue.length > 0) {
      console.log("Queue length:", queue.length);

      const job = queue.shift();
      await handleVerification(client, job);
    }
  } catch (err) {
    console.error("Queue error:", err);
  } finally {
    processing = false;
  }
}


/* ================= CORE VERIFY ================= */

async function handleVerification(client, { member, attachment }) {
  const cfg = loadConfig();
  const db = loadDatabase();

  const user = member.user;

  try {
    console.log("Starting verification for:", member.user.id);

    const response = await fetch(attachment.url);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const governorId = await extractGovernorId(buffer, db);
    const cleanId = governorId ? governorId.replace(/\D/g, "") : null;

    console.log("Extracted ID:", cleanId);
    console.log("DB has ID?", cleanId ? db.has(cleanId) : false);

    if (!cleanId) {
      return rejectUser(user, member, 1, attachment);
    }

const profileValid = await profileScreenCheck(buffer);

if (!profileValid) {
  return rejectUser(user, member, 2, attachment);
}

    if (!db.has(cleanId)) {
      await user.send(
        `❌ You uploaded a farm account profile, or attempting to **impersonate or bypass** the system!\nYou are now locked. Please **contact an admin**.`
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
          content: `❌ ${member} has been banned from verification due to suspected farm account usage or an attempt to impersonate another player / bypass the verification system.`,
          files: [attachment.url]
        });
      }

      return;
    }

    const name = db.get(cleanId);

    try {
  await member.setNickname(name);
  console.log("Nickname changed");
} catch (err) {
  console.error("Nickname change failed:", err);
}
    if (cfg.roleId) {
      try {
  await member.roles.add(cfg.roleId);
  console.log("Role added");
} catch (err) {
  console.error("Role add failed:", err);
}
    }

    await user.send(`✅ You are now verified as **${name}**`);
pendingGuild.delete(member.id);
    const channel = await client.channels.fetch(cfg.verifyChannel);
    if (channel) {
      await channel.send({
        content: `✅ ${member} verified, an **admin** please check the profile to make sure!💗`,
        files: [attachment.url]
      });
    }
  } catch (err) {
    console.error(err);
  }
}

/* ================= REJECT SYSTEM ================= */

async function rejectUser(user, member, type, attachment) {
  const attempts = (userAttempts.get(user.id) || 0) + 1;
  userAttempts.set(user.id, attempts);

if (attempts >= 3) {

  await user.send(
    `❌ Stop uploading. Please **contact an admin**.`
  );

  // 🔒 Permanently lock user
  lockedUsers.add(user.id);

  const cfg = loadConfig();
  if (!cfg.locked) cfg.locked = [];

  if (!cfg.locked.includes(user.id)) {
    cfg.locked.push(user.id);
    saveConfig(cfg);
  }

  console.log("User auto-locked after 3 failed attempts:", user.id);

  // 📤 Send last screenshot to verify channel
  if (cfg.verifyChannel) {
    const channel = await member.guild.channels.fetch(cfg.verifyChannel).catch(() => null);

    if (channel && attachment) {
      await channel.send({
        content: `❌ ${member} failed to verify after 3 attempts.\nI cannot clearly read the Governor ID due to low quality or incorrect screenshot.\nAn **admin** please assist.`,
        files: [attachment.url]
      });
    }
  }

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
pendingGuild.set(member.id, member.guild.id);
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

🆙 Please upload a screenshot of your **Rise of Kingdoms profile** here, and i will verify it in less than a minute.
📸👉🪪

The image must be:
• A real screenshot taken by you recently  
• Full screen (no crop)  
• With visible action points, name and civ change icon
• Showing your main account (no farm accounts)

⚠️ Edited, cropped, forwarded, or fake images will result in verification lock.`
  );
} catch {}

});

  client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const cfg = loadConfig(); // 🔥 ADD THIS HERE

  /* ================= DM MESSAGES ================= */
if (!message.guild) {

  // If user is permanently locked → always reply
  if (lockedUsers.has(message.author.id)) {
    await message.channel.send(
`I'm just a bot, who verifying, please reach out to <@297057337590546434>`
    );
    return;
  }

 // If DM contains image → verification flow
if (message.attachments.size > 0) {

  const guildId = pendingGuild.get(message.author.id);
  if (!guildId) {
    await message.channel.send(
`I'm just a bot, who verifying, please reach out to <@297057337590546434>`
    );
    return;
  }

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;

  const guildMember = await guild.members.fetch(message.author.id).catch(() => null);
  if (!guildMember) return;

  // Push FIRST
  queue.push({
    member: guildMember,
    attachment: message.attachments.first()
  });

  // Now calculate correctly
  const backlog = queue.length - 1 + (processing ? 1 : 0);

  // Show realistic time (including own processing time)
  const waitTime = (backlog + 1) * PROCESS_TIME;

  await message.channel.send(
    `⏳ Please wait, I'm verifying your image.\nEstimated time: ~${waitTime} seconds`
  );

  processQueue(client);
  return;
}


    // If DM text but not image → reply
  await message.channel.send(
`I'm just a bot, who verifying, please reach out to <@297057337590546434>`
  );

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
  userAttempts.delete(user.id);
  pendingGuild.delete(user.id);
  
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
