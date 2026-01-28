require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const { DateTime } = require("luxon");
const { db } = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN in .env");

const TZ = process.env.TZ || "Asia/Ho_Chi_Minh";
const OWNER_ID = 6216535779; // <- OWNER bạn đưa

const bot = new Telegraf(BOT_TOKEN);

// ===== Helpers =====
function nowVN() {
  return DateTime.now().setZone(TZ);
}
function fmt(dt) {
  return dt.toFormat("yyyy-LL-dd HH:mm:ss");
}
function parseUserDatetime(text) {
  const t = (text || "").trim();
  let dt = DateTime.fromFormat(t, "yyyy-LL-dd HH:mm:ss", { zone: TZ });
  if (!dt.isValid) dt = DateTime.fromFormat(t, "yyyy-LL-dd HH:mm", { zone: TZ });
  return dt.isValid ? dt : null;
}

function isOwner(ctx) {
  return Number(ctx.from?.id) === OWNER_ID;
}

// Chặn mọi lệnh trong PRIVATE nếu không phải owner
async function requireOwner(ctx) {
  if (ctx.chat?.type === "private" && !isOwner(ctx)) {
    await ctx.reply("⛔ Bot này chỉ OWNER mới được dùng.");
    return false;
  }
  return true;
}

function storeChannel(chat) {
  db.prepare(`
    INSERT INTO channels (chat_id, title, username, type, added_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      title=excluded.title,
      username=excluded.username,
      type=excluded.type
  `).run(chat.id, chat.title || "", chat.username || "", chat.type || "", Date.now());
}

async function ensureBotCanPost(ctx, chatId) {
  try {
    const me = await ctx.telegram.getMe();
    const member = await ctx.telegram.getChatMember(chatId, me.id);
    if (!member) return false;
    if (!(member.status === "administrator" || member.status === "creator")) return false;

    // channel đôi khi có can_post_messages
    if (typeof member.can_post_messages === "boolean") return member.can_post_messages;
    return true;
  } catch {
    return false;
  }
}

async function handleRegister(ctx) {
  const chat = ctx.chat;
  if (!chat) return;

  if (!["group", "supergroup", "channel"].includes(chat.type)) return;

  const ok = await ensureBotCanPost(ctx, chat.id);
  if (!ok) {
    try { await ctx.telegram.sendMessage(chat.id, "❌ Bot chưa có quyền Admin hoặc thiếu quyền Post Messages."); } catch {}
    return;
  }

  storeChannel(chat);
  try {
    await ctx.telegram.sendMessage(chat.id, "✅ Đã đăng ký kênh/nhóm này. Giờ bạn vào chat riêng với bot để lên lịch gửi.");
  } catch {}
}

// ===== Debug log =====
bot.use((ctx, next) => {
  console.log("UPDATE:", ctx.updateType);
  return next();
});

// ===== Auto-register khi bot được add / nâng quyền =====
bot.on("my_chat_member", async (ctx) => {
  const chat = ctx.chat;
  const newStatus = ctx.update?.my_chat_member?.new_chat_member?.status;
  if (!chat) return;

  if (["group", "supergroup", "channel"].includes(chat.type) && ["member", "administrator"].includes(newStatus)) {
    // lưu chat (không cần /register)
    storeChannel(chat);
    // thử báo 1 câu nếu có quyền
    try {
      const ok = await ensureBotCanPost(ctx, chat.id);
      if (ok) await ctx.telegram.sendMessage(chat.id, "✅ Bot đã được thêm và lưu kênh/nhóm này. (Auto-register)");
    } catch {}
  }
});

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📩 Chọn/Gửi tin nhắn mẫu", "SET_DRAFT")],
    [Markup.button.callback("📌 Chọn kênh/nhóm đích", "SET_TARGET")],
    [Markup.button.callback("⏰ Đặt thời gian gửi", "SET_TIME")],
    [Markup.button.callback("⚡ Nút nhanh thời gian", "QUICK_TIME")],
    [Markup.button.callback("🔁 Lặp: Không / Ngày / Tuần", "SET_REPEAT")],
    [Markup.button.callback("🗑 Auto xoá sau (phút)", "SET_DELETE_AFTER")],
    [Markup.button.callback("🔁 Chế độ: COPY/FORWARD", "SET_MODE")],
    [Markup.button.callback("✅ Tạo lịch gửi", "CONFIRM")],
    [Markup.button.callback("📋 Xem lịch pending", "LIST_JOBS")],
    [Markup.button.callback("❌ Huỷ draft", "CANCEL_DRAFT")]
  ]);
}

// ===== Draft store =====
function upsertDraft(userId, patch) {
  const existing = db.prepare("SELECT * FROM drafts WHERE user_id=?").get(userId);
  const base = existing || {
    user_id: userId,
    from_chat_id: null,
    message_id: null,
    mode: "copy",
    target_chat_id: null,
    run_at: null,
    created_at: Date.now(),
    repeat: "none",         // none|daily|weekly
    delete_after: null      // ms
  };

  // drafts table chưa có repeat/delete_after thì lưu tạm in-memory? -> mình lưu trong DB bằng JSON đơn giản:
  // vì bạn đang dùng drafts table cũ, ta sẽ dùng 1 trick: patch vào object, và chỉ write các cột sẵn có.
  // => nên lưu repeat/delete_after trong userStateTempMap.
  const next = { ...base, ...patch };

  // chỉ update các cột tồn tại (theo schema cũ)
  db.prepare(`
    INSERT INTO drafts (user_id, from_chat_id, message_id, mode, target_chat_id, run_at, created_at)
    VALUES (@user_id, @from_chat_id, @message_id, @mode, @target_chat_id, @run_at, @created_at)
    ON CONFLICT(user_id) DO UPDATE SET
      from_chat_id=excluded.from_chat_id,
      message_id=excluded.message_id,
      mode=excluded.mode,
      target_chat_id=excluded.target_chat_id,
      run_at=excluded.run_at
  `).run(next);

  return next;
}

function getDraft(userId) {
  return db.prepare("SELECT * FROM drafts WHERE user_id=?").get(userId);
}

function clearDraft(userId) {
  db.prepare("DELETE FROM drafts WHERE user_id=?").run(userId);
}

// Lưu repeat/delete_after trong memory theo user (để không bắt bạn alter drafts)
const draftExtra = new Map(); // userId -> {repeat, delete_after_ms}

// ===== Scheduler =====
const timers = new Map();

function scheduleJob(jobId, runAt) {
  const delay = runAt - Date.now();
  if (delay <= 0) {
    setImmediate(() => executeJob(jobId));
    return;
  }
  const t = setTimeout(() => executeJob(jobId), delay);
  timers.set(jobId, t);
}

async function executeJob(jobId) {
  timers.delete(jobId);
  const job = db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId);
  if (!job || job.status !== "pending") return;

  try {
    let sent;
    if (job.mode === "forward") {
      sent = await bot.telegram.forwardMessage(job.target_chat_id, job.from_chat_id, job.message_id);
    } else {
      sent = await bot.telegram.copyMessage(job.target_chat_id, job.from_chat_id, job.message_id);
    }

    db.prepare("UPDATE jobs SET status='sent', error=NULL WHERE id=?").run(jobId);

    // Auto delete
    if (job.delete_after && sent?.message_id) {
      setTimeout(async () => {
        try { await bot.telegram.deleteMessage(job.target_chat_id, sent.message_id); } catch {}
      }, job.delete_after);
    }

    // Repeat
    if (job.repeat && job.repeat !== "none") {
      const cur = DateTime.fromMillis(job.run_at).setZone(TZ);
      const nextRun = (job.repeat === "daily")
        ? cur.plus({ days: 1 })
        : cur.plus({ weeks: 1 });

      const ins = db.prepare(`
        INSERT INTO jobs (user_id, from_chat_id, message_id, mode, target_chat_id, run_at, status, error, created_at, repeat, delete_after)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?)
      `);

      const r = ins.run(
        job.user_id,
        job.from_chat_id,
        job.message_id,
        job.mode,
        job.target_chat_id,
        nextRun.toMillis(),
        Date.now(),
        job.repeat,
        job.delete_after ?? null
      );

      scheduleJob(r.lastInsertRowid, nextRun.toMillis());
    }

  } catch (e) {
    db.prepare("UPDATE jobs SET status='failed', error=? WHERE id=?").run(String(e?.message || e), jobId);
  }
}

function restorePendingJobs() {
  const rows = db.prepare("SELECT id, run_at FROM jobs WHERE status='pending'").all();
  for (const r of rows) scheduleJob(r.id, r.run_at);
}

// ===== Commands =====
bot.start(async (ctx) => {
  if (!(await requireOwner(ctx))) return;
  const t = nowVN();
  upsertDraft(ctx.from.id, { mode: "copy" });
  draftExtra.set(ctx.from.id, { repeat: "none", delete_after_ms: null });

  await ctx.reply(
    `👋 Bot lên lịch gửi tin nhắn (OWNER)\n` +
    `⏱ Giờ hiện tại (VN): ${fmt(t)}\n\nBấm nút bên dưới để thao tác:`,
    mainMenu()
  );
});

bot.command("id", async (ctx) => {
  await ctx.reply(`🆔 ID của bạn: ${ctx.from.id}`);
});

bot.command("now", async (ctx) => {
  if (!(await requireOwner(ctx))) return;
  await ctx.reply(`⏱ Giờ hiện tại (VN): ${fmt(nowVN())}`);
});

// /register trong GROUP
bot.command("register", async (ctx) => {
  await handleRegister(ctx);
});

// /register trong CHANNEL (channel_post)
bot.on("channel_post", async (ctx) => {
  const text = ctx.channelPost?.text?.trim() || "";
  if (text === "/register" || text.startsWith("/register@")) {
    await handleRegister(ctx);
  }
});

// /mychannels
bot.command("mychannels", async (ctx) => {
  if (!(await requireOwner(ctx))) return;
  if (ctx.chat.type !== "private") return;

  const rows = db.prepare(`
    SELECT chat_id, title, username, type
    FROM channels
    ORDER BY added_at DESC
  `).all();

  if (!rows.length) return ctx.reply("❌ Bot chưa lưu kênh/nhóm nào. Add bot vào kênh/nhóm (admin) hoặc /register trong kênh.");

  const text = rows.map((c, i) => {
    return `${i + 1}. ${c.title || "(không tên)"}\n   • ID: ${c.chat_id}\n   • @${c.username || "—"}\n   • Type: ${c.type}`;
  }).join("\n\n");

  ctx.reply(`📋 Danh sách kênh/nhóm đã lưu:\n\n${text}`);
});

// ===== UI =====
const userState = new Map(); // userId -> { step: "...", ... }

bot.on("callback_query", async (ctx) => {
  if (!(await requireOwner(ctx))) return;

  const data = ctx.callbackQuery?.data;
  const userId = ctx.from.id;

  if (ctx.chat?.type !== "private") {
    await ctx.answerCbQuery("Vui lòng dùng menu trong chat riêng với bot.");
    return;
  }

  await ctx.answerCbQuery();

  if (data === "SET_DRAFT") {
    userState.set(userId, { step: "WAIT_DRAFT" });
    return ctx.reply("📩 Gửi *tin nhắn mẫu* vào đây. Bot sẽ COPY/FORWARD tin này theo lịch.", { parse_mode: "Markdown" });
  }

  if (data === "SET_TARGET") {
    const channels = db.prepare("SELECT chat_id, title, username, type FROM channels ORDER BY added_at DESC").all();
    if (!channels.length) {
      return ctx.reply("Chưa có kênh/nhóm nào. Hãy add bot vào kênh/nhóm (admin) hoặc đăng /register trong kênh.");
    }

    const buttons = channels.slice(0, 20).map((c) => {
      const label = c.title?.trim()
        ? `# ${c.title}`
        : (c.username ? `@${c.username}` : `${c.chat_id}`);
      return [Markup.button.callback(label, `PICK_TARGET:${c.chat_id}`)];
    });

    return ctx.reply("📌 Chọn kênh/nhóm đích:", Markup.inlineKeyboard(buttons));
  }

  if (data?.startsWith("PICK_TARGET:")) {
    const chatId = Number(data.split(":")[1]);
    const ok = await ensureBotCanPost(ctx, chatId);
    if (!ok) return ctx.reply("⚠️ Bot không có quyền Admin/Post Messages ở kênh/nhóm này.", mainMenu());

    upsertDraft(userId, { target_chat_id: chatId });
    return ctx.reply(`✅ Đã chọn kênh/nhóm đích: ${chatId}`, mainMenu());
  }

  if (data === "SET_TIME") {
    userState.set(userId, { step: "WAIT_TIME" });
    const example = nowVN().plus({ minutes: 10 }).toFormat("yyyy-LL-dd HH:mm");
    return ctx.reply(`⏰ Nhập thời gian:\n• YYYY-MM-DD HH:mm (giờ VN)\nVí dụ: ${example}`);
  }

  if (data === "QUICK_TIME") {
    const base = nowVN();
    const btns = Markup.inlineKeyboard([
      [Markup.button.callback("➕ 10 phút", "QT:+10"), Markup.button.callback("➕ 30 phút", "QT:+30")],
      [Markup.button.callback("🕗 20:00 hôm nay", "QT:20H"), Markup.button.callback("🕘 09:00 ngày mai", "QT:9AM")],
    ]);
    return ctx.reply(`⚡ Chọn nhanh thời gian (giờ VN hiện tại: ${base.toFormat("HH:mm")})`, btns);
  }

  if (data?.startsWith("QT:")) {
    const code = data.split(":")[1];
    let dt = nowVN();

    if (code === "+10") dt = dt.plus({ minutes: 10 });
    if (code === "+30") dt = dt.plus({ minutes: 30 });
    if (code === "20H") dt = dt.set({ hour: 20, minute: 0, second: 0, millisecond: 0 });
    if (code === "9AM") dt = dt.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });

    if (dt.toMillis() < Date.now() + 5000) dt = dt.plus({ days: 1 }); // nếu quá khứ -> đẩy sang ngày sau

    upsertDraft(userId, { run_at: dt.toMillis() });
    return ctx.reply(`✅ Đã đặt thời gian: ${dt.toFormat("yyyy-LL-dd HH:mm")} (VN)`, mainMenu());
  }

  if (data === "SET_REPEAT") {
    const cur = draftExtra.get(userId) || { repeat: "none", delete_after_ms: null };
    const next = cur.repeat === "none" ? "daily" : (cur.repeat === "daily" ? "weekly" : "none");
    draftExtra.set(userId, { ...cur, repeat: next });
    return ctx.reply(`🔁 Lặp hiện tại: *${next.toUpperCase()}*`, { parse_mode: "Markdown", ...mainMenu() });
  }

  if (data === "SET_DELETE_AFTER") {
    userState.set(userId, { step: "WAIT_DELETE_AFTER" });
    return ctx.reply("🗑 Nhập số phút để tự xoá bài sau khi đăng.\nVí dụ: 10 (phút)\nNhập 0 để tắt.");
  }

  if (data === "SET_MODE") {
    const d = getDraft(userId) || upsertDraft(userId, {});
    const nextMode = d.mode === "copy" ? "forward" : "copy";
    upsertDraft(userId, { mode: nextMode });
    return ctx.reply(`🔁 Đã đổi chế độ: *${nextMode.toUpperCase()}*`, { parse_mode: "Markdown", ...mainMenu() });
  }

  if (data === "LIST_JOBS") {
    const rows = db.prepare(`
      SELECT id, run_at, target_chat_id, mode, repeat, delete_after
      FROM jobs
      WHERE user_id=? AND status='pending'
      ORDER BY run_at ASC
      LIMIT 10
    `).all(userId);

    if (!rows.length) return ctx.reply("📭 Bạn chưa có lịch pending nào.", mainMenu());

    const lines = rows.map((r) => {
      const dt = DateTime.fromMillis(r.run_at).setZone(TZ);
      const rep = (r.repeat || "none").toUpperCase();
      const del = r.delete_after ? `${Math.round(r.delete_after/60000)}p` : "OFF";
      return `• #${r.id} | ${dt.toFormat("yyyy-LL-dd HH:mm")} | ${r.mode.toUpperCase()} | REP:${rep} | DEL:${del}`;
    }).join("\n");

    const btns = rows.map(r => [Markup.button.callback(`Huỷ #${r.id}`, `CANCEL_JOB:${r.id}`)]);
    await ctx.reply(`📋 Lịch pending:\n${lines}`, Markup.inlineKeyboard(btns));
    return;
  }

  if (data?.startsWith("CANCEL_JOB:")) {
    const jobId = Number(data.split(":")[1]);
    db.prepare("UPDATE jobs SET status='cancelled' WHERE id=? AND user_id=?").run(jobId, userId);

    const t = timers.get(jobId);
    if (t) { clearTimeout(t); timers.delete(jobId); }

    return ctx.reply(`✅ Đã huỷ job #${jobId}`, mainMenu());
  }

  if (data === "CANCEL_DRAFT") {
    clearDraft(userId);
    draftExtra.delete(userId);
    userState.delete(userId);
    return ctx.reply("🧹 Đã huỷ draft.", mainMenu());
  }

  if (data === "CONFIRM") {
    const d = getDraft(userId);
    const extra = draftExtra.get(userId) || { repeat: "none", delete_after_ms: null };

    if (!d?.message_id) return ctx.reply("❌ Bạn chưa gửi tin nhắn mẫu.", mainMenu());
    if (!d?.target_chat_id) return ctx.reply("❌ Bạn chưa chọn kênh/nhóm đích.", mainMenu());
    if (!d?.run_at) return ctx.reply("❌ Bạn chưa đặt thời gian gửi.", mainMenu());

    const ok = await ensureBotCanPost(ctx, d.target_chat_id);
    if (!ok) return ctx.reply("❌ Bot không có quyền Admin/Post Messages ở kênh/nhóm đích.", mainMenu());

    const ins = db.prepare(`
      INSERT INTO jobs (user_id, from_chat_id, message_id, mode, target_chat_id, run_at, status, error, created_at, repeat, delete_after)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?)
    `);

    const r = ins.run(
      userId,
      d.from_chat_id,
      d.message_id,
      d.mode,
      d.target_chat_id,
      d.run_at,
      Date.now(),
      extra.repeat || "none",
      extra.delete_after_ms ?? null
    );

    scheduleJob(r.lastInsertRowid, d.run_at);

    const dt = DateTime.fromMillis(d.run_at).setZone(TZ);
    clearDraft(userId);

    return ctx.reply(
      `✅ Đã tạo lịch #${r.lastInsertRowid}\n` +
      `⏰ ${dt.toFormat("yyyy-LL-dd HH:mm")} (VN)\n` +
      `🔁 Repeat: ${(extra.repeat || "none").toUpperCase()}\n` +
      `🗑 Auto delete: ${extra.delete_after_ms ? Math.round(extra.delete_after_ms/60000) + " phút" : "OFF"}\n`,
      mainMenu()
    );
  }

  return ctx.reply("Menu:", mainMenu());
});

// ===== Capture messages in private =====
bot.on("message", async (ctx) => {
  if (!(await requireOwner(ctx))) return;

  const userId = ctx.from.id;
  if (ctx.chat.type !== "private") return;

  const st = userState.get(userId);
  if (!st) return;

  if (st.step === "WAIT_DRAFT") {
    upsertDraft(userId, {
      from_chat_id: ctx.chat.id,
      message_id: ctx.message.message_id
    });
    userState.delete(userId);
    return ctx.reply("✅ Đã lưu tin nhắn mẫu.", mainMenu());
  }

  if (st.step === "WAIT_TIME") {
    const dt = parseUserDatetime(ctx.message.text || "");
    if (!dt) return ctx.reply("❌ Sai định dạng. Ví dụ: 2026-01-28 20:30", mainMenu());
    if (dt.toMillis() < Date.now() + 5000) return ctx.reply("❌ Thời gian phải ở tương lai.", mainMenu());

    upsertDraft(userId, { run_at: dt.toMillis() });
    userState.delete(userId);
    return ctx.reply(`✅ Đã đặt thời gian: ${dt.toFormat("yyyy-LL-dd HH:mm")} (VN)`, mainMenu());
  }

  if (st.step === "WAIT_DELETE_AFTER") {
    const n = Number((ctx.message.text || "").trim());
    if (Number.isNaN(n) || n < 0) return ctx.reply("❌ Nhập số phút hợp lệ (>=0).", mainMenu());

    const cur = draftExtra.get(userId) || { repeat: "none", delete_after_ms: null };
    const ms = n === 0 ? null : Math.round(n * 60000);
    draftExtra.set(userId, { ...cur, delete_after_ms: ms });

    userState.delete(userId);
    return ctx.reply(`✅ Auto delete: ${ms ? n + " phút" : "OFF"}`, mainMenu());
  }
});

// ===== Boot =====
restorePendingJobs();

bot.launch().then(() => console.log("Bot started."));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
