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

const TOKEN = process.env.TOKEN;

// REQUIRED: set these in Railway Variables
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID; // e.g. "123..."
const MEMBER_ROLE_ID = process.env.MEMBER_ROLE_ID;         // role id

// The real person/admin to contact
const HARLEY_QUINN_USER_ID = "297057337590546434";

// Simple safety: in-game name length and allowed chars (adjust as you want)
function sanitizeName(raw) {
  const name = raw.trim();
  if (name.length < 2 || name.length > 32) return null; // Discord nickname limit is 32
  const ok = /^[\p{L}\p{N} ._\-'\[\]#]+$/u.test(name);
  if (!ok) return null;
  return name;
}

// Track who has already uploaded a screenshot (runtime memory)
const screenshotDone = new Map(); // userId -> true

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages // to receive DMs
  ],
  partials: [Partials.Channel, Partials.Message]
});

client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const channel = await member.guild.channels.fetch(WELCOME_CHANNEL_ID).catch(() => null);
    if (!channel) return;

    screenshotDone.delete(member.id);

    await channel.send({
      content:
`👋 Welcome ${member}!

Please upload a screenshot of your **Rise of Kingdoms profile** here. After you’re done, the bot will detect it and let you continue to unlock the server.`
    });
  } catch (e) {
    console.error("GuildMemberAdd error:", e);
  }
});

// ✅ Auto-reply to DMs so people stop confusing you with a real person
client.on(Events.MessageCreate, async (message) => {
  try {
    // Ignore bot messages
    if (message.author.bot) return;

    // If it's a DM (no guild)
    if (!message.guild) {
      // Do not reply to the Harley Quinn user (optional safety)
      if (message.author.id === HARLEY_QUINN_USER_ID) return;

      await message.reply(
        `Hi! I’m just a bot 🤖\n\n` +
        `Please reach out to <@${HARLEY_QUINN_USER_ID}> for help.`
      ).catch(() => {});
      return;
    }

    // --- Below: your welcome-channel enforcement logic ---

    if (message.channel.id !== WELCOME_CHANNEL_ID) return;

    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member) {
      await message.delete().catch(() => {});
      return;
    }

    const isVerified = member.roles.cache.has(MEMBER_ROLE_ID);

    const hasImage = message.attachments.some((att) => {
      if (att.contentType?.startsWith("image/")) return true;
      const name = (att.name || "").toLowerCase();
      return (
        name.endsWith(".png") ||
        name.endsWith(".jpg") ||
        name.endsWith(".jpeg") ||
        name.endsWith(".webp") ||
        name.endsWith(".gif")
      );
    });

    if (isVerified) {
      await message.delete().catch(() => {});
      return;
    }

    if (!hasImage) {
      await message.delete().catch(() => {});
      return;
    }

    if (screenshotDone.get(message.author.id)) {
      await message.delete().catch(() => {});
      return;
    }

    screenshotDone.set(message.author.id, true);

    const button = new ButtonBuilder()
      .setCustomId(`verify_ingame:${message.author.id}`)
      .setLabel("Enter In-Game Name")
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(button);

    await message.reply({
      content:
`Great! Click the button below to enter your **exact in-game name** to get a role and unlock the server.`,
      components: [row]
    });
  } catch (e) {
    console.error("MessageCreate error:", e);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Button -> show modal
    if (interaction.isButton()) {
      const [key, targetId] = interaction.customId.split(":");
      if (key !== "verify_ingame") return;

      if (interaction.user.id !== targetId) {
        return interaction.reply({ content: "This button isn’t for you.", ephemeral: true });
      }

      const modal = new ModalBuilder()
        .setCustomId(`ingame_modal:${interaction.user.id}`)
        .setTitle("Rise of Kingdoms Verification");

      const input = new TextInputBuilder()
        .setCustomId("ingame_name")
        .setLabel("Your RoK in-game name")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(32);

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    // Modal submit -> rename + role + edit the button message
    if (interaction.isModalSubmit()) {
      const [key, userId] = interaction.customId.split(":");
      if (key !== "ingame_modal") return;

      if (interaction.user.id !== userId) {
        return interaction.reply({ content: "This form isn’t for you.", ephemeral: true });
      }

      const member = interaction.member;
      if (!member) {
        return interaction.reply({ content: "❌ Could not find your server member record.", ephemeral: true });
      }

      if (member.roles.cache.has(MEMBER_ROLE_ID)) {
        if (interaction.message) {
          await interaction.message.edit({
            content: `✅ All set, ${interaction.user}! Your role is added. Enjoy the server!`,
            components: []
          }).catch(() => {});
        }
        return interaction.reply({ content: "✅ You are already verified.", ephemeral: true });
      }

      const raw = interaction.fields.getTextInputValue("ingame_name");
      const name = sanitizeName(raw);
      if (!name) {
        return interaction.reply({
          content: "❌ Invalid name. Use 2–32 chars (letters/numbers/spaces and basic symbols). Try again.",
          ephemeral: true
        });
      }

      const me = await member.guild.members.fetchMe();
      if (
        !me.permissions.has(PermissionFlagsBits.ManageNicknames) ||
        !me.permissions.has(PermissionFlagsBits.ManageRoles)
      ) {
        return interaction.reply({
          content: "❌ I’m missing permissions (Manage Nicknames / Manage Roles). Ask an admin to fix my permissions.",
          ephemeral: true
        });
      }

      await member.setNickname(name).catch(() => {
        throw new Error("Failed to set nickname. Ensure my role is above the member and I have Manage Nicknames.");
      });

      await member.roles.add(MEMBER_ROLE_ID).catch(() => {
        throw new Error("Failed to add role. Ensure my role is above the target role and I have Manage Roles.");
      });

      if (interaction.message) {
        await interaction.message.edit({
          content: `✅ All set, ${interaction.user}! Your role is added. Enjoy the server!`,
          components: []
        }).catch(() => {});
      }

      return interaction.reply({
        content: `✅ All set, ${interaction.user}! Your role is added. Enjoy the server!`,
        ephemeral: true
      });
    }
  } catch (e) {
    console.error("Interaction error:", e);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({
          content: "❌ Something went wrong. Ask an admin to check bot permissions/role order.",
          ephemeral: true
        });
      } catch {}
    }
  }
});

client.login(TOKEN);
