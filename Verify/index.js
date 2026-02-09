console.log("🔥 VERIFY BOT BUILD 2026-02-09 FINAL");

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits
} = require("discord.js");

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

const { getGuild, setGuild } = require("./guildConfig");

const TOKEN = process.env.TOKEN;
const HARLEY_QUINN_USER_ID = "297057337590546434";

// =====================
// CSV CONFIG (same folder as this index.js)
// CSV headers: Name,ID
// =====================
const DATA_FILE = path.join(__dirname, "DATA.csv");

// -------- helpers --------
function sanitizeName(raw) {
  const name = String(raw ?? "").trim();
  if (name.length < 2 || name.length > 32) return null;
  const ok = /^[\p{L}\p{N} ._\-'\[\]#]+$/u.test(name);
  return ok ? name : null;
}

function readCsvRecords() {
  if (!fs.existsSync(DATA_FILE)) throw new Error(`DATA.csv not found at ${DATA_FILE}`);
  const csvText = fs.readFileSync(DATA_FILE, "utf8");
  return parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });
}

function lookupNameByGovernorId(governorId) {
  const records = readCsvRecords();
  const target = String(governorId).trim();

  for (const row of records) {
    const id = String(row.ID ?? "").trim();
    const name = String(row.Name ?? "").trim();
    if (id === target) return name || null;
  }
  return null;
}

// runtime memory: userId -> screenshot done?
const screenshotDone = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message]
});

client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// =====================
// MEMBER JOIN
// =====================
client.on(Events.GuildMemberAdd, async (member) => {
  const cfg = getGuild(member.guild.id).verify;
  if (!cfg?.channelId) return;

  const channel = await member.guild.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel) return;

  screenshotDone.delete(member.id);

  await channel.send(
`👋 Welcome ${member}!

Please upload a screenshot of your **Rise of Kingdoms profile** here.
After that, click the button to unlock the server.`
  );
});

// =====================
// MESSAGE CREATE
// =====================
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // ---------- DM AUTO REPLY ----------
  if (!message.guild) {
    if (message.author.id === HARLEY_QUINN_USER_ID) return;
    return message.reply(
      `Hi! I’m just a bot 🤖\n\nPlease contact <@${HARLEY_QUINN_USER_ID}> for help.`
    ).catch(() => {});
  }

  const guildId = message.guild.id;
  const verifyCfg = getGuild(guildId).verify || {};

  // ---------- VERIFY COMMANDS ----------
  if (message.content.startsWith("!verify")) {
    const args = message.content.split(/\s+/);
    const sub = (args[1] || "help").toLowerCase();

    if (sub === "help") {
      return message.reply(
        "**Verify Commands**\n\n" +
        "`!verify set channel #channel` – set verify channel\n" +
        "`!verify set role @role` – role given after verify\n" +
        "`!verify status` – show current setup\n" +
        "`!verify dump` – show saved JSON for this server\n" +
        "`!verify testsave` – write a test value and show JSON"
      );
    }

    if (sub === "status") {
      return message.reply(
        "**Verify Status**\n" +
        `• Channel: ${verifyCfg.channelId ? `<#${verifyCfg.channelId}>` : "not set"}\n` +
        `• Role: ${verifyCfg.roleId ? `<@&${verifyCfg.roleId}>` : "not set"}`
      );
    }

    // NEW: dump current saved config for this guild
    if (sub === "dump") {
      const cfg = getGuild(guildId);
      return message.reply("```json\n" + JSON.stringify(cfg, null, 2) + "\n```");
    }

    // NEW: force a save and show it (proves persistence)
    if (sub === "testsave") {
      setGuild(guildId, { _test: { savedAt: new Date().toISOString() } });
      const cfg = getGuild(guildId);
      return message.reply("Saved. Current config:\n```json\n" + JSON.stringify(cfg, null, 2) + "\n```");
    }

    if (sub === "set") {
      if (args[2] === "channel") {
        const ch = message.mentions.channels.first();
        if (!ch) return message.reply("❌ Use: `!verify set channel #channel`");

        setGuild(guildId, { verify: { channelId: ch.id } });
        return message.reply(`✅ Verify channel set to ${ch}`);
      }

      if (args[2] === "role") {
        const role = message.mentions.roles.first();
        if (!role) return message.reply("❌ Use: `!verify set role @role`");

        setGuild(guildId, { verify: { roleId: role.id } });
        return message.reply(`✅ Verify role set to ${role.name}`);
      }
    }

    return message.reply("❌ Unknown command. Use `!verify help`");
  }

  // ---------- VERIFY CHANNEL LOGIC ----------
  if (!verifyCfg.channelId || message.channel.id !== verifyCfg.channelId) return;

  const member = await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return message.delete().catch(() => {});

  // If already verified, delete anything they post in verify channel
  if (verifyCfg.roleId && member.roles.cache.has(verifyCfg.roleId)) {
    return message.delete().catch(() => {});
  }

  // Allow only ONE image screenshot from the user; delete everything else
  const hasImage = message.attachments.some(att =>
    att.contentType?.startsWith("image/") ||
    /\.(png|jpg|jpeg|webp|gif)$/i.test(att.name || "")
  );

  if (!hasImage || screenshotDone.get(member.id)) {
    return message.delete().catch(() => {});
  }

  screenshotDone.set(member.id, true);

  const button = new ButtonBuilder()
    .setCustomId(`verify_id:${member.id}`)
    .setLabel("Enter Governor ID")
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder().addComponents(button);

  await message.reply({
    content: "Great! Click below to enter your **Governor ID** (numbers only).",
    components: [row]
  });
});

// =====================
// INTERACTIONS
// =====================
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.guild) return;

    const verifyCfg = getGuild(interaction.guild.id).verify || {};

    // ---------- BUTTON ----------
    if (interaction.isButton()) {
      const [key, uid] = interaction.customId.split(":");
      if (key !== "verify_id" || interaction.user.id !== uid) {
        return interaction.reply({ content: "This button isn’t for you.", ephemeral: true });
      }

      const modal = new ModalBuilder()
        .setCustomId(`id_modal:${uid}`)
        .setTitle("Rise of Kingdoms Verification")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("governor_id")
              .setLabel("Your RoK Governor ID (numbers only)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMinLength(6)
              .setMaxLength(20)
          )
        );

      return interaction.showModal(modal);
    }

    // ---------- MODAL SUBMIT ----------
    if (interaction.isModalSubmit()) {
      const [key, uid] = interaction.customId.split(":");
      if (key !== "id_modal" || interaction.user.id !== uid) {
        return interaction.reply({ content: "This form isn’t for you.", ephemeral: true });
      }

      if (!verifyCfg.roleId || !verifyCfg.channelId) {
        return interaction.reply({
          content: "❌ Verify is not configured. Admin must set channel + role with `!verify set ...`",
          ephemeral: true
        });
      }

      const member = interaction.member;
      const rawId = interaction.fields.getTextInputValue("governor_id").trim();

      if (!/^\d+$/.test(rawId)) {
        return interaction.reply({
          content: "❌ Governor ID must contain numbers only.",
          ephemeral: true
        });
      }

      let nameFromDb = null;
      try {
        nameFromDb = lookupNameByGovernorId(rawId);
      } catch (err) {
        console.error("CSV error:", err);
        return interaction.reply({
          content: "❌ Database error reading DATA.csv. Ask an admin.",
          ephemeral: true
        });
      }

      if (!nameFromDb) {
        return interaction.reply({
          content: "❌ ID not found in database.",
          ephemeral: true
        });
      }

      const cleanName = sanitizeName(nameFromDb);
      if (!cleanName) {
        return interaction.reply({
          content: "❌ Name in database is not valid for Discord nickname.",
          ephemeral: true
        });
      }

      const me = await interaction.guild.members.fetchMe();
      if (
        !me.permissions.has(PermissionFlagsBits.ManageNicknames) ||
        !me.permissions.has(PermissionFlagsBits.ManageRoles)
      ) {
        return interaction.reply({ content: "❌ Bot missing permissions.", ephemeral: true });
      }

      await member.setNickname(cleanName);
      await member.roles.add(verifyCfg.roleId);

      if (interaction.message) {
        await interaction.message.edit({
          content: `✅ All set, ${interaction.user}! Enjoy the server.`,
          components: []
        }).catch(() => {});
      }

      return interaction.reply({
        content: `✅ Verified as **${cleanName}** (ID: ${rawId}). Role granted.`,
        ephemeral: true
      });
    }
  } catch (e) {
    console.error(e);
  }
});
// ===== Keep Railway container alive (Web Service healthcheck) =====
const http = require("http");

const PORT = process.env.PORT || 8080;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  })
  .listen(PORT, () => console.log(`🌐 HTTP server listening on ${PORT}`));

client.login(TOKEN);


