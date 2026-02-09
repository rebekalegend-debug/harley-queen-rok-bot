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

const { getGuild, setGuild } = require("./guildConfig");

const TOKEN = process.env.TOKEN;
const HARLEY_QUINN_USER_ID = "297057337590546434";

// -------- helpers --------
function sanitizeName(raw) {
  const name = raw.trim();
  if (name.length < 2 || name.length > 32) return null;
  const ok = /^[\p{L}\p{N} ._\-'\[\]#]+$/u.test(name);
  return ok ? name : null;
}

// runtime memory
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
        "`!verify status` – show current setup"
      );
    }

    if (sub === "status") {
      return message.reply(
        "**Verify Status**\n" +
        `• Channel: ${verifyCfg.channelId ? `<#${verifyCfg.channelId}>` : "not set"}\n` +
        `• Role: ${verifyCfg.roleId ? `<@&${verifyCfg.roleId}>` : "not set"}`
      );
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

  if (member.roles.cache.has(verifyCfg.roleId)) {
    return message.delete().catch(() => {});
  }

  const hasImage = message.attachments.some(att =>
    att.contentType?.startsWith("image/") ||
    /\.(png|jpg|jpeg|webp|gif)$/i.test(att.name || "")
  );

  if (!hasImage || screenshotDone.get(member.id)) {
    return message.delete().catch(() => {});
  }

  screenshotDone.set(member.id, true);

  const button = new ButtonBuilder()
    .setCustomId(`verify_ingame:${member.id}`)
    .setLabel("Enter In-Game Name")
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder().addComponents(button);

  await message.reply({
    content: "Great! Click below to enter your **exact in-game name**.",
    components: [row]
  });
});

// =====================
// INTERACTIONS
// =====================
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    const verifyCfg = getGuild(interaction.guild.id).verify || {};

    if (interaction.isButton()) {
      const [key, uid] = interaction.customId.split(":");
      if (key !== "verify_ingame" || interaction.user.id !== uid) {
        return interaction.reply({ content: "This button isn’t for you.", ephemeral: true });
      }

      const modal = new ModalBuilder()
        .setCustomId(`ingame_modal:${uid}`)
        .setTitle("Rise of Kingdoms Verification")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("ingame_name")
              .setLabel("Your RoK in-game name")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(32)
          )
        );

      return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit()) {
      const [key, uid] = interaction.customId.split(":");
      if (key !== "ingame_modal" || interaction.user.id !== uid) {
        return interaction.reply({ content: "This form isn’t for you.", ephemeral: true });
      }

      const member = interaction.member;
      const raw = interaction.fields.getTextInputValue("ingame_name");
      const name = sanitizeName(raw);

      if (!name) {
        return interaction.reply({ content: "❌ Invalid name format.", ephemeral: true });
      }

      const me = await interaction.guild.members.fetchMe();
      if (
        !me.permissions.has(PermissionFlagsBits.ManageNicknames) ||
        !me.permissions.has(PermissionFlagsBits.ManageRoles)
      ) {
        return interaction.reply({ content: "❌ Missing permissions.", ephemeral: true });
      }

      await member.setNickname(name);
      await member.roles.add(verifyCfg.roleId);

      if (interaction.message) {
        await interaction.message.edit({
          content: `✅ All set, ${interaction.user}! Enjoy the server.`,
          components: []
        });
      }

      return interaction.reply({
        content: `✅ All set, ${interaction.user}! Enjoy the server.`,
        ephemeral: true
      });
    }
  } catch (e) {
    console.error(e);
  }
});

client.login(TOKEN);
