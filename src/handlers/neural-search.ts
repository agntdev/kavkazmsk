import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import type { Listing } from "../domain.js";
import { changeDomain, loadDomain, now } from "../domain.js";
import { inlineButton, inlineKeyboard, isOwner, paginate, registerMainMenuItem, requireOwner, urlButton, type InlineButton } from "../toolkit/index.js";

registerMainMenuItem({ label: "Нейросеть", data: "neural:open", order: 25 });

const composer = new Composer<Ctx>();
const LIMIT = 5;
const WINDOW = 60_000;
const PAGE_SIZE = 10;
const envOf = (ctx: Ctx): Record<string, unknown> | undefined =>
  (ctx as Ctx & { env?: Record<string, unknown> }).env;

function inputKeyboard() {
  return inlineKeyboard([
    [inlineButton("Ввести текст", "neural:text"), inlineButton("Загрузить фото", "neural:photo")],
    [inlineButton("Отмена", "menu:main")],
  ]);
}

function card(listing: Listing): string {
  return `Нейросеть\n${listing.title}\nЦена: ${listing.price || "договорная"}\nРайон: ${listing.location}`;
}

function words(value: string): string[] {
  return value.toLocaleLowerCase("ru").split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1);
}

function keywordScore(listing: Listing, query: string): number {
  const q = new Set(words(query));
  if (!q.size) return 0;
  const text = words(`${listing.title} ${listing.description} ${listing.category} ${listing.location}`);
  const matches = text.filter((word) => q.has(word) || [...q].some((part) => word.includes(part) || part.includes(word)));
  return matches.length / q.size;
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return -1;
  let dot = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : -1;
}

async function embedding(ctx: Ctx, input: string | { image: string }): Promise<number[] | undefined> {
  const env = envOf(ctx);
  const key = typeof env?.OPENROUTER_API_KEY === "string" ? env.OPENROUTER_API_KEY : undefined;
  if (!key) return undefined;
  const content = typeof input === "string" ? input : `Изображение Telegram: ${input.image}`;
  try {
    const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input: content }),
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { data?: Array<{ embedding?: unknown }> };
    const vector = body.data?.[0]?.embedding;
    return Array.isArray(vector) && vector.every((item) => typeof item === "number") ? vector as number[] : undefined;
  } catch { return undefined; }
}

async function allowed(ctx: Ctx): Promise<boolean> {
  const domain = await loadDomain(ctx);
  if (domain.neuralEnabled === false) { await ctx.reply("Поиск через нейросеть сейчас выключен. Попробуйте обычный поиск."); return false; }
  const user = ctx.from?.id ?? ctx.chat?.id ?? 0;
  const cutoff = now() - WINDOW;
  const recent = (domain.neuralRequests ?? []).filter((item) => item.at > cutoff && item.user === user);
  if (recent.length >= LIMIT) { await ctx.reply("Вы использовали лимит нейропоиска. Попробуйте через минуту."); return false; }
  await changeDomain(ctx, (d) => {
    d.neuralRequests = (d.neuralRequests ?? []).filter((item) => item.at > cutoff);
    d.neuralRequests.push({ user, at: now() });
  });
  return true;
}

async function search(ctx: Ctx, query: string, image: string | undefined, page = 0): Promise<void> {
  if (!(await allowed(ctx))) return;
  const placeholder = await ctx.reply("Ищем…");
  const domain = await loadDomain(ctx);
  const visible = domain.listings.filter((item) => item.status === "published");
  const vector = await embedding(ctx, image ? { image } : query);
  const ranked = visible.map((item) => ({ item, score: vector && item.embedding ? cosine(vector, item.embedding) : keywordScore(item, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt)
    .map((entry) => entry.item);
  const resultText = vector ? "Результаты — Нейросеть" : "Поиск через нейросеть сейчас недоступен, попробуйте позже\n\nРезультаты обычного поиска";
  const paged = paginate(ranked, { page, perPage: PAGE_SIZE, callbackPrefix: "neural:page", prevLabel: "Назад", nextLabel: "Ещё" });
  const rows: InlineButton[][] = paged.pageItems.map((item) => [inlineButton(`${item.title.slice(0, 30)} · ${item.location}`, `listing:open:${item.id}`)]);
  rows.push(...paged.controls.inline_keyboard);
  rows.push([inlineButton("Новый поиск", "neural:open"), inlineButton("⬅️ В меню", "menu:main")]);
  const ids = ranked.map((item) => item.id);
  await changeDomain(ctx, (d) => { d.neuralLogs = (d.neuralLogs ?? []).concat([{ user: ctx.from?.id ?? 0, query: query || "фото", image: Boolean(image), listingIds: ids, at: now() }]).slice(-500); });
  if (paged.pageItems.length === 0) {
    await ctx.api.editMessageText(ctx.chat?.id ?? 0, placeholder.message_id, `${resultText}\n\nНичего подходящего не нашлось — попробуйте описать запрос иначе.`, { reply_markup: inlineKeyboard(rows) });
    return;
  }
  for (const item of paged.pageItems) {
    const markup = item.contact === "telegram"
      ? inlineKeyboard([[urlButton("Связаться в Telegram", `tg://user?id=${item.owner}`)], [inlineButton("Открыть объявление", `listing:open:${item.id}`)]])
      : inlineKeyboard([[inlineButton("Показать номер", `listing:contact:${item.id}`)], [inlineButton("Открыть объявление", `listing:open:${item.id}`)]]);
    await ctx.reply(card(item), { reply_markup: markup });
  }
  await ctx.api.editMessageText(ctx.chat?.id ?? 0, placeholder.message_id, `${resultText}\n\nПоказано объявлений: ${paged.pageItems.length}`, { reply_markup: inlineKeyboard(rows) });
}

composer.callbackQuery("neural:open", async (ctx) => {
  await ctx.answerCallbackQuery();
  const domain = await loadDomain(ctx);
  if (domain.neuralEnabled === false) { await ctx.reply("Поиск через нейросеть сейчас выключен. Попробуйте обычный поиск."); return; }
  ctx.session.step = "neural-input";
  ctx.session.draft = { neuralText: undefined, neuralPhoto: undefined };
  const rows: InlineButton[][] = [...inputKeyboard().inline_keyboard];
  if (isOwner(ctx)) rows.push([inlineButton("Настройки нейросети", "admin:neural:status")]);
  await ctx.reply("Опишите, что ищете (текст или фото)", { reply_markup: inlineKeyboard(rows) });
});

composer.callbackQuery("neural:text", async (ctx) => { await ctx.answerCallbackQuery(); ctx.session.step = "neural-text"; await ctx.reply("Опишите, что ищете (текст или фото)", { reply_markup: { force_reply: true, input_field_placeholder: "Например: мастер по ремонту" } }); });
composer.callbackQuery("neural:photo", async (ctx) => { await ctx.answerCallbackQuery(); ctx.session.step = "neural-photo"; await ctx.reply("Пришлите фото, а затем нажмите «Искать».", { reply_markup: inlineKeyboard([[inlineButton("Искать", "neural:submit")], [inlineButton("Отмена", "menu:main")]]) }); });
composer.callbackQuery("neural:submit", async (ctx) => { await ctx.answerCallbackQuery(); const d = ctx.session.draft ?? {}; ctx.session.step = undefined; await search(ctx, typeof d.neuralText === "string" ? d.neuralText : "", typeof d.neuralPhoto === "string" ? d.neuralPhoto : undefined); });
composer.callbackQuery(/^neural:page:(prev|next):(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); const d = ctx.session.draft ?? {}; await search(ctx, typeof d.neuralText === "string" ? d.neuralText : "", typeof d.neuralPhoto === "string" ? d.neuralPhoto : undefined, Number(ctx.match[2])); });
composer.on("message:text", async (ctx, next) => { if (ctx.session.step !== "neural-text" && ctx.session.step !== "neural-input") return next(); const text = ctx.message.text.trim(); if (!text) { await ctx.reply("Напишите несколько слов, чтобы я смог найти объявления."); return; } ctx.session.draft = { ...(ctx.session.draft ?? {}), neuralText: text }; ctx.session.step = "neural-photo"; await ctx.reply("Текст принят. Можно добавить фото или сразу начать поиск.", { reply_markup: inlineKeyboard([[inlineButton("Искать", "neural:submit"), inlineButton("Добавить фото", "neural:photo")], [inlineButton("Отмена", "menu:main")]]) }); });
composer.on("message:photo", async (ctx, next) => { if (ctx.session.step !== "neural-photo" && ctx.session.step !== "neural-input") return next(); const photo = ctx.message.photo.at(-1)?.file_id; if (!photo) { await ctx.reply("Не получилось принять фото. Попробуйте отправить его ещё раз."); return; } ctx.session.draft = { ...(ctx.session.draft ?? {}), neuralPhoto: photo }; ctx.session.step = "neural-photo"; await ctx.reply("Фото принято. Нажмите «Искать», чтобы посмотреть объявления.", { reply_markup: inlineKeyboard([[inlineButton("Искать", "neural:submit")]]) }); });

composer.callbackQuery(/^admin:neural:(on|off)$/, async (ctx) => { await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx))) return; const enabled = ctx.match[1] === "on"; await changeDomain(ctx, (d) => { d.neuralEnabled = enabled; }); await ctx.reply(enabled ? "Нейросеть включена для пользователей." : "Нейросеть выключена для пользователей."); });
composer.callbackQuery("admin:neural:status", async (ctx) => { await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx))) return; const enabled = (await loadDomain(ctx)).neuralEnabled !== false; await ctx.reply(enabled ? "Нейросеть сейчас включена." : "Нейросеть сейчас выключена.", { reply_markup: inlineKeyboard([[inlineButton("Включить", "admin:neural:on"), inlineButton("Выключить", "admin:neural:off")]]) }); });

export default composer;
