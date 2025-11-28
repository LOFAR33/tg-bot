export default {
  async fetch(req, env, ctx) {
    if (req.method === "GET") return new Response("OK");
    const url = new URL(req.url);
    if (url.pathname !== `/${env.SECRET_PATH}`) return new Response("not found", { status: 404 });

    const update = await req.json().catch(() => ({}));
    const msg = update.message || update.edited_message;
    const myId = update?.my_chat_member?.new_chat_member?.user?.id;

    // Helpers
    const api = (method, payload) =>
      fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
      }).then(r => r.json());

    const chatId = msg?.chat?.id;
    const userId = msg?.from?.id;
    const isGroup = chatId && (msg.chat.type === "group" || msg.chat.type === "supergroup");

    // KV helpers
    const key = (cid) => `settings:${cid}`;
    const defaults = () => ({
      welcome: "خوش اومدی به گروه 👋",
      links_allowed: false,
      banned_words: [],
      flood_limit: 5,
      flood_window: 10,
      auto_mute: 60
    });
    async function getSettings(cid) {
      const js = await env.KV.get(key(cid), "json");
      return js || defaults();
    }
    async function setSettings(cid, s) {
      await env.KV.put(key(cid), JSON.stringify(s));
    }

    // Cache in-memory for admin + flood (best-effort)
    const state = getGlobalState();
    async function isAdmin(cid, uid) {
      const cacheKey = `${cid}:${uid}`;
      const c = state.admin.get(cacheKey);
      if (c && c.exp > Date.now()) return c.val;
      const res = await api("getChatMember", { chat_id: cid, user_id: uid });
      const val = res?.result?.status === "creator" || res?.result?.status === "administrator";
      state.admin.set(cacheKey, { val, exp: Date.now() + 10 * 60 * 1000 });
      return val;
    }

    // New members welcome
    if (msg?.new_chat_members?.length) {
      const s = await getSettings(chatId);
      for (const m of msg.new_chat_members) {
        await api("sendMessage", { chat_id: chatId, text: `${escape(m.first_name)}، ${s.welcome}` });
      }
      return resOK();
    }

    // Commands
    const text = (msg?.text || "").trim();
    const cmd = parseCmd(text);
    if (cmd && isGroup) {
      const s = await getSettings(chatId);
      const admin = await isAdmin(chatId, userId);
      switch (cmd.name) {
        case "start":
          await api("sendMessage", { chat_id: chatId, text: helpText(), reply_to_message_id: msg.message_id });
          return resOK();
        case "settings":
          await api("sendMessage", { chat_id: chatId, text: formatSettings(s) });
          return resOK();
        case "setwelcome":
          if (!admin) return onlyAdmins(chatId, msg.message_id);
          if (!cmd.args) return usage(chatId, msg.message_id, "/setwelcome متن");
          s.welcome = cmd.args;
          await setSettings(chatId, s);
          await api("sendMessage", { chat_id: chatId, text: "متن خوشامدگویی ذخیره شد ✅" });
          return resOK();
        case "locklinks":
          if (!admin) return onlyAdmins(chatId, msg.message_id);
          s.links_allowed = false; await setSettings(chatId, s);
          await api("sendMessage", { chat_id: chatId, text: "ارسال لینک قفل شد 🔒" });
          return resOK();
        case "unlocklinks":
          if (!admin) return onlyAdmins(chatId, msg.message_id);
          s.links_allowed = true; await setSettings(chatId, s);
          await api("sendMessage", { chat_id: chatId, text: "ارسال لینک آزاد شد 🔓" });
          return resOK();
        case "addword":
          if (!admin) return onlyAdmins(chatId, msg.message_id);
          if (!cmd.args) return usage(chatId, msg.message_id, "/addword کلمه");
          const w = cmd.args.toLowerCase();
          if (!s.banned_words.includes(w)) s.banned_words.push(w);
          await setSettings(chatId, s);
          await api("sendMessage", { chat_id: chatId, text: `«${w}» به فهرست فیلتر اضافه شد ✅` });
          return resOK();
        case "delword":
          if (!admin) return onlyAdmins(chatId, msg.message_id);
          if (!cmd.args) return usage(chatId, msg.message_id, "/delword کلمه");
          const idx = s.banned_words.indexOf(cmd.args.toLowerCase());
          if (idx >= 0) s.banned_words.splice(idx, 1);
          await setSettings(chatId, s);
          await api("sendMessage", { chat_id: chatId, text: "حذف شد ✅" });
          return resOK();
        case "listwords":
          await api("sendMessage", { chat_id: chatId, text: s.banned_words.length ? `کلمات فیلتر: ${s.banned_words.join(", ")}` : "لیست فیلتر خالیه." });
          return resOK();
        case "mute":
          if (!admin) return onlyAdmins(chatId, msg.message_id);
          if (!msg.reply_to_message) return usage(chatId, msg.message_id, "روی پیام کاربر ریپلای کن و بزن: /mute 60");
          const secs = parseInt(cmd.args || "60", 10) || 60;
          const target = msg.reply_to_message.from.id;
          const until = Math.floor(Date.now() / 1000) + secs;
          await api("restrictChatMember", {
            chat_id: chatId, user_id: target, permissions: { can_send_messages: false }, until_date: until
          });
          await api("sendMessage", { chat_id: chatId, text: `کاربر برای ${secs} ثانیه میوت شد 🔇` });
          return resOK();
        case "ban":
          if (!admin) return onlyAdmins(chatId, msg.message_id);
          if (!msg.reply_to_message) return usage(chatId, msg.message_id, "روی پیام کاربر ریپلای کن و بزن: /ban");
          await api("banChatMember", { chat_id: chatId, user_id: msg.reply_to_message.from.id });
          await api("sendMessage", { chat_id: chatId, text: "کاربر بن شد 🚫" });
          return resOK();
        case "unban":
          if (!admin) return onlyAdmins(chatId, msg.message_id);
          if (!cmd.args && !msg.reply_to_message) return usage(chatId, msg.message_id, "/unban user_id یا ریپلای");
          const uid = msg.reply_to_message?.from?.id || parseInt(cmd.args, 10);
          await api("unbanChatMember", { chat_id: chatId, user_id: uid });
          await api("sendMessage", { chat_id: chatId, text: "کاربر آزاد شد ✅" });
          return resOK();
      }
    }

    // Guard (filters) for normal messages
    if (msg && isGroup && msg.from && !(await isAdmin(chatId, userId))) {
      const s = await getSettings(chatId);
      const fullText = ((msg.text || msg.caption || "") + " ").toLowerCase();

      // banned words
      if (s.banned_words.some(w => w && fullText.includes(w))) {
        await api("deleteMessage", { chat_id: chatId, message_id: msg.message_id });
        await api("sendMessage", { chat_id: chatId, text: "پیام به‌دلیل کلمات فیلتر شده حذف شد." });
        return resOK();
      }

      // link lock
      const linkRe = /(https?:\/\/\S+|t\.me\/\S+|telegram\.me\/\S+|@[\w\d_]{5,})/i;
      if (!s.links_allowed && (msg.entities || msg.caption_entities || linkRe.test(fullText))) {
        await api("deleteMessage", { chat_id: chatId, message_id: msg.message_id });
        await api("sendMessage", { chat_id: chatId, text: "ارسال لینک در این گروه مجاز نیست." });
        return resOK();
      }

      // anti-flood (simple)
      const k = `${chatId}:${userId}`;
      const now = Date.now();
      const q = state.flood.get(k) || [];
      const windowMs = s.flood_window * 1000;
      const limit = s.flood_limit;
      const filtered = q.filter(t => now - t < windowMs);
      filtered.push(now);
      state.flood.set(k, filtered);
      if (filtered.length > limit) {
        state.flood.set(k, []); // reset
        const until = Math.floor(Date.now() / 1000) + s.auto_mute;
        await api("restrictChatMember", {
          chat_id: chatId, user_id: userId, permissions: { can_send_messages: false }, until_date: until
        });
        await api("sendMessage", { chat_id: chatId, text: `به‌خاطر ارسال پیاپی، ${s.auto_mute} ثانیه میوت شد 🔇` });
        return resOK();
      }
    }

    return resOK();

    // utils
    function resOK() { return new Response("ok"); }
    function helpText() {
      return [
        "ربات مدیریت گروه فعاله ✅",
        "دستورات ادمین:",
        "/setwelcome متن",
        "/locklinks | /unlocklinks",
        "/addword کلمه | /delword کلمه | /listwords",
        "/mute [ثانیه] (ریپلای) | /ban (ریپلای) | /unban [id]",
        "/settings"
      ].join("\n");
    }
    function formatSettings(s) {
      return `Welcome: ${s.welcome}
Links allowed: ${s.links_allowed ? "✅" : "❌"}
Banned words: ${s.banned_words.join(", ") || "—"}
Flood: ${s.flood_limit} msg / ${s.flood_window}s → mute ${s.auto_mute}s`;
    }
    function parseCmd(t) {
      if (!t || t[0] !== "/") return null;
      const [raw, ...rest] = t.split(/\s+/);
      const name = raw.slice(1).split("@")[0].toLowerCase();
      const args = rest.join(" ").trim();
      return { name, args };
    }
    function escape(s = "") { return s.replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])); }
    function getGlobalState() {
      // globalThis persists per isolate
      if (!globalThis.__state) globalThis.__state = { admin: new Map(), flood: new Map() };
      return globalThis.__state;
    }
  }
};
