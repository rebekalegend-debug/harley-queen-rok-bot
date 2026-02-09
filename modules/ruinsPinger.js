// modules/ruinsPinger.js
import { DateTime } from "luxon";
import { loadRuins, saveRuins } from "./storageRuins.js";

const PREFIX = "!";
const TZ = "UTC";
const CHECK_EVERY_MS = 30_000;

/* ================= UTILS ================= */

function parseLine(line) {
  // Tue, 10.2.  20:00
  const m = line
    .trim()
    .replace(/\s+/g, " ")
    .match(/(\d{1,2})\.(\d{1,2})\.\s*(\d{1,2}):(\d{2})/);

  if (!m) return null;

  const [, d, mo, h, mi] = m.map(Number);
  const now = DateTime.now().setZone(TZ);

  let dt = DateTime.fromObject(
    { year: now.year, month: mo, day: d, hour: h, minute: mi },
    { zone: TZ }
  );

  if (dt < now.minus({ minutes: 5 })) dt = dt.plus({ years: 1 });
  return dt.toISO();
}

function fmt(iso) {
  return DateTime.fromISO(iso, { zone: TZ })
    .toUTC()
    .toFormat("ccc dd.LL HH:mm 'UTC'");
}

function nextUpcoming(list) {
  const now = DateTime.now().setZone(TZ);
  return list
    .map(d => DateTime.fromISO(d, { zone: TZ }))
    .filter(d => d > now)
    .sort((a, b) => a - b)[0] || null;
}

/* ================= MODULE ================= */

export function setupRuinsPinger(client) {
  console.log("[RUINS] module registered");

  /* ============ COMMANDS ============ */
  client.on("messageCreate", async (msg) => {
    if (!msg.guild || msg.author.bot) return;
    if (!msg.content.startsWith(PREFIX)) return;

    const isAdmin = msg.member.permissions.has("ManageGuild");
    const guildId = msg.guild.id;
    const cfg = loadRuins(guildId);

    const [cmd, sub, ...rest] = msg.content.slice(1).trim().split(/\s+/);

    /* ---------- HELP ---------- */
    if (cmd === "ruins" && sub === "help") {
      return msg.reply(
        "**🗿 Ruins / 🛕 Altar Commands**\n\n" +
        "**Setup (Admin)**\n" +
        "`!ruins set channel #channel`\n" +
        "`!ruins set role @role`\n\n" +
        "**Add Dates**\n" +
        "`!ruins add` *(paste dates on new lines)*\n" +
        "`!altar add` *(paste dates on new lines)*\n\n" +
        "**View**\n" +
        "`!ruins list`\n" +
        "`!altar list`\n" +
        "`!ruins upcoming`\n" +
        "`!altar upcoming`\n\n" +
        "**Test / Maintenance**\n" +
        "`!ruins test`\n" +
        "`!altar test`\n" +
        "`!ruins clear`\n" +
        "`!altar clear`"
      );
    }

    /* ---------- SETUP ---------- */
    if (cmd === "ruins" && sub === "set") {
      if (!isAdmin) return msg.reply("❌ Admin only.");

      if (rest[0] === "channel") {
        const ch = msg.mentions.channels.first();
        if (!ch) return msg.reply("Usage: `!ruins set channel #channel`");
        cfg.channelId = ch.id;
        saveRuins(guildId, cfg);
        return msg.reply(`✅ Ruins channel set to ${ch}`);
      }

      if (rest[0] === "role") {
        const role = msg.mentions.roles.first();
        if (!role) return msg.reply("Usage: `!ruins set role @role`");
        cfg.pingRoleId = role.id;
        saveRuins(guildId, cfg);
        return msg.reply(`✅ Ruins ping role set to **${role.name}**`);
      }
    }

    /* ---------- ADD ---------- */
    if ((cmd === "ruins" || cmd === "altar") && sub === "add") {
      if (!isAdmin) return msg.reply("❌ Admin only.");

      const lines = msg.content.split("\n").slice(1);
      if (!lines.length) return msg.reply("Paste dates on new lines.");

      let added = 0;
      const list = cmd === "ruins" ? cfg.ruins : cfg.altar;

      for (const line of lines) {
        const iso = parseLine(line);
        if (iso && !list.includes(iso)) {
          list.push(iso);
          added++;
        }
      }

      saveRuins(guildId, cfg);
      return msg.reply(`✅ Added **${added}** ${cmd} dates.`);
    }

    /* ---------- LIST ---------- */
    if ((cmd === "ruins" || cmd === "altar") && sub === "list") {
      const list = cmd === "ruins" ? cfg.ruins : cfg.altar;
      if (!list.length) return msg.reply("No dates set.");

      return msg.reply(
        list
          .sort()
          .map((d, i) => `${i + 1}. ${fmt(d)}`)
          .join("\n")
      );
    }

    /* ---------- UPCOMING ---------- */
    if ((cmd === "ruins" || cmd === "altar") && sub === "upcoming") {
      const list = cmd === "ruins" ? cfg.ruins : cfg.altar;
      const next = nextUpcoming(list);
      if (!next) return msg.reply("No upcoming events.");

      return msg.reply(`⏰ **Next ${cmd.toUpperCase()}** — ${fmt(next.toISO())}`);
    }

    /* ---------- TEST ---------- */
    if ((cmd === "ruins" || cmd === "altar") && sub === "test") {
      if (!isAdmin) return msg.reply("❌ Admin only.");

      if (!cfg.channelId || !cfg.pingRoleId) {
        return msg.reply("❌ Channel or role not configured.");
      }

      const list = cmd === "ruins" ? cfg.ruins : cfg.altar;
      const next = nextUpcoming(list);
      if (!next) return msg.reply("No upcoming events to test.");

      const ch = await client.channels.fetch(cfg.channelId).catch(() => null);
      if (!ch?.isTextBased()) return msg.reply("Channel not found.");

      await ch.send(
        `<@&${cfg.pingRoleId}> **${cmd.toUpperCase()}** in **1 hour** — send march! *(TEST)*`
      );

      return msg.reply("✅ Test ping sent.");
    }

    /* ---------- CLEAR ---------- */
    if ((cmd === "ruins" || cmd === "altar") && sub === "clear") {
      if (!isAdmin) return msg.reply("❌ Admin only.");

      if (cmd === "ruins") cfg.ruins = [];
      else cfg.altar = [];

      cfg.notified = {};
      saveRuins(guildId, cfg);
      return msg.reply(`🧹 Cleared all ${cmd} dates.`);
    }
  });

  /* ============ SCHEDULER ============ */
  client.once("ready", () => {
    setInterval(async () => {
      for (const guild of client.guilds.cache.values()) {
        const cfg = loadRuins(guild.id);
        if (!cfg.channelId || !cfg.pingRoleId) continue;

        const now = DateTime.now().setZone(TZ);

        for (const [type, list] of [["ruins", cfg.ruins], ["altar", cfg.altar]]) {
          for (const iso of list) {
            if (cfg.notified[iso]) continue;

            const t = DateTime.fromISO(iso, { zone: TZ });
            const diff = t.diff(now, "minutes").minutes;

            if (diff >= 59 && diff <= 61) {
              const ch = await client.channels.fetch(cfg.channelId).catch(() => null);
              if (!ch?.isTextBased()) continue;

              await ch.send(
                `<@&${cfg.pingRoleId}> **${type.toUpperCase()}** in **1 hour** — send march!`
              );

              cfg.notified[iso] = true;
              saveRuins(guild.id, cfg);
            }
          }
        }
      }
    }, CHECK_EVERY_MS);
  });
}
