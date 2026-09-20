import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard, paginate, registerMainMenuItem, urlButton, type InlineButton } from "../toolkit/index.js";
import { CATEGORIES, LOCATIONS, loadDomain, changeDomain, now, type Listing } from "../domain.js";
registerMainMenuItem({ label: "🔎 Найти объявление", data: "browse:start", order: 20 });
const composer = new Composer<Ctx>();
type BrowseFilters = { category?: string; location?: string };
const SEARCH_PAGE_SIZE = 10;

function filtersFromSession(ctx: Ctx): BrowseFilters {
  const draft = ctx.session.draft ?? {};
  return {
    category: typeof draft.browseCategory === "string" ? draft.browseCategory : undefined,
    location: typeof draft.browseLocation === "string" ? draft.browseLocation : undefined,
  };
}

async function logBrowseEvent(ctx: Ctx, event: "category" | "all_categories", value?: string): Promise<void> {
  await changeDomain(ctx, (d) => {
    d.browseEvents = (d.browseEvents ?? []).concat({ user: ctx.from?.id ?? 0, event, value, at: now() }).slice(-500);
  });
}

function searchWords(value: string): string[] {
  return value.toLocaleLowerCase("ru-RU").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function matchesSearch(listing: Listing, query: string): boolean {
  const haystack = searchWords([
    listing.title,
    listing.description,
    ...(listing.tags ?? []),
  ].join(" "));
  return searchWords(query).every((word) => haystack.some((candidate) => candidate.includes(word)));
}

function snippet(listing: Listing): string {
  const text = listing.description.trim();
  return text.length <= 200 ? text : `${text.slice(0, 197).trimEnd()}…`;
}

function searchCard(listing: Listing): string {
  return `${listing.title}\nЦена: ${listing.price || "договорная"}\nРайон: ${listing.location}\n${snippet(listing)}`;
}

async function showSearchResults(ctx: Ctx, query: string, page = 0, log = false): Promise<void> {
  const domain = await loadDomain(ctx);
  const results = domain.listings
    .filter((listing) => listing.status === "published" && matchesSearch(listing, query))
    .sort((a, b) => b.createdAt - a.createdAt);

  if (log) {
    await changeDomain(ctx, (d) => {
      d.searchLogs = (d.searchLogs ?? []).concat({
        user: ctx.from?.id ?? 0,
        query,
        resultCount: results.length,
        at: now(),
      }).slice(-500);
    });
  }

  if (results.length === 0) {
    await ctx.reply("Ничего не найдено. Попробуйте изменить запрос или выбрать категорию.", {
      reply_markup: inlineKeyboard([
        [inlineButton("Поиск по категориям", "browse:categories")],
        [inlineButton("⬅️ В меню", "menu:main")],
      ]),
    });
    return;
  }

  const paged = paginate(results, {
    page,
    perPage: SEARCH_PAGE_SIZE,
    callbackPrefix: "browse:search:page",
    nextLabel: "Ещё",
    prevLabel: "Назад",
  });
  for (const listing of paged.pageItems) {
    const actions: InlineButton[][] = [
      [inlineButton("Открыть", `listing:open:${listing.id}`)],
      [listing.contact === "telegram"
        ? urlButton("Связаться", `tg://user?id=${listing.owner}`)
        : inlineButton("Связаться", `listing:contact:${listing.id}`)],
    ];
    if (listing.contact === "phone" && listing.phone) {
      actions.push([inlineButton("Показать телефон", `listing:phone:${listing.id}`)]);
    }
    const markup = inlineKeyboard(actions);
    if ((listing.photos ?? []).length > 0) {
      await ctx.api.sendPhoto(ctx.chat?.id ?? 0, (listing.photos ?? [])[0], {
        caption: searchCard(listing),
        reply_markup: markup,
      });
    } else {
      await ctx.reply(searchCard(listing), { reply_markup: markup });
    }
  }
  const controls = paged.controls.inline_keyboard;
  if (controls.length > 0) await ctx.reply("Показаны найденные объявления.", { reply_markup: inlineKeyboard(controls) });
}

async function show(ctx: Ctx, page = 0, filters: BrowseFilters = filtersFromSession(ctx)) {
  const d = await loadDomain(ctx);
  const all = d.listings.filter((x) => x.status === "published" && (!filters.category || x.category === filters.category) && (!filters.location || filters.location === "Вся Москва" || x.location === filters.location));
  const p = paginate(all, { page, perPage: 5, callbackPrefix: "browse:page", prevLabel: "Назад", nextLabel: "Ещё" });
  const buttons: InlineButton[][] = p.pageItems.map((x) => [inlineButton(`${x.title.slice(0, 35)} · ${x.location}`, `listing:open:${x.id}`)]);
  const controls = p.controls.inline_keyboard;
  buttons.push([inlineButton("Категория", "browse:categories"), inlineButton("Район", "browse:locations")]);
  if (d.neuralEnabled !== false) buttons.push([inlineButton("Нейросеть", "neural:open")]);
  buttons.push(...controls);
  buttons.push([inlineButton("⬅️ В меню", "menu:main")]);
  const text = all.length
    ? `Свежие объявления (найдено: ${all.length}):`
    : "Пока нет подходящих объявлений — загляните позже.";
  await ctx.reply(text, { reply_markup: inlineKeyboard(buttons) });
}
composer.callbackQuery("browse:start", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "browse-search";
  await ctx.reply("Что вы ищете?", { reply_markup: { force_reply: true, input_field_placeholder: "Например: мастер по ремонту" } });
});
composer.callbackQuery("browse:categories", async (ctx) => {
  await ctx.answerCallbackQuery();
  const rows: InlineButton[][] = [
    [inlineButton("Показать все объявления", "browse:all")],
    ...CATEGORIES.map((x, i) => [inlineButton(x, `browse:cat:${i}`)]),
    [inlineButton("⬅️ Назад", "browse:start")],
  ];
  await ctx.reply("Выберите категорию.", { reply_markup: inlineKeyboard(rows) });
});
composer.callbackQuery("browse:locations", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply("Выберите район.", { reply_markup: inlineKeyboard(LOCATIONS.map((x, i) => [inlineButton(x, `browse:loc:${i}`)]).concat([[inlineButton("⬅️ Назад", "browse:start")]])) }); });
composer.callbackQuery(/^browse:cat:(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); const filters = filtersFromSession(ctx); filters.category = CATEGORIES[Number(ctx.match[1])]; ctx.session.draft = { browseCategory: filters.category, browseLocation: filters.location }; await logBrowseEvent(ctx, "category", filters.category); await show(ctx, 0, filters); });
composer.callbackQuery("browse:all", async (ctx) => { await ctx.answerCallbackQuery(); const filters = filtersFromSession(ctx); filters.category = undefined; ctx.session.draft = { browseLocation: filters.location }; await logBrowseEvent(ctx, "all_categories"); await show(ctx, 0, filters); });
composer.callbackQuery(/^browse:loc:(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); const filters = filtersFromSession(ctx); filters.location = LOCATIONS[Number(ctx.match[1])]; ctx.session.draft = { browseCategory: filters.category, browseLocation: filters.location }; await show(ctx, 0, filters); });
composer.callbackQuery(/^browse:page:(prev|next):(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await show(ctx, Number(ctx.match[2])); });
composer.callbackQuery(/^browse:search:page:(prev|next):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const query = typeof ctx.session.draft?.browseSearchQuery === "string" ? ctx.session.draft.browseSearchQuery : "";
  if (query) await showSearchResults(ctx, query, Number(ctx.match[2]));
});
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "browse-search") return next();
  const query = ctx.message.text.trim();
  if (!query) {
    await ctx.reply("Напишите, что нужно найти.", { reply_markup: { force_reply: true, input_field_placeholder: "Например: мастер по ремонту" } });
    return;
  }
  ctx.session.step = undefined;
  ctx.session.draft = { ...(ctx.session.draft ?? {}), browseSearchQuery: query };
  await showSearchResults(ctx, query, 0, true);
});
composer.callbackQuery(/^listing:open:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); const domain = await loadDomain(ctx); const listing = domain.listings.find((x) => x.id === ctx.match[1]); if (!listing || listing.status !== "published") { await ctx.reply("Это объявление больше недоступно."); return; } const price = listing.price || "договорная"; const author = listing.authorName ?? "Автор объявления"; const text = `${listing.title}\n\n${listing.description}\n\nЦена: ${price}\nМесто: ${listing.location}\nАвтор: ${author}\nФото: ${listing.photos.length}`; const actions: InlineButton[][] = []; if (!listing.ownerDeleted) actions.push([inlineButton("Открыть профиль", `profile:open:${listing.owner}`)]); if (!listing.ownerDeleted) actions.push([listing.contact === "telegram" ? urlButton("Связаться в Telegram", `tg://user?id=${listing.owner}`) : inlineButton("Связаться", `listing:contact:${listing.id}`), inlineButton("Сохранить", `listing:save:${listing.id}`)]); else actions.push([inlineButton("Сохранить", `listing:save:${listing.id}`)]); actions.push([inlineButton("Пожаловаться", `listing:report:${listing.id}`), inlineButton("⬅️ Назад", "browse:start")]); await ctx.reply(text, { reply_markup: inlineKeyboard(actions) }); const ownerProfile = domain.userProfiles?.find((profile) => profile.userId === listing.owner); const avatar = ownerProfile?.avatarThumbnailFileId ?? ownerProfile?.avatarFileId; if (avatar && !listing.ownerDeleted) await ctx.api.sendPhoto(ctx.chat?.id ?? listing.owner, avatar, { caption: "Аватар автора" }); });
composer.callbackQuery(/^listing:contact:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); const x = (await loadDomain(ctx)).listings.find((v) => v.id === ctx.match[1]); if (!x) { await ctx.reply("Объявление не найдено."); return; } if (x.contact === "phone" && x.phone) { await ctx.reply("Номер можно открыть после подтверждения.", { reply_markup: inlineKeyboard([[inlineButton("Показать номер", `listing:phone:${x.id}`)], [inlineButton("Назад", `listing:open:${x.id}`)]]) }); } else await ctx.reply("Откройте профиль автора в Telegram, чтобы написать ему.", { reply_markup: inlineKeyboard([[urlButton("Открыть Telegram", `tg://user?id=${x.owner}`)]]) }); });
composer.callbackQuery(/^listing:phone:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); const x = (await loadDomain(ctx)).listings.find((v) => v.id === ctx.match[1]); if (!x?.phone) { await ctx.reply("Автор не оставил номер для связи."); return; } await ctx.reply("Номер будет виден только вам. Открыть его?", { reply_markup: inlineKeyboard([[inlineButton("Открыть номер", `listing:phone:reveal:${x.id}`)], [inlineButton("Отмена", `listing:open:${x.id}`)]]) }); });
composer.callbackQuery(/^listing:phone:reveal:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); const x = (await loadDomain(ctx)).listings.find((v) => v.id === ctx.match[1]); if (!x?.phone || x.contact !== "phone") { await ctx.reply("Автор не оставил номер для связи."); return; } await ctx.reply(`Номер автора: ${x.phone}`); });
composer.callbackQuery(/^listing:save:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); const user = ctx.from?.id ?? 0; await changeDomain(ctx, (d) => { const i = d.saved.findIndex((s) => s.user === user && s.listing === ctx.match[1]); if (i >= 0) d.saved.splice(i, 1); else d.saved.push({ user, listing: ctx.match[1] }); }); await ctx.reply("Сохранение обновлено."); });
export default composer;
