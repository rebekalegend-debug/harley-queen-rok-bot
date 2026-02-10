// modules/aooMge.js
import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  GatewayIntentBits,
} from "discord.js";
import ical from "node-ical";
import fs from "fs";
import path from "path";

/* ================= CONFIG & STORAGE ================= */

const PREFIX = "!";
const CHECK_MIN = 10;
const DATA_DIR = process.env.STATE_DIR ?? "/data";
const CFG_FILE = path.join(DATA_DIR, "aooMgeConfig.json");
const STATE_FILE = path.join(DATA_DIR, "aooMgeState.json");
const ICS_URL = process.env.ICS_URL;

fs.mkdirSync(DATA_DIR, { recursive: true });

const load = (f, d) => {
  try { return JSON.parse(fs.readFileSync(f)); }
  catch { return d; }
};

let config = load(CFG_FILE, { channelId: null, aooRoleId: null, mgeRoleId: null });
let state = load(STATE_FILE, { sent: {}, scheduled: [] });

const save = () => {
  fs.writeFileSync(CFG_FILE, JSON.stringify(config, null, 2));
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
};

/* ================= HELPERS ================= */

const canUseAoo = (member) =>
  member.permissions.has("Administrator") ||
  (config.aooRoleId && member.roles.cache.has(config.aooRoleId));


const isAdmin = (m) => m.permissions.has("Administrator");
const canUseAoo = (member) => {
  if (member.permissions.has("Administrator")) return true;
  if (!config.aooRoleId) return false;
  return member.roles.cache.has(config.aooRoleId);
};

const utc = (d) => d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
const hours = (d, h) => new Date(d.getTime() + h * 36e5);

const eventType = (ev) => {
  const t = [ev.summary, ev.description].join("\n");
  const m = t.match(/Type:\s*(\w+)/i);
  return m?.[1]?.toLowerCase();
};

const key = (p, ev, s) =>
  `${p}_${ev.uid}_${ev.start.toISOString().slice(0, 10)}_${s}`;

async function events() {
  const cal = await ical.fromURL(ICS_URL);
  return Object.values(cal).filter(e => e.type === "VEVENT");
}

/* ================= MAIN MODULE ================= */

export function setupAooMge(client) {

  /* ===== READY LOOP ===== */

  client.once("ready", async () => {
    await run(false);
    setInterval(() => run(true), CHECK_MIN * 60 * 1000);
    setInterval(processScheduled, 30_000);
  });

  /* ===== MESSAGE COMMANDS ===== */

  client.on("messageCreate", async (msg) => {
    if (!msg.guild || msg.author.bot || !msg.content.startsWith(PREFIX)) return;

// AFTER !set handling
if (!config.channelId || !config.aooRoleId || !config.mgeRoleId)
  return msg.reply("❌ Bot not configured. Use `!set` commands.");

if (!canUseAoo(msg.member))
  return msg.reply("❌ You need **Admin** or **AOO role**.");

    
    const [cmd, ...args] = msg.content.slice(1).split(/\s+/);

    /* --- SETUP --- */
    if (cmd === "set") {
      if (!isAdmin(msg.member)) return msg.reply("❌ Admin only");

      if (args[0] === "channel") {
        config.channelId = msg.channel.id;
      } else if (args[0] === "aoo_role") {
        config.aooRoleId = msg.mentions.roles.first()?.id;
      } else if (args[0] === "mge_role") {
        config.mgeRoleId = msg.mentions.roles.first()?.id;
      } else {
        return msg.reply("Usage:\n!set channel\n!set aoo_role @role\n!set mge_role @role");
      }

      save();
      return msg.reply("✅ Configuration updated");
    }

    if (!config.channelId || !config.aooRoleId || !config.mgeRoleId)
      return msg.reply("❌ Bot not configured. Use `!set` commands.");

    if (!canUseAoo(msg.member))
  return msg.reply("❌ You need **Admin** or **AOO role** to use this command.");


    if (cmd === "ping") return msg.reply("pong");
    if (cmd === "help") return msg.reply("```!aoo\n!scheduled_list\n!ping```");

    if (cmd === "scheduled_list") {
      if (!state.scheduled.length) return msg.reply("No scheduled reminders.");
      return msg.reply(
        "```" +
        state.scheduled
          .map((s, i) => `${i + 1}) ${utc(new Date(s.runAt))}`)
          .join("\n") +
        "```"
      );
    }

    if (cmd === "aoo") {
      const ev = (await events()).find(e =>
        ["ark_battle", "aoo"].includes(eventType(e))
      );
      if (!ev) return msg.reply("No AOO found.");

      const dates = [];
      let d = new Date(ev.start);
      while (d < ev.end) {
        dates.push(d.toISOString().slice(0, 10));
        d = hours(d, 24);
      }

      const menu = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`aoo|${ev.start}|${ev.end}`)
          .setPlaceholder("Select AOO date")
          .addOptions(dates.map(x => ({ label: x, value: x })))
      );

      return msg.reply({
        content: `AOO window: ${utc(new Date(ev.start))} → ${utc(new Date(ev.end))}`,
        components: [menu],
      });
    }
  });

  /* ===== INTERACTIONS ===== */

  client.on("interactionCreate", async (i) => {
    if (!i.isStringSelectMenu()) return;
    if (!canUseAoo(i.member)) return i.reply({ content: "❌ AOO role required", ephemeral: true });

    const [_, start, end] = i.customId.split("|");
    const date = i.values[0];

    const hoursRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`hour|${start}|${end}|${date}`)
        .setPlaceholder("Select hour UTC")
        .addOptions([...Array(24)].map((_, h) => ({
          label: `${h.toString().padStart(2, "0")}:00`,
          value: String(h),
        })))
    );

    if (_.startsWith("aoo")) {
      return i.update({ content: `Date: ${date}`, components: [hoursRow] });
    }

    if (_.startsWith("hour")) {
      const h = Number(i.values[0]);
      const t = new Date(`${date}T${h.toString().padStart(2, "0")}:00Z`).getTime();

      state.scheduled.push(
        { runAt: t - 30 * 60e3, text: "AOO in 30 minutes!" },
        { runAt: t - 10 * 60e3, text: "AOO in 10 minutes!" }
      );

      save();
      return i.update({ content: "✅ AOO reminders scheduled", components: [] });
    }
  });

  /* ===== ANNOUNCEMENTS ===== */

  async function run(send) {
    if (!config.channelId) return;
    const ch = await client.channels.fetch(config.channelId);
    if (!ch?.isTextBased()) return;

    for (const ev of await events()) {
      const t = eventType(ev);
      if (!["ark_registration", "mge"].includes(t)) continue;

      const start = new Date(ev.start);
      const end = new Date(ev.end);

      if (t === "ark_registration") {
        fire(ch, ev, "open", start, "AOO registration OPEN", send);
        fire(ch, ev, "warn", hours(end, -6), "AOO registration closing soon", send);
        fire(ch, ev, "close", end, "AOO registration CLOSED", send);
      }

      if (t === "mge") {
        fire(ch, ev, "open", hours(end, 24), "MGE registration OPEN", send);
        fire(ch, ev, "warn", hours(start, -48), "MGE closes in 24h", send);
        fire(ch, ev, "close", hours(start, -24), "MGE registration CLOSED", send);
      }
    }
    save();
  }

  function fire(ch, ev, s, time, text, send) {
    const k = key("ANN", ev, s);
    if (state.sent[k] || Date.now() < time) return;
    if (send) ch.send(text);
    state.sent[k] = true;
  }

  function processScheduled() {
    const now = Date.now();
    state.scheduled = state.scheduled.filter(s => {
      if (now >= s.runAt) {
        client.channels.fetch(config.channelId)
          .then(c => c?.send(s.text));
        return false;
      }
      return true;
    });
    save();
  }
}

