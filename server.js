import express from "express";

const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_TOKEN;   // از Render می‌گیریم
const SECRET = process.env.SECRET_PATH || "webhook";

// کمک‌متد تماس با تلگرام
const api = (m, p) =>
  fetch(`https://api.telegram.org/bot${TOKEN}/${m}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(p || {})
  }).then(r => r.json());

// تنظیمات ساده در حافظه (بعداً می‌تونیم پایدارش کنیم)
const groups = new Map();
const getS = cid => {
  if (!groups.has(cid)) groups.set(cid, {
    welcome: "خوش اومدی به گروه 👋",
    linksAllowed: false,
    banned: [],
    floodLimit: 5,
    floodWindow: 10,
    autoMute: 60
  });
  return groups.get(cid);
};

async function isAdmin(chatId, userId) {
  try {
    const r = await api("getChatMember", { chat_id: chatId, user_id: userId });
    return ["administrator", "creator"].includes(r?.result?.status);
  } catch { return false; }
}

// سلامت
app.get("/", (req, res) => res.send("OK"));

// وبهوک
app.post(`/${SECRET}`, async (req, res) => {
  res.send("ok"); // سریع جواب بدیم؛ پردازش ادامه داره
  const update = req.body || {};
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const chatId = msg.chat?.id;
  const fromId = msg.from?.id;
  const isGroup = ["group", "supergroup"].includes(msg.chat?.type);
  const s = getS(chatId);

  // خوشامدگویی
  if (msg.new_chat_members?.length) {
    for (const m of msg.new_chat_members) {
      await api("sendMessage", { chat_id: chatId, text: `${m.first_name || "دوست"}، ${s.welcome}` });
    }
    return;
  }

  const text = (msg.text || "").trim();
  if (isGroup && text.startsWith("/")) {
    const [raw, ...rest] = text.split(/\s+/);
    const cmd = raw.slice(1).split("@")[0].toLowerCase();
    const args = rest.join(" ").trim();
    const admin = await isAdmin(chatId, fromId);
    const reply = t => api("sendMessage", { chat_id: chatId, text: t, reply_to_message_id: msg.message_id });

    switch (cmd) {
      case "start": await reply("ربات فعاله ✅"); break;
      case "settings":
        await reply(`Links: ${s.linksAllowed ? "✅" : "❌"} | Words: ${s.banned.join(", ") || "—"}`);
        break;
      case "setwelcome":
        if (!admin) return reply("فقط ادمین");
        if (!args)  return reply("کاربرد: /setwelcome متن");
        s.welcome = args; await reply("ذخیره شد ✅"); break;
      case "locklinks":
        if (!admin) return reply("فقط ادمین");
        s.linksAllowed = false; await reply("ارسال لینک قفل شد 🔒"); break;
      case "unlocklinks":
        if (!admin) return reply("فقط ادمین");
        s.linksAllowed = true; await reply("ارسال لینک آزاد شد 🔓"); break;
      case "addword":
        if (!admin) return reply("فقط ادمین");
        if (!args)  return reply("کاربرد: /addword کلمه");
        { const w = args.toLowerCase(); if (!s.banned.includes(w)) s.banned.push(w); }
        await reply("اضافه شد ✅"); break;
      case "delword":
        if (!admin) return reply("فقط ادمین");
        if (!args)  return reply("کاربرد: /delword کلمه");
        s.banned = s.banned.filter(w => w !== args.toLowerCase());
        await reply("حذف شد ✅"); break;
      case "listwords":
        await reply(s.banned.length ? "کلمات: " + s.banned.join(", ") : "لیست خالیه.");
        break;
      case "mute":
        if (!admin) return reply("فقط ادمین");
        if (!msg.reply_to_message) return reply("روی پیام کاربر ریپلای کن: /mute 60");
        { const secs = parseInt(args || "60", 10) || 60;
          await api("restrictChatMember", {
            chat_id: chatId, user_id: msg.reply_to_message.from.id,
            permissions: { can_send_messages: false },
            until_date: Math.floor(Date.now()/1000) + secs
          });
          await reply(`برای ${secs} ثانیه میوت شد 🔇`);
        } break;
      case "ban":
        if (!admin) return reply("فقط ادمین");
        if (!msg.reply_to_message) return reply("روی پیام کاربر ریپلای کن: /ban");
        await api("banChatMember", { chat_id: chatId, user_id: msg.reply_to_message.from.id });
        await reply("کاربر بن شد 🚫"); break;
      case "unban":
        if (!admin) return reply("فقط ادمین");
        { const uid = msg.reply_to_message?.from?.id || parseInt(args, 10);
          if (!uid) return reply("کاربرد: /unban user_id یا ریپلای");
          await api("unbanChatMember", { chat_id: chatId, user_id: uid });
          await reply("آزاد شد ✅");
        } break;
    }
    return;
  }

  // فیلتر پیام‌های عادی (برای غیرادمین)
  if (isGroup && !(await isAdmin(chatId, fromId))) {
    const body = ((msg.text || msg.caption || "") + " ").toLowerCase();
    // کلمات ممنوع
    if (s.banned.some(w => w && body.includes(w))) {
      await api("deleteMessage", { chat_id: chatId, message_id: msg.message_id });
      await api("sendMessage", { chat_id: chatId, text: "پیام به‌دلیل کلمات فیلتر حذف شد." });
      return;
    }
    // ضد لینک
    const linkRe = /(https?:\/\/\S+|t\.me\/\S+|telegram\.me\/\S+|@[\w\d_]{5,})/i;
    const hasEntities = (msg.entities && msg.entities.length) || (msg.caption_entities && msg.caption_entities.length);
    if (!s.linksAllowed && (hasEntities || linkRe.test(body))) {
      await api("deleteMessage", { chat_id: chatId, message_id: msg.message_id });
      await api("sendMessage", { chat_id: chatId, text: "ارسال لینک مجاز نیست." });
      return;
    }
  }
});

// Render پورت را از متغیر PORT می‌دهد
app.listen(process.env.PORT || 3000, () => {
  console.log("Bot server started");
});
