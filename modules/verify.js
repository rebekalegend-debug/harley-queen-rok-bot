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

const DATA_FILE = path.join(__dirname, "DATA.csv");
const ICON_FILES = ["1.png", "2.png", "3.png"].map((f) => path.join(__dirname, f));

const verifiedDone = new Map();
const lockedUntilRejoin = new Map();
const rejectCount = new Map();
const lockedContactAdmin = new Map();

/* ================= DM HELPER ================= */

async function safeDM(member, content) {
  try {
    await member.send(content);
  } catch {
    // user has DMs closed
  }
}

/* ================= VERIFY QUEUE ================= */

const VERIFY_TIME_PER_IMAGE = 20;
const verifyQueue = [];
let verifyRunning = false;

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function getQueuePositionIncludingRunning(userId) {
  let pos = 0;
  if (verifyRunning) pos += 1;
  for (const job of verifyQueue) {
    pos += 1;
    if (job.member.id === userId) return pos;
  }
  return null;
}

function estimateSeconds(position) {
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

    await handleVerifyResult({ message, member: freshMember, result, verifyCfg });

  } catch (e) {
    console.error("[VERIFY] queue job error:", e?.message ?? e);
    await message.delete().catch(() => {});
    await safeDM(freshMember, "❌ Something went wrong reading your screenshot. Try again.");
  }
}

/* ================= KEEP-ALIVE ================= */

let httpStarted = false;
function startHttpKeepAliveOnce() {
  if (httpStarted) return;
  httpStarted = true;

  const PORT = process.env.PORT || 8080;

  http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  }).listen(PORT, () => console.log(`🌐 HTTP server listening on ${PORT}`));
}

/* ================= PERMS ================= */

function isAdminPerm(member) {
  return member?.permissions?.has?.(PermissionFlagsBits.Administrator);
}

function isOwner(guild, userId) {
  return guild?.ownerId === userId;
}

/* ================= RESULT HANDLER ================= */

async function handleVerifyResult({ message, member, result, verifyCfg }) {

  if (!result.ok) {
    await message.delete().catch(() => {});

    const n = (rejectCount.get(member.id) ?? 0) + 1;
    rejectCount.set(member.id, n);

    if (result.reason === "NO_ID") {
      if (n >= 3) {
        lockedContactAdmin.set(member.id, true);
        await safeDM(member,
          `❌ I still can’t read your ID after **3 tries**.\n` +
          `Stop uploading. Please **contact an admin/officer** for manual verification.`
        );
        return;
      }

      await safeDM(member,
        `❌ I couldn’t read your **Governor ID**.\n` +
        `Upload a clearer full profile screenshot (no crop).\n` +
        `Attempts: **${n}/3**`
      );
      return;
    }

    if (result.reason === "MISSING_ICONS") {
      if (n >= 3) {
        lockedContactAdmin.set(member.id, true);
        await safeDM(member,
          `❌ Screenshot rejected **3 times**.\n` +
          `Stop uploading. Please **contact an admin/officer** for manual verification.`
        );
        return;
      }

      await safeDM(member,
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

      await safeDM(member,
        `❌ Your ID (**${result.govId}**) is not in our database.\n` +
        `You are now locked. Please **contact an admin/officer**.`
      );
      return;
    }

    if (result.reason === "CSV_ERROR") {
      await safeDM(member, `❌ Database error. Contact an admin.`);
      return;
    }

    if (result.reason === "BOT_MISSING_PERMS") {
      await safeDM(member, `❌ Bot missing permissions (Manage Nicknames / Manage Roles).`);
      return;
    }

    await safeDM(member, `❌ Verification failed. Upload again.`);
    return;
  }

  verifiedDone.set(member.id, true);

  await safeDM(member,
    `✅ Verified ${member} as **${result.cleanName}** (ID: ${result.govId}). Role granted.`
  );
}

/* ===================== EXPORT ===================== */

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

    if (!message.guild) {
      if (message.author.id === HARLEY_QUINN_USER_ID) return;
      return message.reply(
`Hi! I’m just a bot 🤖

Please contact <@${HARLEY_QUINN_USER_ID}> for help.`
      ).catch(() => {});
    }

    const guildId = message.guild.id;
    const verifyCfg = getGuild(guildId).verify || {};

    if (!verifyCfg.channelId || message.channel.id !== verifyCfg.channelId) return;

    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member) return message.delete().catch(() => {});

    if (lockedContactAdmin.get(member.id)) return message.delete().catch(() => {});
    if (lockedUntilRejoin.get(member.id)) return message.delete().catch(() => {});
    if (verifyCfg.roleId && member.roles.cache.has(verifyCfg.roleId)) {
      return message.delete().catch(() => {});
    }

    const imgAtt = message.attachments.find(a =>
      a.contentType?.startsWith("image/")
    );

    if (!imgAtt) return message.delete().catch(() => {});
    if (verifiedDone.get(member.id)) return message.delete().catch(() => {});
    if (isUserAlreadyQueued(member.id)) return message.delete().catch(() => {});
    if (!verifyCfg.roleId) return;

    verifyQueue.push({ message, member, verifyCfg, attachment: imgAtt });

    const position = getQueuePositionIncludingRunning(member.id) ?? 1;
    const eta = estimateSeconds(position);

    await safeDM(member,
      `⏳ Please wait, I'm verifying your image…\n` +
      `You are **${ordinal(position)} in queue**.\n` +
      `Estimated time: **~${eta} seconds**.`
    );

    processVerifyQueue();
  });
}
