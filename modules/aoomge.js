// modules/aoomge.js
import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  Events,
  PermissionFlagsBits,
} from "discord.js";
import ical from "node-ical";
import fs from "fs";

const PREFIX = "!aoo";
const ICS_URL =
  "https://calendar.google.com/calendar/ical/5589780017d3612c518e01669b77b70f667a6cee4798c961dbfb9cf1119811f3%40group.calendar.google.com/public/basic.ics";

const CONFIG_FILE = "./modules/aoomge.config.json";

/* ========== CONFIG STORAGE ========== */

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveConfig(c) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
}

/* ========== HELPERS ========== */

function isAdmin(m) {
  return m.permissions.has(PermissionFlagsBits.Administrator);
}

function schedule(channel, when, text) {
  const delay = when - Date.now();
  if (delay <= 0) return;
  setTimeout(() => channel.send(text), delay);
}

function isArk(e) {
  const n = e.summary?.toLowerCase() ?? "";
  return n.includes("ark of osiris") || (n.includes("ark") && n.includes("battle"));
}
function isMGE(e) {
  return e.summary?.toLowerCase().includes("mightiest");
}

/* ========== MAIN ========== */

export function setupAooMge(client) {
  client.on(Events.MessageCreate, async (msg) => {
    if (!msg.guild || msg.author.bot) return;

    const cfg = loadConfig();
    cfg[msg.guild.id] ??= {};
    const g = cfg[msg.guild.id];

    /* ===== SET COMMANDS (ADMIN) ===== */
    if (msg.content.startsWith(`${PREFIX} set`)) {
      if (!isAdmin(msg.member)) return;

      const [, , key, mention] = msg.content.split(" ");
      const id = mention?.replace(/\D/g, "");
      if (!id) return msg.reply("❌ Invalid mention.");

      if (key === "pingchannel") g.pingChannel = id;
      if (key === "aoorole") g.aooRole = id;
      if (key === "mgerole") g.mgeRole = id;
      if (key === "accessrole") g.accessRole = id;

      saveConfig(cfg);
      return msg.reply("✅ Config updated.");
    }

    /* ===== !aoo DROPDOWN ===== */
    if (msg.content === PREFIX) {
      if (
        !isAdmin(msg.member) &&
        (!g.accessRole || !msg.member.roles.cache.has(g.accessRole))
      ) {
        return msg.reply("❌ No access.");
      }

      const data = await ical.async.fromURL(ICS_URL);
      const now = new Date();

      const ark = Object.values(data)
        .filter(e => e.type === "VEVENT" && isArk(e) && e.start > now)
        .sort((a, b) => a.start - b.start)[0];

      if (!ark) return msg.reply("❌ No upcoming Ark.");

      const day1 = new Date(ark.start);
      const day2 = new Date(day1.getTime() + 86400000);

      const menu = new StringSelectMenuBuilder()
        .setCustomId("aoo_day")
        .setPlaceholder("Select Ark day (UTC)")
        .addOptions([
          { label: "Ark Day 1", value: day1.getTime().toString() },
          { label: "Ark Day 2", value: day2.getTime().toString() },
        ]);

      return msg.reply({
        content: "🛡️ Select Ark Battle day:",
        components: [new ActionRowBuilder().addComponents(menu)],
      });
    }
  });

  /* ===== INTERACTIONS ===== */
  client.on(Events.InteractionCreate, async (i) => {
    if (!i.isStringSelectMenu()) return;

    const cfg = loadConfig()[i.guild.id];
    const channel = await i.guild.channels.fetch(cfg.pingChannel);

    if (i.customId === "aoo_day") {
      const base = new Date(Number(i.values[0]));
      const hours = Array.from({ length: 24 }, (_, h) => ({
        label: `${String(h).padStart(2, "0")}:00 UTC`,
        value: `${base.getTime()}|${h}`,
      }));

      const menu = new StringSelectMenuBuilder()
        .setCustomId("aoo_hour")
        .setPlaceholder("Select hour")
        .addOptions(hours);

      return i.update({
        content: "🕒 Select hour:",
        components: [new ActionRowBuilder().addComponents(menu)],
      });
    }

    if (i.customId === "aoo_hour") {
      const [base, h] = i.values[0].split("|");
      const d = new Date(Number(base));
      d.setUTCHours(Number(h), 0, 0, 0);

      schedule(
        channel,
        d,
        `@everyone ⏰ **ARK OF OSIRIS STARTING!**\n🗓️ ${d.toUTCString()}`
      );

      return i.update({ content: "✅ AOO reminder set.", components: [] });
    }
  });

  /* ===== AUTO REGISTRATION REMINDERS (ON READY) ===== */
  client.once(Events.ClientReady, async () => {
    const data = await ical.async.fromURL(ICS_URL);
    const now = new Date();

    for (const [guildId, g] of Object.entries(loadConfig())) {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild || !g.pingChannel) continue;

      const ch = await guild.channels.fetch(g.pingChannel);

      const ark = Object.values(data)
        .filter(e => e.type === "VEVENT" && isArk(e) && e.start > now)
        .sort((a, b) => a.start - b.start)[0];

      if (ark) {
        const start = new Date(ark.start);
        const end = new Date(start.getTime() + 48 * 3600000);

        schedule(ch, start, `📢 AOO registration is opened, reach out to <@&${g.aooRole}> for registration!`);
        schedule(ch, end - 6 * 3600000, "⏳ AOO registration will close soon!");
        schedule(ch, end, "🔒 AOO registration closed");
      }

      const mge = Object.values(data)
        .filter(e => e.type === "VEVENT" && isMGE(e))
        .sort((a, b) => a.start - b.start)[0];

      if (mge) {
        const s = new Date(mge.start);
        const e = new Date(mge.end);

        schedule(ch, e.getTime() + 24 * 3600000,
          `🟢 MGE registration is open, register in <#${g.pingChannel}> or reach out to <@&${g.mgeRole}>!`
        );
        schedule(ch, s.getTime() - 48 * 3600000, "⏳ MGE registration closes in 24 hours!");
        schedule(ch, s.getTime() - 24 * 3600000, "🔒 MGE registration is closed");
      }
    }
  });
}
