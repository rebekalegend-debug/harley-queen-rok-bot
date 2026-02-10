import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import ical from "node-ical";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/* ================= MODULE CONFIG ================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_FILE = path.join(__dirname, "aoomgeevent.config.json");

let config = { channelId: null };

function loadConfig() {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  }
}
function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/* ================= CONSTANTS ================= */

const ICS_URL =
  "https://calendar.google.com/calendar/ical/5589780017d3612c518e01669b77b70f667a6cee4798c961dbfb9cf1119811f3@group.calendar.google.com/public/basic.ics";

const PREFIX = "!";
const PING = "@everyone";

const AOO_ROLE_ID = "1470120925856006277";
const MGE_ROLE_ID = "1470122737002610760";
const MGE_CHANNEL_ID = "1469846200042917918";

const AOO_ROLE_MENTION = `<@&${AOO_ROLE_ID}>`;
const MGE_ROLE_MENTION = `<@&${MGE_ROLE_ID}>`;
const MGE_CHANNEL_MENTION = `<#${MGE_CHANNEL_ID}>`;

/* ================= HELPERS ================= */

const hasAooRole = (m) => m?.roles?.cache?.has(AOO_ROLE_ID);

const formatUTC = (d) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(
    d.getUTCMinutes()
  ).padStart(2, "0")} UTC`;

function getEventType(ev) {
  const text = [ev.description, ev.summary, ev.location].filter(Boolean).join("\n");
  const m = text.match(/Type:\s*([a-z0-9_]+)/i);
  return m ? m[1].toLowerCase() : null;
}

async function fetchEvents() {
  const data = await ical.fromURL(ICS_URL);
  return Object.values(data).filter((e) => e?.type === "VEVENT");
}

/* ================= MESSAGES ================= */

const aooOpen = () =>
  `AOO registration is opened, reach out to ${AOO_ROLE_MENTION}!`;

const mgeOpen = () =>
  `MGE registration is open. Register in ${MGE_CHANNEL_MENTION} or contact ${MGE_ROLE_MENTION}!`;

/* ================= MAIN MODULE ================= */

export function setupAooMgeEvent(client) {
  loadConfig();

  client.on("messageCreate", async (msg) => {
    if (!msg.guild || msg.author.bot) return;
    if (!msg.content.startsWith(PREFIX)) return;
    if (!hasAooRole(msg.member)) {
      await msg.reply("❌ You need the **AOO role**.");
      return;
    }

    const cmd = msg.content.slice(1).trim().toLowerCase();

    /* ---------- CONFIG COMMANDS ---------- */

    if (cmd.startsWith("set_channel")) {
      if (!msg.member.permissions.has("Administrator")) {
        await msg.reply("❌ Admin only.");
        return;
      }
      const ch = msg.mentions.channels.first();
      if (!ch) {
        await msg.reply("Usage: `!set_channel #channel`");
        return;
      }
      config.channelId = ch.id;
      saveConfig();
      await msg.reply(`✅ Announcement channel set to ${ch}`);
      return;
    }

    if (cmd === "show_channel") {
      if (!config.channelId) {
        await msg.reply("⚠️ Announcement channel not set.");
        return;
      }
      await msg.reply(`📢 Announcement channel: <#${config.channelId}>`);
      return;
    }

    /* ---------- INFO ---------- */

    if (cmd === "ping") {
      await msg.reply("pong");
      return;
    }

    if (cmd === "help") {
      await msg.reply(
        "```" +
          [
            "!ping",
            "!set_channel #channel",
            "!show_channel",
          ].join("\n") +
          "```"
      );
      return;
    }
  });

  /* ---------- AUTO ANNOUNCER ---------- */

  client.once("ready", async () => {
    if (!config.channelId) return;

    const channel = await client.channels.fetch(config.channelId);
    if (!channel?.isTextBased()) return;

    const events = await fetchEvents();

    for (const ev of events) {
      const type = getEventType(ev);
      if (type === "ark_registration") {
        await channel.send(`${PING}\n${aooOpen()}`);
      }
      if (type === "mge") {
        await channel.send(`${PING}\n${mgeOpen()}`);
      }
    }
  });
}
