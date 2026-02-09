// modules/ruinsPinger.js
import { DateTime } from "luxon";
import { loadRuins, saveRuins } from "./storageRuins.js";

const PREFIX = "!";
const TZ = "UTC";
const CHECK_EVERY_MS = 30_000;

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
  return DateTime.fromISO(iso).toUTC().toFormat("ccc dd.LL HH:mm 'UTC'");
}

export function setupRuinsPinger(client) {
  console.log("[RUINS] module registered");

  // ================= COMMANDS =================
  client.on("messageCreate", async (msg) => {
    if (!msg.guild || msg.author.bot) return;
    if (!msg.content.startsWith(PREFIX)) return;

    const isAdmin = msg.member.permissions.has("ManageGuild");
    const guildId = msg.guild.id;
    const cfg = loadRuins(guildId);

    const [cmd, sub, ...rest] = msg.content
      .slice(1)
      .split(/\s+/);


    if (cmd === "ruins" && sub === "help") {
  return msg.reply(
    "**🗿 Ruins / Altar Commands**\n\n" +
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
    "`!ruins all`\n\n" +
    "**Maintenance**\n" +
    "`!ruins test`\n" +
    "`!ruins clear`\n" +
    "`!altar clear`\n" +
    "`!ruins clear notified`"
  );
}
    // ---------- SETUP ----------
    if (cmd === "ruins") {
      if (!isAdmin) return msg.reply("❌ Admin only.");

      if (sub === "set" && rest[0] === "channel") {
        const ch = msg.mentions.channels.first();
        if (!ch) return msg.reply("Usage: `!ruins set channel #channel`");
        cfg.channelId = ch.id;
        saveRuins(guildId, cfg);
        return msg.reply(`✅ Ruins channel set to ${ch}`);
      }

      if (sub === "set" && rest[0] === "role") {
        const role = msg.mentions.roles.first();
        if (!role) return msg.reply("Usage: `!ruins set role @role`");
        cfg.pingRoleId = role.id;
        saveRuins(guildId, cfg);
        return msg.reply(`✅ Ruins ping role set to **${role.name}**`);
      }

      if (sub === "show") {
        return msg.reply(
          cfg.channelId
            ? `📍 Channel: <#${cfg.channelId}>\n🔔 Role: <@&${cfg.pingRoleId}>`
            : "❌ Ruins pinger not configured yet."
        );
      }
    }

    // ---------- ADD DATES ----------
    if ((cmd === "ruins" || cmd === "altar") && sub === "add") {
      if (!isAdmin) return msg.reply("❌ Admin only.");

      const lines = msg.content.split("\n").slice(1);
      if (!lines.length) return msg.reply("Paste dates on new lines.");

      let added = 0;
      for (const line of lines) {
        const iso = parseLine(line);
        if (!iso) continue;

        const list = cmd === "ruins" ? cfg.ruins : cfg.altar;
        if (!list.includes(iso)) {
          list.push(iso);
          added++;
        }
      }

      saveRuins(guildId, cfg);
      return msg.reply(`✅ Added **${added}** ${cmd} dates.`);
    }

    // ---------- SHOW ----------
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

    // ---------- CLEAR ----------
    if ((cmd === "ruins" || cmd === "altar") && sub === "clear") {
      if (!isAdmin) return msg.reply("❌ Admin only.");

      if (cmd === "ruins") cfg.ruins = [];
      else cfg.altar = [];

      saveRuins(guildId, cfg);
      return msg.reply(`🧹 Cleared all ${cmd} dates.`);
    }
  });

  // ================= SCHEDULER =================
  client.once("ready", () => {
    setInterval(async () => {
      for (const guildId of client.guilds.cache.keys()) {
        const cfg = loadRuins(guildId);
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
              saveRuins(guildId, cfg);
            }
          }
        }
      }
    }, CHECK_EVERY_MS);
  });
}
