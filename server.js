import express from "express";
const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_TOKEN;
const SECRET = process.env.SECRET_PATH || "hook";
const PORT = process.env.PORT || 3000;

const api = (m, p) =>
  fetch(`https://api.telegram.org/bot${TOKEN}/${m}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(p || {})
  }).then(r => r.json());

app.get("/", (req, res) => res.send("OK"));

app.post("/" + SECRET, async (req, res) => {
  res.send("ok");
  const u = req.body || {};
  const msg = u.message || u.edited_message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (text.startsWith("/start")) {
    await api("sendMessage", { chat_id: chatId, text: "ربات روی Render فعاله ✅" });
  }
});

app.listen(PORT, () => console.log("server started on", PORT));
