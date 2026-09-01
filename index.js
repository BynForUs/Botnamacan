require('dotenv').config();

console.log('--- CEK ISI ENV ---');
console.log('TOKEN:', process.env.TOKEN ? 'DAPAT' : 'KOSONG');
console.log('-------------------');

const { Client, GatewayIntentBits, Partials, ChannelType, Options } = require('discord.js');
const { joinVoiceChannel, VoiceConnectionStatus, getVoiceConnection } = require('@discordjs/voice');

const TOKEN = process.env.TOKEN;
const MY_USER_ID = process.env.MY_USER_ID;
const PREFIX = process.env.PREFIX || '!';

// CHANNEL ID UNTUK AUTO REJOIN VC SETELAH RESTART/OOM
const AUTO_VC_ID = process.env.AUTO_VC_ID || process.env.KHUSUS_VC_ID?.split(',')[0]?.trim();

const KHUSUS_VC_IDS = process.env.KHUSUS_VC_ID 
  ? process.env.KHUSUS_VC_ID.split(',').map(id => id.trim()) 
  : [];

// OPTIMASI MEMORI (PREVENT OOM / CRASH)
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [
    Partials.Channel,
  ],
  sweepers: {
    ...Options.DefaultSweeperSettings,
    messages: {
      interval: 3600, // Cek & bersihkan RAM tiap 1 jam
      lifetime: 1800, // Hapus cache pesan yang umurnya > 30 menit
    },
  },
  makeCache: Options.cacheWithLimits({
    MessageManager: 100, // Simpan maksimal 100 pesan per channel di RAM
  }),
});

// TIMER 15 MENIT (900.000 ms)
const WAIT_DURATION = 15 * 60 * 1000; 

const afkUsers = new Map();
const activeMentionTimers = new Map(); 
const voiceOwners = new Map();

client.once('clientReady', async () => {
  console.log(`[ONLINE] Bot Siap! Logged in as ${client.user.tag}`);

  // OTOMATIS JOIN KE VC SETELAH RESTART
  if (AUTO_VC_ID) {
    try {
      const channel = await client.channels.fetch(AUTO_VC_ID);
      if (channel && channel.isVoiceBased()) {
        joinVoiceChannel({
          channelId: channel.id,
          guildId: channel.guild.id,
          adapterCreator: channel.guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: false,
        });
        console.log(`[AUTO-JOIN] Berhasil masuk otomatis ke VC: ${channel.name}`);
      }
    } catch (error) {
      console.error('[AUTO-JOIN ERROR] Gagal auto join VC:', error);
    }
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // =========================================================
  // GLOBAL RESET: BATALKAN BALASAN BOT JIKA KAMU NGETIK DI CHANNEL MANAPUN
  // =========================================================
  if (message.author.id === MY_USER_ID) {
    if (activeMentionTimers.has(MY_USER_ID)) {
      const activeTimer = activeMentionTimers.get(MY_USER_ID);
      clearTimeout(activeTimer.timer);
      activeMentionTimers.delete(MY_USER_ID);
    }
  }

  // =========================================================
  // FITUR: NGOMEL PAS ADA YANG REPLY CHAT BOT
  // =========================================================
  if (message.reference && message.reference.messageId) {
    try {
      const referencedMessage = await message.channel.messages.fetch(message.reference.messageId);
      if (referencedMessage.author.id === client.user.id) {
        return message.reply(`Dih ngapain lu bales-bales chat gua?! Gua ini cuma bot, mending lu urusin hidup lu sendiri deh setan! 🤬🖕`);
      }
    } catch (err) {
      console.error('Error fetching referenced message:', err);
    }
  }

  // =========================================================
  // 0. FITUR KHUSUS DM
  // =========================================================
  if (message.channel.type === ChannelType.DM) {
    if (afkUsers.has(MY_USER_ID)) {
      const afkData = afkUsers.get(MY_USER_ID);
      return message.reply(`Mengapa ngebel?!, si <@${MY_USER_ID}> lagi **${afkData.reason}** 🤫`);
    }
    return;
  }

  const isAllowedChannel = KHUSUS_VC_IDS.includes(message.channel.id);

  // =========================================================
  // 1. PENGECEKAN MENTION (PURE TAG @, BUKAN BALASAN REPLY)
  // =========================================================
  if (!message.content.startsWith(PREFIX) && message.mentions.users.size > 0) {
    const isReply = message.reference !== null && message.reference !== undefined;

    if (!isReply) {
      message.mentions.users.forEach((user) => {
        if (user.id === client.user.id || user.id === message.author.id) return;

        // JIKA STATUS KAMU SEDANG AFK (!afk)
        if (afkUsers.has(user.id)) {
          const afkData = afkUsers.get(user.id);
          message.reply(`Bujug deh lagi di tag bae lu mah!, si <@${user.id}> lagi **${afkData.reason}** 🤫`);
        } 
        // JIKA TIDAK AFK: TUNGGU 15 MENIT TANPA AKTIVITAS DARI KAMU
        else if (user.id === MY_USER_ID) {
          if (!activeMentionTimers.has(MY_USER_ID)) {
            const timer = setTimeout(() => {
              message.reply(`Sabar!, ntar di bales jangan spam tag lagi ya nyet! 🤬`);
              activeMentionTimers.delete(MY_USER_ID);
            }, WAIT_DURATION);

            activeMentionTimers.set(MY_USER_ID, {
              timer: timer,
              targetMessage: message
            });
          }
        }
      });
    }
  }

  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // =========================================================
  // 2. COMMANDS
  // =========================================================

  // --- COMMAND: KIW ---
  if (command === 'kiw') {
    if (!isAllowedChannel) {
      return message.reply('Ogah ah, gua cuma mau masuk di pois bin doang 😜');
    }

    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
      return message.reply('Masuk ke Voice Channel dulu blok, baru suruh gua join! 🙄');
    }

    const existingConnection = getVoiceConnection(message.guild.id);
    
    if (existingConnection) {
      const ownerId = voiceOwners.get(message.guild.id);
      if (ownerId && ownerId !== message.author.id) {
        return message.reply(`Ogah menan! Gua lagi di kekepin ama <@${ownerId}>. Lu kaga punya hak ngatur gua! 😜`);
      }
      return message.reply('Mata lu buta kali?! Gua kan udah di dalem pois dari tadi ini! 🤬');
    }

    try {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      voiceOwners.set(message.guild.id, message.author.id);

      connection.on(VoiceConnectionStatus.Destroyed, () => {
        voiceOwners.delete(message.guild.id);
      });

      return message.reply(`Halo <@${message.author.id}> udah masuk nih gua ke pois! 😉`);

    } catch (error) {
      console.error('Error pas join VC:', error);
      return message.reply('Aduh kejedot 😵‍💫');
    }
  }

  // --- COMMAND: LEAVE / CABUT ---
  else if (command === 'leave' || command === 'cabut') {
    if (!isAllowedChannel) {
      return message.reply('Ogah ah, urusan lu bukan di marih! 😜');
    }

    const botVoiceState = message.guild.members.me?.voice;
    const connection = getVoiceConnection(message.guild.id);

    if (!botVoiceState?.channelId && !connection) {
      return message.reply('Gua aja kaga lagi ada di dalem pois, maen usir-usir bae lu! 🙄');
    }

    const ownerId = voiceOwners.get(message.guild.id);
    if (ownerId && ownerId !== message.author.id) {
      return message.reply(`Dih sape lu?! Cuma <@${ownerId}> yang bisa nyuruh gua cabut! 🖕😜`);
    }

    try {
      if (connection) {
        connection.destroy();
      }

      if (botVoiceState?.channelId) {
        await botVoiceState.disconnect();
      }

      voiceOwners.delete(message.guild.id);

      return message.reply('gua cabut duls mek! 👋😜');
    } catch (error) {
      console.error('Error pas leave VC:', error);
      return message.reply('Aduh, gua mau keluar tapi sleting gua nyangkut ini! 😵‍💫');
    }
  }

  // --- COMMAND: AFK ---
  else if (command === 'afk') {
    if (!isAllowedChannel) return;

    const targetUser = message.mentions.users.first();
    const userToAFK = targetUser || message.author;
    
    let reason = args.filter(arg => !arg.startsWith('<@')).join(' ').trim();
    
    if (!reason) {
      reason = 'AFK kaga jelas/tanpa alasan';
      afkUsers.set(userToAFK.id, { reason: reason, time: Date.now() });
      return message.reply(`Lagu tai kali si <@${userToAFK.id}>! Masang AFK tapi kaga make alesan, bloon! 🙄🤬`);
    }

    afkUsers.set(userToAFK.id, { reason: reason, time: Date.now() });
    return message.reply(`yaudeh <@${userToAFK.id}>, jangan lupa ketik "!done" yak kalo udah ${reason} nya 🙄`);
  }

  // --- COMMAND: DONE ---
  else if (command === 'done') {
    if (!isAllowedChannel) return;

    const targetUser = message.mentions.users.first();
    const userToClear = targetUser || message.author;

    if (afkUsers.has(userToClear.id)) {
      const afkData = afkUsers.get(userToClear.id);
      const reasonText = afkData.reason;

      afkUsers.delete(userToClear.id);

      message.reply(`Eh udeh balik si monyet! abis ${reasonText}, kira-kira ada gebrakan apa lagi? 🙄`);
    } else {
      message.reply(`<@${userToClear.id}> lu aja kaga masang !afk setan! 🤬.`);
    }
  }
});

// MONITORING MEMORI: RESTART JIKA MEMORI MELEBIHI 400MB
setInterval(() => {
  const memoryUsage = process.memoryUsage().heapUsed / 1024 / 1024;
  if (memoryUsage > 75) {
    console.log(`[WARNING] Penggunaan RAM tinggi (${memoryUsage.toFixed(2)} MB). Memicu auto-restart...`);
    process.exit(1);
  }
}, 30 * 60 * 1000);

client.login(TOKEN);