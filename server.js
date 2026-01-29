import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import cron from "node-cron";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(process.cwd(), "queue.json");

function loadQueue() {
  if (!fs.existsSync(DATA_FILE)) return { items: [] };
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
}
function saveQueue(q) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(q, null, 2));
}

async function postFacebook({ message }) {
  const { FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN } = process.env;
  if (!FB_PAGE_ID || !FB_PAGE_ACCESS_TOKEN) throw new Error("FB env missing");

  const url = `https://graph.facebook.com/v19.0/${FB_PAGE_ID}/feed`;
  const params = { message, access_token: FB_PAGE_ACCESS_TOKEN };

  const res = await axios.post(url, null, { params });
  return res.data;
}

async function sendTelegram(text) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[Telegram disabled]", text);
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text });
}

function pickNext(timeslot) {
  const q = loadQueue();
  const item = q.items.find((x) => x.status === "PENDING" && x.timeslot === timeslot);
  return { q, item };
}

async function runSlot(timeslot) {
  // Facebook
  {
    const { q, item } = pickNext(timeslot);
    if (item?.platforms?.includes("facebook")) {
      try {
        const result = await postFacebook({ message: item.caption });
        item.status = "DONE_FACEBOOK";
        item.facebookResult = result;
        saveQueue(q);
        console.log("[OK] Facebook", timeslot, result);
      } catch (e) {
        item.status = "ERROR_FACEBOOK";
        item.error = e?.response?.data || e.message;
        saveQueue(q);
        console.error("[ERR] Facebook", timeslot, item.error);
      }
    }
  }

  // TikTok notify
  {
    const { q, item } = pickNext(timeslot);
    if (item?.platforms?.includes("tiktok")) {
      try {
        const msg = `📌 TikTok ${timeslot}\n\n📝 Caption:\n${item.caption}\n\n✅ Publie manuellement sur TikTok.`;
        await sendTelegram(msg);
        item.status = "READY_TIKTOK";
        saveQueue(q);
        console.log("[OK] TikTok notif", timeslot);
      } catch (e) {
        item.status = "ERROR_TIKTOK";
        item.error = e?.response?.data || e.message;
        saveQueue(q);
        console.error("[ERR] TikTok notif", timeslot, item.error);
      }
    }
  }
}

// API
app.post("/queue", (req, res) => {
  const { caption, platforms, timeslot } = req.body;
  if (!caption) return res.status(400).json({ error: "caption required" });
  if (!platforms) return res.status(400).json({ error: "platforms required (facebook,tiktok)" });
  if (!timeslot) return res.status(400).json({ error: "timeslot required (morning|noon|evening)" });

  const q = loadQueue();
  q.items.push({
    id: `post_${Date.now()}`,
    caption,
    platforms: platforms.split(",").map((s) => s.trim().toLowerCase()),
    timeslot: timeslot.trim().toLowerCase(),
    status: "PENDING",
  });
  saveQueue(q);
  res.json({ ok: true });
});

app.get("/queue", (req, res) => res.json(loadQueue()));
app.post("/run/:timeslot", async (req, res) => {
  await runSlot(req.params.timeslot);
  res.json({ ok: true });
});

// CRON (heure serveur Render = UTC généralement)
cron.schedule("0 9 * * *", () => runSlot("morning"));
cron.schedule("0 13 * * *", () => runSlot("noon"));
cron.schedule("0 19 * * *", () => runSlot("evening"));
app.get("/", (req, res) => {
  res.status(200).send("OK - Pikagency publisher is running 🚀");
});

app.listen(PORT, () => console.log("Running on", PORT));
