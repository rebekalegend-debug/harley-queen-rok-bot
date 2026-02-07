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

// REQUIRED: set these in Railway Variables (or hardcode, but don't)
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID; // e.g. "123..."
const MEMBER_ROLE_ID = process.env.MEMBER_ROLE_ID;         // "3237 Member" role id

// Simple safety: in-game name length and allowed chars (adjust as you want)
function sanitizeName(raw) {
  const name = raw.trim();
  if (name.length < 2 || name.length > 32) return null; // Discord nickname limit is 32
  // allow letters, numbers, spaces and some symbols commonly used
  const ok = /^[\p{L}\p{N} ._\-'\[\]#]+$/u.test(name);
  if (!ok) return null;
  return name;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel]
});

client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const channel = await member.guild.channels.fetch(WELCOME_CHANNEL_ID).catch(() => null);
    if (!channel) return;

    const button = new ButtonBuilder()
      .setCustomId(`verify_ingame:${member.id}`)
      .setLabel("Enter In-Game Name")
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(button);

    await channel.send({
      content:
`👋 Welcome ${member}!

1️⃣ Upload a screenshot of your **Rise of Kingdoms profile**.  
2️⃣ Click the button below to enter your **in-game name** and unlock the server.`,
      components: [row]
    });
  } catch (e) {
    console.error("GuildMemberAdd error:", e);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Button -> show modal
    if (interaction.isButton()) {
      const [key, targetId] = interaction.customId.split(":");
      if (key !== "verify_ingame") return;

      // Only the joining user can use their button
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

    // Modal submit -> rename + role
    if (interaction.isModalSubmit()) {
      const [key, userId] = interaction.customId.split(":");
      if (key !== "ingame_modal") return;

      if (interaction.user.id !== userId) {
        return interaction.reply({ content: "This form isn’t for you.", ephemeral: true });
      }

      const raw = interaction.fields.getTextInputValue("ingame_name");
      const name = sanitizeName(raw);
      if (!name) {
        return interaction.reply({
          content: "❌ Invalid name. Use 2–32 chars (letters/numbers/spaces and basic symbols). Try again.",
          ephemeral: true
        });
      }

      const member = interaction.member; // GuildMember
      if (!member) {
        return interaction.reply({ content: "❌ Could not find your server member record.", ephemeral: true });
      }

      // Check permissions
      const me = await member.guild.members.fetchMe();
      if (!me.permissions.has(PermissionFlagsBits.ManageNicknames) || !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return interaction.reply({
          content: "❌ I’m missing permissions (Manage Nicknames / Manage Roles). Ask an admin to fix my permissions.",
          ephemeral: true
        });
      }

      // Rename
      await member.setNickname(name).catch((err) => {
        throw new Error("Failed to set nickname. Ensure my role is above the member and I have Manage Nicknames.");
      });

      // Add role
      await member.roles.add(MEMBER_ROLE_ID).catch((err) => {
        throw new Error("Failed to add role. Ensure my role is above '3237 Member' and I have Manage Roles.");
      });

      return interaction.reply({
  content: `🎉 All set, **${name}**! We know who you are now — your role is added. Enjoy the server!`,
  ephemeral: true
});

    }
  } catch (e) {
    console.error("Interaction error:", e);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({ content: "❌ Something went wrong. Ask an admin to check bot permissions/role order.", ephemeral: true });
      } catch {}
    }
  }
});

client.login(TOKEN);


