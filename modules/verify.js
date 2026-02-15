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

const pendingGuild = new Map(); // userId -> guildId
const DATA_FILE = path.join(__dirname, "DATA.csv");
const CONFIG_DIR = "/data/verify";
const ID_ANCHOR = path.join(__dirname, "id_anchor.png");
const dmSuccess = new Map(); // userId -> boolean

const PROFILE_KEYWORDS = [

  // English
  "troop", "troops", "action", "akcje", "acton",

  // French
  "troupe", "troupes", "action",

  // German
  "truppe", "truppen", "aktion",

  // Russian
  "войска", "войско", "действие",

  // Portuguese
  "tropa", "tropas", "acao", "ação",

  // Spanish
  "tropa", "tropas", "accion", "acción",

  // Italian
  "truppa", "truppe", "azione",

  // Polish
  "wojsko", "wojska", "akcja",

  // Indonesian
  "pasukan", "aksi",

  // Malay
  "pasukan", "aksi",

  // Turkish
  "birlik", "birlikler", "eylem",

  // Vietnamese
  "quan", "hanh dong",

  // Thai
  "กองทัพ", "การกระทำ",

  // Arabic
  "القوات", "قوات", "عمل",

  // Korean
  "부대", "행동",

  // Japanese
  "部隊", "行動",

  // Simplified Chinese
  "部队", "行动",

  // Traditional Chinese
  "部隊", "行動"
];




if (!fs.existsSync("/data")) {
  fs.mkdirSync("/data", { recursive: true });
}
if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
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

function getConfigPath(guildId) {
  return path.join(CONFIG_DIR, `${guildId}.json`);
}

function loadConfig(guildId) {
  const file = getConfigPath(guildId);

  if (!fs.existsSync(file)) {
    const defaultConfig = {
      verifyChannel: null,
      roleId: null,
      locked: []
    };
    fs.writeFileSync(file, JSON.stringify(defaultConfig, null, 2));
    return defaultConfig;
  }

  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveConfig(guildId, config) {
  const file = getConfigPath(guildId);
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
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
// Save raw OCR text for later profile validation
extractGovernorId.lastOcrText = data.text;
  
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

  const { data } = await Tesseract.recognize(processed, "eng+chi_sim+chi_tra+jpn+kor+ara+rus")

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
  const cfg = loadConfig(member.guild.id);
  const db = loadDatabase();
console.log("Config loaded:", loadConfig(member.guild.id));

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

// 🔎 Check profile text using SAME OCR result (no new OCR call)
const ocrText = (extractGovernorId.lastOcrText || "").toLowerCase();

const hasProfileText = PROFILE_KEYWORDS.some(word =>
  ocrText.includes(word)
);


if (!hasProfileText) {
  console.log("❌ ID found but no Troops/Action text detected in OCR log.");
  return rejectUser(user, member, 2, attachment);
}


   if (!db.has(cleanId)) {
  await user.send(
    `❌ You uploaded a farm account profile, or attempting to **impersonate or bypass** the system!
You are now locked. Please contact an admin.`
  );

  const cfg = loadConfig(member.guild.id);

  if (!cfg.locked) cfg.locked = [];

  if (!cfg.locked.includes(user.id)) {
    cfg.locked.push(user.id);
    saveConfig(member.guild.id, cfg);
  }

  console.log("User permanently locked:", user.id);
console.log("Verifying in guild:", member.guild.id);

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

    console.log("Role ID from config:", cfg.roleId);
console.log("Guild:", member.guild.id);
try {
  await member.roles.add(cfg.roleId);
  console.log("Role successfully added.");
} catch (err) {
  console.error("Role add error:", err);
}
    }

    await user.send(`✅ You are now verified as **${name}**`);
pendingGuild.delete(member.id);
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
  const cfg = loadConfig(member.guild.id);

if (!cfg.locked) cfg.locked = [];

if (!cfg.locked.includes(user.id)) {
  cfg.locked.push(user.id);
  saveConfig(member.guild.id, cfg);
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

  /* ================= MEMBER JOIN ================= */

  client.on(Events.GuildMemberAdd, async (member) => {

    pendingGuild.set(member.id, member.guild.id);

    const cfg = loadConfig(member.guild.id);

    if (cfg.locked && cfg.locked.includes(member.id)) {
      try {
        await member.send("🚫 You are banned from verification. Contact an admin.");
      } catch {}
      return;
    }

    try {
      await member.send(
`Welcome ${member} 💗!

🆙 Please upload your Rise of Kingdoms profile screenshot here.

⚠️ Cropped / edited images will result in verification lock.`
      );

      dmSuccess.set(member.id, true);

    } catch {
      dmSuccess.set(member.id, false);
    }

  });

  /* ================= MESSAGE CREATE ================= */

  client.on(Events.MessageCreate, async (message) => {

    if (message.author.bot) return;

    const isDM = !message.guild;

    /* ========= DM HANDLING ========= */

    if (isDM) {

      // check locked across guilds
      for (const guild of client.guilds.cache.values()) {
        const cfg = loadConfig(guild.id);
        if (cfg.locked && cfg.locked.includes(message.author.id)) {
          await message.channel.send("I'm just a bot, please contact admin.");
          return;
        }
      }

      if (message.attachments.size > 0) {

        let guildMember = null;

        for (const guild of client.guilds.cache.values()) {
          const m = await guild.members.fetch(message.author.id).catch(() => null);
          if (m) {
            guildMember = m;
            break;
          }
        }

        if (!guildMember) return;

        queue.push({
          member: guildMember,
          attachment: message.attachments.first()
        });

        await message.channel.send("⏳ Verifying your image...");
        processQueue(client);
      }

      return;
    }

    /* ========= GUILD HANDLING ========= */

    const cfg = loadConfig(message.guild.id);
    const member = message.member;

    if (!member) return;

    // ================= COMMANDS =================

if (message.content.startsWith("!verify set channel")) {
  if (!member.permissions.has(PermissionFlagsBits.Administrator)) return;

  cfg.verifyChannel = message.channel.id;
  saveConfig(message.guild.id, cfg);

  return message.reply("✅ Verify log channel set.");
}

if (message.content.startsWith("!verify set role")) {
  if (!member.permissions.has(PermissionFlagsBits.Administrator)) return;

  const role = message.mentions.roles.first();
  if (!role) return message.reply("Mention a role.");

  cfg.roleId = role.id;
  saveConfig(message.guild.id, cfg);

  return message.reply("✅ Verify role set.");
}

if (message.content === "!verify status") {
  return message.reply(
    `Verify Channel: ${cfg.verifyChannel || "Not set"}
Role: ${cfg.roleId ? `<@&${cfg.roleId}>` : "Not set"}`
  );
}

if (message.content.startsWith("!verify unlock")) {
  if (!member.permissions.has(PermissionFlagsBits.Administrator)) return;

  const user = message.mentions.users.first();
  if (!user) return message.reply("Mention a user.");

  cfg.locked = (cfg.locked || []).filter(id => id !== user.id);
  saveConfig(message.guild.id, cfg);

  return message.reply("✅ User unlocked.");
}

if (message.content === "!verify locked") {
  if (!member.permissions.has(PermissionFlagsBits.Administrator)) return;

  const list = cfg.locked || [];
  if (list.length === 0) return message.reply("No locked users.");

  return message.reply(
    "🔒 Locked Users:\n" + list.map(id => `<@${id}>`).join("\n")
  );
}

    
    const isVerified = cfg.roleId && member.roles.cache.has(cfg.roleId);
    if (isVerified) return;

    if (dmSuccess.has(member.id)) {

      const worked = dmSuccess.get(member.id);

      if (worked) {
        await message.reply("Please check your private messages for verification.");
      } else {
        await message.reply("Please enable DMs and rejoin the server to receive verification message.");
      }

      return;
    }

  });

}


    
