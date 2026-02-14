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

const DATA_FILE = path.join(__dirname, "data.csv");
const CONFIG_FILE = path.join(__dirname, "verify.config.json");

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
    return { verifyChannel: null, roleId: null };
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

async function extractGovernorId(buffer) {
  const image = sharp(buffer);
  const metadata = await image.metadata();

  const width = metadata.width;
  const height = metadata.height;

  // Crop upper-left profile area
  const cropped = await image
    .extract({
      left: Math.floor(width * 0.05),
      top: Math.floor(height * 0.15),
      width: Math.floor(width * 0.45),
      height: Math.floor(height * 0.25)
    })
    .resize({ width: 1400 })
    .grayscale()
    .normalize()
    .sharpen()
    .threshold(150)
    .toBuffer();

  const { data } = await Tesseract.recognize(cropped, "eng");

  console.log("=== ID AREA OCR TEXT ===");
  console.log(data.text);

  // Merge all digits (handles split digits)
  const digits = data.text.replace(/\D/g, "");

  const match = digits.match(/\d{7,12}/);

  if (!match) return null;

  return match[0];
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
      width: Math.floor(width * 0.45),
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

    const governorId = await extractGovernorId(buffer);

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

      const channel = await client.channels.fetch(cfg.verifyChannel);
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

  client.on(Events.GuildMemberAdd, async (member) => {
    try {
      await member.send(
        `Welcome ${member}💗!\n🆙 Please upload a screenshot of your **Rise of Kingdoms profile** here.\n📸👉🪪.`
      );
    } catch {}
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    const cfg = loadConfig();

    /* CLEAN VERIFY CHANNEL */
    if (message.channel.id === cfg.verifyChannel && message.guild) {
      await message.delete().catch(() => {});
    }

    /* ADMIN COMMANDS */
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

/* DM IMAGE HANDLER */
if (!message.guild && message.attachments.size > 0) {
  const guild = client.guilds.cache.first();
  if (!guild) return;

  const member = await guild.members.fetch(message.author.id).catch(() => null);
  if (!member) {
    console.log("Member not found in guild");
    return;
  }

  const position = queue.length;
  const waitTime = position * PROCESS_TIME;

  await message.author.send(
    `⏳ Please wait, I'm verifying your image.\nEstimated time: ~${waitTime} seconds`
  );

  queue.push({
    member,
    attachment: message.attachments.first()
  });

  processQueue(client);
}
  });
}
