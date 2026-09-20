import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { adminChatId, registerMainMenuItem, inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { CATEGORIES, LOCATIONS, changeDomain, loadDomain, nextId, now, queueNotification, type Listing } from "../domain.js";

registerMainMenuItem({ label: "➕ Подать объявление", data: "post:start", order: 10 });
const composer = new Composer<Ctx>();
const force = (placeholder: string) => ({ force_reply: true as const, input_field_placeholder: placeholder });
const menu = (rows: ReturnType<typeof inlineButton>[][]) => inlineKeyboard(rows);
const cancel = [[inlineButton("Отмена", "menu:main")]];

function preview(d: Record<string, unknown>, status: string): string {
  return `Проверьте объявление:\n\n${String(d.title)}\n${String(d.description)}\nЦена: ${String(d.price || "договорная")}\nМесто: ${String(d.location)}\nКатегория: ${String(d.category)}\nСвязь: ${d.contact === "phone" ? "по телефону" : "в Telegram"}\n\nСтатус: ${status}`;
}
function askTitle(ctx: Ctx) { ctx.session.step = "title"; return ctx.reply("Начнём. Напишите короткий заголовок (до 120 символов).", { reply_markup: force("Например: мастер по ремонту") }); }

composer.callbackQuery("post:start", async (ctx) => { await ctx.answerCallbackQuery(); ctx.session.draft = {}; await askTitle(ctx); });
composer.callbackQuery("post:cancel", async (ctx) => { await ctx.answerCallbackQuery(); ctx.session.step = undefined; ctx.session.draft = undefined; await ctx.editMessageText("Объявление не сохранено.", { reply_markup: inlineKeyboard(cancel) }); });

composer.on("message:text", async (ctx, next) => {
  const step = ctx.session.step; const text = ctx.message.text.trim(); const d = ctx.session.draft ?? (ctx.session.draft = {});
  if (!step) return next();
  if (text === "/cancel") { ctx.session.step = undefined; ctx.session.draft = undefined; await ctx.reply("Хорошо, отменил. Когда будете готовы, нажмите «Подать объявление»."); return; }
  if (step === "title") {
    if (!text || text.length > 120) { await ctx.reply("Заголовок должен быть от 1 до 120 символов. Попробуйте ещё раз.", { reply_markup: force("Напишите заголовок") }); return; }
    d.title = text; ctx.session.step = "category"; await ctx.reply("Выберите категорию.", { reply_markup: menu(CATEGORIES.map((x, i) => [inlineButton(x, `post:cat:${i}`)]).concat(cancel)) }); return;
  }
  if (step === "description") {
    if (!text || text.length > 2000) { await ctx.reply("Описание должно быть от 1 до 2000 символов. Попробуйте ещё раз.", { reply_markup: force("Расскажите подробнее") }); return; }
    d.description = text; ctx.session.step = "price"; await ctx.reply("Укажите цену или напишите «б/п», если она договорная.", { reply_markup: force("Цена или б/п") }); return;
  }
  if (step === "price") {
    if (text.length > 80) { await ctx.reply("Цена слишком длинная. Укажите сумму или «б/п».", { reply_markup: force("Цена или б/п") }); return; }
    d.price = text; ctx.session.step = "photos"; d.photos = []; await ctx.reply("Пришлите до 8 фотографий. Когда закончите, нажмите «Готово».", { reply_markup: inlineKeyboard([[inlineButton("Готово", "post:photos:done")], ...cancel]) }); return;
  }
  if (step === "location-other") { d.location = text.slice(0, 100); ctx.session.step = "contact"; await ctx.reply("Как с вами связаться?", { reply_markup: inlineKeyboard([[inlineButton("В Telegram", "post:contact:telegram")], [inlineButton("Показать телефон", "post:contact:phone")], ...cancel]) }); return; }
  if (step === "phone") {
    if (!/[+()\d][\d ()-]{5,}/.test(text)) { await ctx.reply("Похоже, номер слишком короткий. Проверьте его и отправьте ещё раз.", { reply_markup: force("Например: +7 900 000-00-00") }); return; }
    d.phone = text; d.contact = "phone"; ctx.session.step = "confirm"; await ctx.reply(preview(d, "проверяется"), { reply_markup: inlineKeyboard([[inlineButton("Опубликовать", "post:publish"), inlineButton("Изменить", "post:edit")], [inlineButton("Отмена", "post:cancel")]]) }); return;
  }
  return next();
});

composer.callbackQuery(/^post:cat:(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); const d = ctx.session.draft ?? (ctx.session.draft = {}); d.category = CATEGORIES[Number(ctx.match[1])] ?? "Другое"; ctx.session.step = "description"; await ctx.reply("Теперь напишите описание (до 2000 символов).", { reply_markup: force("Что важно знать покупателю") }); });
composer.callbackQuery("post:photos:done", async (ctx) => { await ctx.answerCallbackQuery(); const d = ctx.session.draft ?? (ctx.session.draft = {}); ctx.session.step = "location"; await ctx.reply("Выберите район Москвы.", { reply_markup: menu(LOCATIONS.map((x, i) => [inlineButton(x, `post:loc:${i}`)]).concat([[inlineButton("Другой район", "post:loc:other")], ...cancel])) }); });
composer.on("message:photo", async (ctx, next) => { if (ctx.session.step !== "photos") return next(); const photos = (ctx.session.draft?.photos as string[] | undefined) ?? []; if (photos.length >= 8) { await ctx.reply("Можно добавить максимум 8 фотографий. Нажмите «Готово», когда закончите."); return; } photos.push(ctx.message.photo[ctx.message.photo.length - 1].file_id); ctx.session.draft!.photos = photos; await ctx.reply(`Фото добавлено (${photos.length}/8).`, { reply_markup: inlineKeyboard([[inlineButton("Готово", "post:photos:done")]]) }); });
composer.callbackQuery(/^post:loc:(\d+|other)$/, async (ctx) => { await ctx.answerCallbackQuery(); const d = ctx.session.draft ?? (ctx.session.draft = {}); if (ctx.match[1] === "other") { ctx.session.step = "location-other"; await ctx.reply("Напишите район или ближайшее метро.", { reply_markup: force("Например: метро Сокол") }); return; } d.location = LOCATIONS[Number(ctx.match[1])] ?? "Вся Москва"; ctx.session.step = "contact"; await ctx.reply("Как с вами связаться?", { reply_markup: inlineKeyboard([[inlineButton("В Telegram", "post:contact:telegram")], [inlineButton("Показать телефон", "post:contact:phone")], ...cancel]) }); });
composer.callbackQuery("post:contact:telegram", async (ctx) => { await ctx.answerCallbackQuery(); const d = ctx.session.draft ?? (ctx.session.draft = {}); d.contact = "telegram"; ctx.session.step = "confirm"; await ctx.reply(preview(d, "проверяется"), { reply_markup: inlineKeyboard([[inlineButton("Опубликовать", "post:publish"), inlineButton("Изменить", "post:edit")], [inlineButton("Отмена", "post:cancel")]]) }); });
composer.callbackQuery("post:contact:phone", async (ctx) => { await ctx.answerCallbackQuery(); ctx.session.step = "phone"; await ctx.reply("Напишите номер телефона. Он будет виден только тем, кто подтвердит просмотр.", { reply_markup: force("Например: +7 900 000-00-00") }); });
composer.callbackQuery("post:edit", async (ctx) => { await ctx.answerCallbackQuery(); await askTitle(ctx); });
composer.callbackQuery("post:publish", async (ctx) => {
  await ctx.answerCallbackQuery(); const d = ctx.session.draft ?? {}; const user = ctx.from?.id ?? ctx.chat?.id ?? 0; const existing = await loadDomain(ctx);
  if (existing.banned.includes(user)) { await ctx.reply("Ваш доступ к публикации объявлений ограничен."); return; }
  if (!d.title || !d.description || !d.category || !d.location) { await ctx.reply("Черновик заполнен не полностью. Начните объявление заново.", { reply_markup: inlineKeyboard([[inlineButton("Подать объявление", "post:start")]]) }); return; }
  const editingId = typeof d.editingId === "string" ? d.editingId : undefined;
  const first = !existing.listings.some((x) => x.owner === user); const listing: Listing = { id: nextId("ad"), owner: user, title: String(d.title), description: String(d.description), photos: (d.photos as string[] | undefined) ?? [], category: String(d.category), price: d.price ? String(d.price) : undefined, location: String(d.location), contact: d.contact === "phone" ? "phone" : "telegram", phone: d.phone ? String(d.phone) : undefined, status: first ? "pending" : "published", pinned: false, createdAt: now(), updatedAt: now() };
  let updated = false;
  await changeDomain(ctx, (domain) => {
    if (editingId) {
      const old = domain.listings.find((x) => x.id === editingId && x.owner === user);
      if (old && old.status !== "removed") {
        Object.assign(old, { title: listing.title, description: listing.description, photos: listing.photos, category: listing.category, price: listing.price, location: listing.location, contact: listing.contact, phone: listing.phone, updatedAt: now() });
        domain.history.push({ listingId: old.id, action: "edited", by: user, at: now() });
        updated = true;
      }
    }
    if (updated) return;
    domain.listings.push(listing);
    domain.history.push({ listingId: listing.id, action: "created", by: user, at: now() });
    const users = (domain.users ??= []);
    let profile = users.find((x) => x.id === user);
    if (!profile) { profile = { id: user, displayName: ctx.from?.first_name, username: ctx.from?.username, banned: false, joinedAt: now() }; users.push(profile); }
    profile.firstListingSubmittedAt ??= now();
  }); ctx.session.step = undefined; ctx.session.draft = undefined;
  if (updated) { await ctx.reply("Объявление обновлено.", { reply_markup: inlineKeyboard([[inlineButton("Мои объявления", "myads:start")]]) }); return; }
  if (listing.status === "pending") {
    const admin = adminChatId(ctx);
    const notification = `Новое объявление на проверку:\n\n${listing.title}\n${listing.location}`;
    const markup = { reply_markup: inlineKeyboard([[inlineButton("Одобрить", `admin:approve:${listing.id}`), inlineButton("Отклонить", `admin:reject:${listing.id}`)], [inlineButton("Удалить", `admin:remove:${listing.id}`), inlineButton("Заблокировать автора", `admin:ban:${listing.id}`)]]) };
    let delivered = false;
    if (admin) { try { await ctx.api.sendMessage(admin, notification, markup); delivered = true; } catch { /* retain it below */ } }
    if (!delivered) await changeDomain(ctx, (domain) => queueNotification(domain, "pending", notification, listing.id));
    await ctx.reply("Объявление отправлено на проверку. Мы сообщим, когда оно появится в каталоге.");
  } else await ctx.reply("Готово — объявление опубликовано!", { reply_markup: inlineKeyboard([[inlineButton("Открыть каталог", "browse:start")], [inlineButton("Мои объявления", "myads:start")]]) });
});
export default composer;
