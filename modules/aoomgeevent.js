import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import ical from "node-ical";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/* ================= CONFIG ================= */

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
const AOO_COMMAND_ROLE_ID = "1470999999999999"; // 🔒 ONLY THIS ROLE CAN USE !aoo

/* ================= STATE (IN-MEMORY) ================= */

const scheduled = [];

/* ================= HELPERS ================= */

const hasRole = (m, id) => m?.roles?.cache?.has(id);

const formatUTC = (d) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(
    d.getUTCMinutes()
  ).padStart(2, "0")} UTC`;

const addHours = (d, h) => new Date(d.getTime() + h * 3600000);

async function fetchEvents() {
  const data = await ical.fromURL(ICS_URL);
  return Object.values(data).filter((e) => e?.type === "VEVENT");
}

function getEventType(ev) {
  const txt = [ev.summary, ev.description].filter(Boolean).join("\n");
  const m = txt.match(/Type:\s*([a-z0-9_]+)/i);
  return m ? m[1].toLowerCase() : null;
}

/* ================= AOO DROPDOWN ================= */

function buildDateSelect(start, end) {
  const opts = [];
  const d = new Date(start);
  d.setUTCHours(0, 0, 0, 0);

  while (d < end) {
    const iso = d.toISOString().slice(0, 10);
    opts.push({ label: iso, value: iso });
    d.setUTCDate(d.getUTCDate() + 1);
  }

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`aoo_date|${start.getTime()}|${end.getTime()}`)
      .setPlaceholder("Select AOO date (UTC)")
      .addOptions(opts.slice(0, 25))
  );
}

function buildHourSelect(dateISO, startMs, endMs) {
  const [y, m, d] = dateISO.split("-").map(Number);
  const opts = [];

  for (let h = 0; h < 24; h++) {
    const t = Date.UTC(y, m - 1, d, h);
    if (t >= startMs && t < endMs) {
      opts.push({ label: `${String(h).padStart(2, "0")}:00 UTC`, value: String(h) });
    }
  }

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`aoo_hour|${dateISO}|${startMs}|${endMs}`)
      .setPlaceholder("Select start hour")
      .addOptions(opts)
  );
}

/* ================= MODULE ================= */

export function setupAooMgeEvent(client) {
  loadConfig();

  /* ===== SCHEDULER ===== */

  setInterval(async () => {
    const now = Date.now();
    for (const item of scheduled.splice(0)) {
      if (now >= item.at) {
        const ch = await client.channels.fetch(item.channelId);
        if (ch?.isTextBased()) await ch.send(item.msg);
      } else {
        scheduled.push(item);
      }
    }
  }, 30_000);

  /* ===== DROPDOWNS ===== */

  client.on("interactionCreate", async (i) => {
    if (!i.isStringSelectMenu()) return;

    if (!hasRole(i.member, AOO_COMMAND_ROLE_ID)) {
      await i.reply({ content: "❌ You are not allowed to use AOO scheduling.", ephemeral: true });
      return;
    }

    if (i.customId.startsWith("aoo_date")) {
      const [, s, e] = i.customId.split("|");
      await i.update({
        content: "Select AOO start hour (UTC)",
        components: [buildHourSelect(i.values[0], Number(s), Number(e))],
      });
    }

    if (i.customId.startsWith("aoo_hour")) {
      const [, dateISO, s] = i.customId.split("|");
      const hour = Number(i.values[0]);
      const [y, m, d] = dateISO.split("-").map(Number);
      const start = Date.UTC(y, m - 1, d, hour);

      scheduled.push(
        { at: start - 30 * 60000, channelId: i.channelId, msg: `${PING}\nAOO starts in **30 minutes**` },
        { at: start - 10 * 60000, channelId: i.channelId, msg: `${PING}\nAOO starts in **10 minutes**` }
      );

      await i.update({ content: `✅ AOO scheduled for **${formatUTC(new Date(start))}**`, components: [] });
    }
  });

  /* ===== COMMANDS ===== */

  client.on("messageCreate", async (msg) => {
    if (!msg.guild || msg.author.bot) return;
    if (!msg.content.startsWith(PREFIX)) return;
    if (!hasRole(msg.member, AOO_ROLE_ID)) return;

    const cmd = msg.content.slice(1).trim();

    if (cmd === "set_channel") {
      const ch = msg.mentions.channels.first();
      if (!ch) return msg.reply("Usage: `!set_channel #channel`");
      config.channelId = ch.id;
      saveConfig();
      return msg.reply(`✅ Announcement channel set to ${ch}`);
    }

    if (cmd === "aoo") {
      if (!hasRole(msg.member, AOO_COMMAND_ROLE_ID)) {
        return msg.reply("❌ You are not allowed to schedule AOO.");
      }

      const ev = (await fetchEvents()).find(
        (e) => ["ark_battle", "aoo"].includes(getEventType(e))
      );

      if (!ev) return msg.reply("No upcoming AOO event found.");

      await msg.reply({
        content: "Select AOO date (UTC)",
        components: [buildDateSelect(new Date(ev.start), new Date(ev.end))],
      });
    }

    if (cmd === "help") {
      await msg.reply(
        "```" +
          [
            "!aoo  (restricted role)",
            "!set_channel #channel",
          ].join("\n") +
          "```"
      );
    }
  });
}
