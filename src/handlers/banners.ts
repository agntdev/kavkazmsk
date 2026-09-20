import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { CATEGORIES, changeDomain, loadDomain, nextId, now, type Banner, type BannerAction } from "../domain.js";
import { adminChatId, inlineButton, inlineKeyboard, requireOwner } from "../toolkit/index.js";
import type { InlineKeyboardMarkup } from "../toolkit/index.js";
import { showSearchResults } from "./browse-start.js";

const composer = new Composer<Ctx>();
const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_BANNERS = 5;
const force = (placeholder: string) => ({ force_reply: true as const, input_field_placeholder: placeholder });

async function activeBanners(ctx: Ctx): Promise<Banner[]> {
  const domain = await loadDomain(ctx);
  if (domain.banned.includes(ctx.from?.id ?? ctx.chat?.id ?? 0)) return [];
  return (domain.banners ?? []).filter((b) => b.active).sort((a, b) => a.order - b.order);
}

function bannerText(banner: Banner): string {
  return [banner.title, banner.subtitle].filter(Boolean).join("\n") || "Откройте подборку объявлений";
}

function bannerKeyboard(banners: Banner[], index: number): InlineKeyboardMarkup {
  const current = banners[index];
  const rows = [] as ReturnType<typeof inlineButton>[][];
  if (banners.length > 1) {
    rows.push([
      inlineButton("‹", `banner:prev:${index}`),
      inlineButton(`${index + 1}/${banners.length}`, `banner:open:${current.id}`),
      inlineButton("›", `banner:next:${index}`),
    ]);
  }
  rows.push([inlineButton("Подробнее", `banner:open:${current.id}`)]);
  return inlineKeyboard(rows);
}

export async function sendMainScreen(ctx: Ctx, welcome: string, menu: InlineKeyboardMarkup): Promise<void> {
  const banners = await activeBanners(ctx);
  if (!banners.length) {
    await ctx.reply(welcome, { reply_markup: menu });
    return;
  }
  const banner = banners[0];
  const chatId = ctx.chat?.id ?? ctx.from?.id ?? 0;
  try {
    const sent = await ctx.api.sendPhoto(chatId, banner.imageFileId, {
      caption: bannerText(banner),
      reply_markup: bannerKeyboard(banners, 0),
    });
    if (typeof sent === "object" && sent && "message_id" in sent) scheduleRotation(ctx, chatId, Number(sent.message_id), 0);
  } catch {
    await ctx.reply(bannerText(banner), { reply_markup: bannerKeyboard(banners, 0) });
  }
  await ctx.reply(welcome, { reply_markup: menu });
}

function scheduleRotation(ctx: Ctx, chatId: number | string, messageId: number, index: number): void {
  setTimeout(async () => {
    const pausedUntil = Number(ctx.session.draft?.bannerPausedUntil ?? 0);
    if (pausedUntil > now()) return;
    const banners = await activeBanners(ctx);
    if (banners.length < 2) return;
    const next = (index + 1) % banners.length;
    const banner = banners[next];
    try {
      await ctx.api.editMessageMedia(chatId, messageId, { type: "photo", media: banner.imageFileId, caption: bannerText(banner) }, { reply_markup: bannerKeyboard(banners, next) });
      scheduleRotation(ctx, chatId, messageId, next);
    } catch {
      // A deleted or expired Telegram message ends this carousel quietly.
    }
  }, 8000);
}

function actionLabel(action: BannerAction): string {
  return action.type === "none" ? "Без действия" : `${action.type}: ${action.value}`;
}

function adminChat(ctx: Ctx): boolean {
  const admin = adminChatId(ctx);
  return Boolean(admin && String(ctx.chat?.id ?? "") === admin);
}

async function listBanners(ctx: Ctx): Promise<void> {
  const banners = (await loadDomain(ctx)).banners ?? [];
  if (!banners.length) {
    await ctx.reply("Баннеров пока нет. Добавьте первый командой /banners add.");
    return;
  }
  const text = banners.sort((a, b) => a.order - b.order)
    .map((b) => `${b.order}. ${b.id} — ${b.title || "без заголовка"} (${b.active ? "включён" : "выключен"})`)
    .join("\n");
  await ctx.reply(`Баннеры:\n${text}`);
}

async function askBannerImage(ctx: Ctx, editId?: string): Promise<void> {
  ctx.session.step = editId ? "banner-edit-image" : "banner-image";
  ctx.session.draft = editId ? { bannerEditId: editId } : {};
  await ctx.reply(editId ? "Пришлите новое JPG или PNG до 1 МБ или напишите: заголовок | подзаголовок | действие." : "Пришлите JPG или PNG до 1 МБ.", { reply_markup: force("Изображение баннера") });
}

async function saveBannerImage(ctx: Ctx, fileId: string, size?: number, mime?: string): Promise<void> {
  if (size !== undefined && size > MAX_IMAGE_BYTES) {
    await ctx.reply("Файл больше 1 МБ. Пришлите сжатое изображение.", { reply_markup: force("Изображение до 1 МБ") });
    return;
  }
  if (mime && mime !== "image/jpeg" && mime !== "image/png") {
    await ctx.reply("Подойдут только JPG или PNG. Пришлите изображение ещё раз.");
    return;
  }
  const draft = ctx.session.draft ?? (ctx.session.draft = {});
  draft.bannerImage = fileId;
  ctx.session.step = "banner-title";
  await ctx.reply("Напишите короткий заголовок до 40 символов или отправьте «нет».", { reply_markup: force("Заголовок баннера") });
}

async function askSubtitle(ctx: Ctx): Promise<void> {
  ctx.session.step = "banner-subtitle";
  await ctx.reply("Добавьте подзаголовок до 80 символов или отправьте «нет».", { reply_markup: force("Подзаголовок баннера") });
}

function actionKeyboard(): InlineKeyboardMarkup {
  return inlineKeyboard([
    [inlineButton("Категория", "banner:action:category"), inlineButton("Объявление", "banner:action:listing")],
    [inlineButton("Ссылка", "banner:action:url"), inlineButton("Поиск", "banner:action:search")],
    [inlineButton("Без действия", "banner:action:none")],
  ]);
}

async function finishBanner(ctx: Ctx, action: BannerAction): Promise<void> {
  const draft = ctx.session.draft ?? {};
  const image = typeof draft.bannerImage === "string" ? draft.bannerImage : undefined;
  const title = typeof draft.bannerTitle === "string" ? draft.bannerTitle : undefined;
  const subtitle = typeof draft.bannerSubtitle === "string" ? draft.bannerSubtitle : undefined;
  if (!image) {
    await ctx.reply("Не удалось собрать баннер. Начните добавление заново командой /banners add.");
    return;
  }
  const editId = typeof draft.bannerEditId === "string" ? draft.bannerEditId : undefined;
  await changeDomain(ctx, (d) => {
    const banners = (d.banners ??= []);
    if (editId) {
      const found = banners.find((b) => b.id === editId);
      if (found) Object.assign(found, { imageFileId: image ?? found.imageFileId, title, subtitle, action, updatedAt: now() });
      return;
    }
    const order = banners.length ? Math.max(...banners.map((b) => b.order)) + 1 : 1;
    banners.push({ id: nextId("banner"), imageFileId: image, title, subtitle, action, order, active: true, createdAt: now(), updatedAt: now() });
  });
  ctx.session.step = undefined; ctx.session.draft = undefined;
  await ctx.reply(editId ? "Баннер обновлён." : "Баннер добавлен.");
}

composer.command("banners", async (ctx) => {
  if (!(await requireOwner(ctx))) return;
  if (!adminChat(ctx)) { await ctx.reply("Эта команда доступна только в чате владельца."); return; }
  const input = ctx.match.trim();
  const [subcommand, id] = input.split(/\s+/, 2);
  if (subcommand === "list" || !subcommand) { await listBanners(ctx); return; }
  if (subcommand === "add") {
    if ((await activeBanners(ctx)).length >= MAX_BANNERS) { await ctx.reply("Можно включить не больше 5 баннеров. Удалите один перед добавлением."); return; }
    await askBannerImage(ctx); return;
  }
  if (subcommand === "delete" && id) {
    await changeDomain(ctx, (d) => { d.banners = (d.banners ?? []).filter((b) => b.id !== id); });
    await ctx.reply("Баннер удалён."); return;
  }
  if (subcommand === "edit" && id) {
    const exists = (await loadDomain(ctx)).banners?.some((b) => b.id === id);
    if (!exists) { await ctx.reply("Такого баннера нет."); return; }
    await askBannerImage(ctx, id); return;
  }
  if (subcommand === "reorder" && id) {
    const ids = input.slice("reorder".length).trim().split(/[,\s]+/).filter(Boolean);
    await changeDomain(ctx, (d) => { (d.banners ?? []).forEach((b) => { const position = ids.indexOf(b.id); if (position >= 0) b.order = position + 1; }); });
    await ctx.reply("Порядок баннеров обновлён."); return;
  }
  await ctx.reply("Команды баннеров: /banners list, /banners add, /banners edit ID, /banners delete ID, /banners reorder ID1,ID2");
});

composer.on("message:photo", async (ctx, next) => {
  if (ctx.session.step !== "banner-image" && ctx.session.step !== "banner-edit-image") return next();
  const photo = ctx.message.photo.at(-1);
  if (!photo) { await ctx.reply("Не получилось принять изображение. Пришлите его ещё раз."); return; }
  await saveBannerImage(ctx, photo.file_id, photo.file_size);
});

composer.on("message:document", async (ctx, next) => {
  if (ctx.session.step !== "banner-image" && ctx.session.step !== "banner-edit-image") return next();
  const document = ctx.message.document;
  await saveBannerImage(ctx, document.file_id, document.file_size, document.mime_type);
});

composer.on("message:text", async (ctx, next) => {
  const step = ctx.session.step;
  const text = ctx.message.text.trim();
  const draft = ctx.session.draft ?? (ctx.session.draft = {});
  if (step === "banner-edit-image") {
    const bannerId = typeof draft.bannerEditId === "string" ? draft.bannerEditId : "";
    const parts = text.split("|").map((part) => part.trim());
    if (parts.length < 2 || parts.length > 3) { await ctx.reply("Для изменения текста используйте формат: заголовок | подзаголовок | none."); return; }
    const actionPart = parts[2] ?? "none";
    const action: BannerAction = actionPart === "none" ? { type: "none" } : /^url:/i.test(actionPart) ? { type: "url", value: actionPart.slice(4).trim() } : /^search:/i.test(actionPart) ? { type: "search", value: actionPart.slice(7).trim() } : /^listing:/i.test(actionPart) ? { type: "listing", value: actionPart.slice(8).trim() } : { type: "category", value: actionPart.replace(/^category:/i, "").trim() };
    if (action.type === "url" && !/^https?:\/\//i.test(action.value)) { await ctx.reply("Ссылка должна начинаться с https:// или http://."); return; }
    if (parts[0].length > 40 || parts[1].length > 80) { await ctx.reply("Проверьте длину заголовка (до 40) и подзаголовка (до 80) символов."); return; }
    await changeDomain(ctx, (d) => { const banner = (d.banners ?? []).find((item) => item.id === bannerId); if (banner) Object.assign(banner, { title: parts[0] || undefined, subtitle: parts[1] || undefined, action, updatedAt: now() }); });
    ctx.session.step = undefined; ctx.session.draft = undefined; await ctx.reply("Баннер обновлён."); return;
  }
  if (step === "banner-title") {
    if (text.length > 40) { await ctx.reply("Заголовок должен быть до 40 символов. Попробуйте ещё раз."); return; }
    draft.bannerTitle = text.toLowerCase() === "нет" ? undefined : text; await askSubtitle(ctx); return;
  }
  if (step === "banner-subtitle") {
    if (text.length > 80) { await ctx.reply("Подзаголовок должен быть до 80 символов. Попробуйте ещё раз."); return; }
    draft.bannerSubtitle = text.toLowerCase() === "нет" ? undefined : text; ctx.session.step = "banner-action"; await ctx.reply("Выберите действие баннера.", { reply_markup: actionKeyboard() }); return;
  }
  if (step === "banner-action-value") {
    const kind = String(draft.bannerActionType) as "category" | "listing" | "url" | "search";
    if (kind === "url" && !/^https?:\/\//i.test(text)) { await ctx.reply("Ссылка должна начинаться с https:// или http://."); return; }
    await finishBanner(ctx, { type: kind, value: text.slice(0, 500) }); return;
  }
  return next();
});

composer.callbackQuery(/^banner:action:(category|listing|url|search|none)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.session.step !== "banner-action") { await ctx.reply("Добавление баннера уже закрыто."); return; }
  const action = ctx.match[1] as "category" | "listing" | "url" | "search" | "none";
  if (action === "none") { await finishBanner(ctx, { type: "none" }); return; }
  ctx.session.draft = { ...(ctx.session.draft ?? {}), bannerActionType: action }; ctx.session.step = "banner-action-value";
  await ctx.reply(action === "url" ? "Пришлите полную ссылку." : action === "search" ? "Напишите поисковый запрос." : action === "category" ? `Укажите ID категории (например, ${CATEGORIES[0]}).` : "Укажите ID объявления.", { reply_markup: force("Значение действия") });
});

composer.callbackQuery(/^banner:(prev|next):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.draft = { ...(ctx.session.draft ?? {}), bannerPausedUntil: now() + 8000 };
  const banners = await activeBanners(ctx); if (!banners.length) { await ctx.reply("Баннеры сейчас недоступны."); return; }
  const old = Number(ctx.match[2]); const index = ctx.match[1] === "next" ? (old + 1) % banners.length : (old - 1 + banners.length) % banners.length;
  const banner = banners[index];
  await changeDomain(ctx, (d) => { d.bannerClicks = (d.bannerClicks ?? []).concat({ user: ctx.from?.id ?? 0, bannerId: banner.id, at: now() }).slice(-1000); });
  try { await ctx.api.editMessageMedia(ctx.chat?.id ?? 0, ctx.callbackQuery.message?.message_id ?? 0, { type: "photo", media: banner.imageFileId, caption: bannerText(banner) }, { reply_markup: bannerKeyboard(banners, index) }); }
  catch { await ctx.reply(bannerText(banner), { reply_markup: bannerKeyboard(banners, index) }); }
});

composer.callbackQuery(/^banner:open:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.draft = { ...(ctx.session.draft ?? {}), bannerPausedUntil: now() + 8000 };
  const banner = (await loadDomain(ctx)).banners?.find((b) => b.id === ctx.match[1] && b.active);
  if (!banner) { await ctx.reply("Баннер больше недоступен."); return; }
  await changeDomain(ctx, (d) => { d.bannerClicks = (d.bannerClicks ?? []).concat({ user: ctx.from?.id ?? 0, bannerId: banner.id, at: now() }).slice(-1000); });
  if (banner.action.type === "url") { await ctx.reply("Ссылка откроется в браузере.", { reply_markup: inlineKeyboard([[inlineButton("Открыть ссылку", `banner:url:${banner.id}`)], [inlineButton("Назад", "menu:main")]]) }); return; }
  if (banner.action.type === "category") { const categoryIndex = /^\d+$/.test(banner.action.value) ? Number(banner.action.value) : CATEGORIES.indexOf(banner.action.value); await ctx.reply("Открываю категорию.", { reply_markup: inlineKeyboard([[inlineButton("Открыть объявления", `browse:cat:${Math.max(0, categoryIndex)}`)], [inlineButton("В меню", "menu:main")]]) }); return; }
  if (banner.action.type === "listing") { await ctx.reply("Открываю объявление.", { reply_markup: inlineKeyboard([[inlineButton("Открыть объявление", `listing:open:${banner.action.value}`)]]) }); return; }
  if (banner.action.type === "search") { ctx.session.step = undefined; ctx.session.draft = { browseSearchQuery: banner.action.value }; await showSearchResults(ctx, banner.action.value, 0, true); return; }
  await ctx.reply(bannerText(banner), { reply_markup: inlineKeyboard([[inlineButton("В меню", "menu:main")]]) });
});

composer.callbackQuery(/^banner:url:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const banner = (await loadDomain(ctx)).banners?.find((b) => b.id === ctx.match[1] && b.active);
  if (!banner || banner.action.type !== "url") { await ctx.reply("Ссылка больше недоступна."); return; }
  await ctx.reply("Открыть ссылку:", { reply_markup: inlineKeyboard([[{ text: "Открыть ссылку", url: banner.action.value }], [inlineButton("Назад", "menu:main")]]) });
});

export default composer;
