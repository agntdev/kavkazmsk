import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  adminChatId, inlineButton, inlineKeyboard, registerMainMenuItem, requireOwner,
  urlButton, type InlineButton,
} from "../toolkit/index.js";
import {
  changeDomain, loadDomain, nextId, now, queueNotification,
  type UserProfile, type UserReview,
} from "../domain.js";

registerMainMenuItem({ label: "👤 Мой профиль", data: "profile:me", order: 35 });

const composer = new Composer<Ctx>();
const force = (placeholder: string) => ({ force_reply: true as const, input_field_placeholder: placeholder });
const stars = (rating: number) => "★".repeat(rating) + "☆".repeat(5 - rating);

function profileKeyboard(targetId: number, self: boolean, hasPhone: boolean, hasAvatar: boolean): InlineButton[][] {
  const rows: InlineButton[][] = [[inlineButton("Оставить отзыв", `profile:review:start:${targetId}`)]];
  if (self) {
    rows.push([inlineButton("✏️ Настроить профиль", "profile:settings")]);
    rows.push([inlineButton(hasPhone ? "Изменить телефон" : "Добавить телефон", "profile:phone:edit")]);
    rows.push([inlineButton(hasAvatar ? "Изменить фото" : "Добавить фото", "profile:photo:start")]);
    rows.push([inlineButton("Удалить профиль", "profile:delete")]);
  } else {
    rows.push([urlButton("Написать в Telegram", `tg://user?id=${targetId}`)]);
    if (hasPhone) rows.push([inlineButton("Показать телефон", `profile:phone:${targetId}`)]);
  }
  rows.push([inlineButton("⬅️ В меню", "menu:main")]);
  return rows;
}

function userFor(domain: Awaited<ReturnType<typeof loadDomain>>, userId: number, ctx: Ctx) {
  const users = (domain.users ??= []);
  let user = users.find((item) => item.id === userId);
  if (!user) {
    user = { id: userId, username: ctx.from?.username, displayName: ctx.from?.first_name ?? "Участник", banned: false, joinedAt: now() };
    users.push(user);
  }
  return user;
}

function profileFor(domain: Awaited<ReturnType<typeof loadDomain>>, userId: number, name = "Участник"): UserProfile {
  const found = domain.userProfiles?.find((profile) => profile.userId === userId);
  if (found) return found;
  const created: UserProfile = {
    userId, displayName: name, avgRating: 0, totalReviews: 0, createdAt: now(), updatedAt: now(),
  };
  (domain.userProfiles ??= []).push(created);
  return created;
}

function reviewLine(review: UserReview): string {
  const date = new Date(review.createdAt).toLocaleDateString("ru-RU");
  return `${stars(review.rating)} · ${date}${review.text ? `\n${review.text}` : ""}`;
}

async function showProfile(ctx: Ctx, targetId: number): Promise<void> {
  let text = "";
  let profile: UserProfile;
  let reviews: UserReview[] = [];
  let own = false;
  let phone = "";
  let avatar: string | undefined;
  await changeDomain(ctx, (domain) => {
    profile = profileFor(domain, targetId, targetId === ctx.from?.id ? (ctx.from.first_name ?? "Участник") : "Участник");
    reviews = (domain.userReviews ?? []).filter((review) => review.targetUserId === targetId && review.status === "approved").sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
    text = `Профиль ${profile.displayName}\n\n` +
      `${profile.neighbourhood ? `Район: ${profile.neighbourhood}\n` : ""}` +
      `${profile.bio ? `\n${profile.bio}\n` : ""}` +
      `Рейтинг: ${profile.totalReviews ? `${profile.avgRating.toFixed(1)} / 5 ${stars(Math.round(profile.avgRating))}` : "пока нет оценок"} (${profile.totalReviews} отзывов)`;
    if (reviews.length) text += `\n\nПоследние отзывы:\n\n${reviews.map(reviewLine).join("\n\n")}`;
    own = targetId === (ctx.from?.id ?? 0);
    const user = domain.users?.find((item) => item.id === targetId);
    phone = own ? (user?.phone ?? "") : "";
    avatar = profile.avatarThumbnailFileId ?? profile.avatarFileId;
    if (own && phone) text += `\nТелефон: ${phone}`;
  });
  const targetUser = (await loadDomain(ctx)).users?.find((user) => user.id === targetId);
  const hasPhone = Boolean(targetUser?.phone);
  const rows = profileKeyboard(targetId, own, hasPhone, Boolean(avatar));
  for (const review of reviews) rows.push([inlineButton("Пожаловаться на отзыв", `review:flag:${review.id}`)]);
  await ctx.reply(text, { reply_markup: inlineKeyboard(rows) });
  if (avatar) await ctx.api.sendPhoto(ctx.chat?.id ?? targetId, avatar, { caption: own ? "Ваш круглый аватар" : "Аватар участника" });
}

composer.command("profile", async (ctx) => {
  const value = ctx.match.trim();
  const targetId = value ? Number(value) : ctx.from?.id;
  if (!targetId || !Number.isSafeInteger(targetId)) {
    await ctx.reply("Укажите профиль, который хотите открыть, или нажмите кнопку «Мой профиль».");
    return;
  }
  await showProfile(ctx, targetId);
});

composer.callbackQuery("profile:me", async (ctx) => { await ctx.answerCallbackQuery(); await showProfile(ctx, ctx.from?.id ?? 0); });
composer.callbackQuery("profile:settings", async (ctx) => { await ctx.answerCallbackQuery(); await showProfile(ctx, ctx.from?.id ?? 0); });
composer.callbackQuery(/^profile:open:(\d+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await showProfile(ctx, Number(ctx.match[1])); });
composer.callbackQuery(/^profile:phone:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const target = Number(ctx.match[1]);
  const user = (await loadDomain(ctx)).users?.find((item) => item.id === target);
  if (!user?.phone) { await ctx.reply("Участник не оставил номер для связи."); return; }
  await ctx.reply("Номер будет виден только вам. Открыть его?", { reply_markup: inlineKeyboard([[inlineButton("Открыть номер", `profile:phone:reveal:${target}`)], [inlineButton("Отмена", `profile:open:${target}`)]]) });
});
composer.callbackQuery(/^profile:phone:reveal:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const user = (await loadDomain(ctx)).users?.find((item) => item.id === Number(ctx.match[1]));
  await ctx.reply(user?.phone ? `Номер участника: ${user.phone}` : "Участник не оставил номер для связи.");
});

composer.callbackQuery("profile:phone:edit", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "profile-phone";
  await ctx.reply("Напишите номер телефона. Он останется скрытым, пока другой участник не подтвердит просмотр.", { reply_markup: force("Например: +7 900 000-00-00") });
});

composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "profile-phone") return next();
  const value = ctx.message.text.trim();
  if (!/[+()\d][\d ()-]{5,}/.test(value) || value.replace(/\D/g, "").length < 7) {
    await ctx.reply("Похоже, номер слишком короткий. Проверьте его и отправьте ещё раз.", { reply_markup: force("Например: +7 900 000-00-00") });
    return;
  }
  const userId = ctx.from?.id ?? 0;
  await changeDomain(ctx, (domain) => {
    const user = userFor(domain, userId, ctx);
    user.phone = value;
    user.phoneVerified = false;
    const profile = profileFor(domain, userId, ctx.from?.first_name ?? "Участник");
    profile.updatedAt = now();
  });
  ctx.session.step = undefined;
  await ctx.reply("Телефон сохранён. Другие участники увидят его только после подтверждения.", { reply_markup: inlineKeyboard([[inlineButton("Открыть профиль", "profile:me")]]) });
});

composer.callbackQuery("profile:photo:start", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "profile-photo";
  await ctx.reply("Пришлите фото — я сохраню небольшой центрированный аватар и покажу его в профиле.", { reply_markup: inlineKeyboard([[inlineButton("Отмена", "profile:photo:cancel")]]) });
});

composer.callbackQuery("profile:photo:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = undefined;
  await ctx.editMessageText("Изменение фото отменено.", { reply_markup: inlineKeyboard([[inlineButton("Открыть профиль", "profile:me")]]) });
});

composer.on("message:photo", async (ctx, next) => {
  if (ctx.session.step !== "profile-photo") return next();
  const photos = ctx.message.photo;
  const source = photos[photos.length - 1];
  const thumbnail = photos[0];
  const userId = ctx.from?.id ?? 0;
  await changeDomain(ctx, (domain) => {
    const profile = profileFor(domain, userId, ctx.from?.first_name ?? "Участник");
    profile.avatarFileId = source.file_id;
    profile.avatarThumbnailFileId = thumbnail.file_id;
    profile.avatarCrop = "centered-circle";
    profile.updatedAt = now();
    const user = userFor(domain, userId, ctx);
    user.avatarFileId = source.file_id;
  });
  ctx.session.step = undefined;
  await ctx.api.sendPhoto(ctx.chat?.id ?? userId, source.file_id, { caption: "Ваш круглый аватар готов." });
  await ctx.reply("Фото профиля обновлено.", { reply_markup: inlineKeyboard([[inlineButton("Открыть профиль", "profile:me")]]) });
});

composer.callbackQuery("profile:delete", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("Удаление профиля уберёт телефон, фото, рейтинг и отзывы. Ваши объявления останутся, но будут показаны как «Удалённый пользователь» без контактов.", { reply_markup: inlineKeyboard([[inlineButton("Продолжить удаление", "profile:delete:warning")], [inlineButton("Отмена", "profile:me")]]) });
});

composer.callbackQuery("profile:delete:warning", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Профиль будет удалён без возможности восстановления. Объявления сохранятся обезличенными. Подтвердить?", { reply_markup: inlineKeyboard([[inlineButton("Подтвердить", "profile:delete:confirm"), inlineButton("Отмена", "profile:me")]]) });
});

composer.callbackQuery("profile:delete:confirm", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id ?? 0;
  const deletedAt = now();
  await changeDomain(ctx, (domain) => {
    for (const listing of domain.listings) {
      if (listing.owner === userId) {
        listing.owner = 0;
        listing.ownerDeleted = true;
        listing.authorName = "Удалённый пользователь";
        listing.phone = undefined;
        listing.contact = "telegram";
        listing.updatedAt = deletedAt;
        domain.history.push({ listingId: listing.id, action: "profile_deleted", by: userId, at: deletedAt });
      }
    }
    domain.userProfiles = (domain.userProfiles ?? []).filter((profile) => profile.userId !== userId);
    domain.userReviews = (domain.userReviews ?? []).filter((review) => review.reviewerId !== userId && review.targetUserId !== userId);
    domain.users = (domain.users ?? []).filter((user) => user.id !== userId);
    domain.saved = domain.saved.filter((saved) => saved.user !== userId);
  });
  const notice = `Профиль удалён пользователем ${userId}. Время: ${new Date(deletedAt).toISOString()}`;
  const admin = adminChatId(ctx);
  if (admin) {
    try { await ctx.api.sendMessage(admin, notice); } catch { await changeDomain(ctx, (domain) => queueNotification(domain, "profile-deleted", notice)); }
  } else await changeDomain(ctx, (domain) => queueNotification(domain, "profile-deleted", notice));
  ctx.session.step = undefined;
  ctx.session.draft = undefined;
  await ctx.reply("Профиль удалён. Ваши объявления обезличены, а личные данные удалены.", { reply_markup: inlineKeyboard([[inlineButton("Открыть меню", "menu:main")]]) });
});

composer.callbackQuery(/^profile:review:start:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const target = Number(ctx.match[1]);
  if (target === (ctx.from?.id ?? 0)) { await ctx.reply("Свой профиль нельзя оценить. Выберите профиль другого участника."); return; }
  const domain = await loadDomain(ctx);
  const reviewer = ctx.from?.id ?? 0;
  const existing = (domain.userReviews ?? []).find((review) => review.reviewerId === reviewer && review.targetUserId === target);
  if (existing) { await ctx.reply("Вы уже оставляли отзыв этому участнику. Изменить его пока нельзя."); return; }
  ctx.session.step = "review-rating";
  ctx.session.draft = { reviewTarget: target };
  await ctx.reply("Как оцените этого участника?", {
    reply_markup: inlineKeyboard([
      [1, 2, 3, 4, 5].map((n) => inlineButton(`${n} ${stars(n)}`, `profile:review:rating:${n}`)),
      [inlineButton("Отмена", "profile:review:cancel")],
    ]),
  });
});

composer.callbackQuery(/^profile:review:rating:([1-5])$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.session.step !== "review-rating") { await ctx.reply("Отзыв уже закрыт. Откройте профиль и начните снова."); return; }
  ctx.session.step = "review-text";
  ctx.session.draft = { ...(ctx.session.draft ?? {}), reviewRating: Number(ctx.match[1]) };
  await ctx.reply("Напишите пару добрых слов или нажмите «Без текста».", { reply_markup: inlineKeyboard([[inlineButton("Без текста", "profile:review:no-text")], [inlineButton("Отмена", "profile:review:cancel")]]), });
});

async function askVideo(ctx: Ctx): Promise<void> {
  ctx.session.step = "review-video";
  await ctx.reply("Добавьте короткое видео или пропустите этот шаг. Максимум 30 секунд и 10 МБ.", { reply_markup: inlineKeyboard([[inlineButton("Пропустить", "profile:review:no-video")], [inlineButton("Отмена", "profile:review:cancel")]]) });
}

composer.callbackQuery("profile:review:no-text", async (ctx) => { await ctx.answerCallbackQuery(); await askVideo(ctx); });
composer.on("message:text", async (ctx, next) => {
  if (ctx.session.step !== "review-text") return next();
  const text = ctx.message.text.trim();
  if (!text || text.length > 1000) { await ctx.reply("Текст отзыва должен быть до 1000 символов. Попробуйте ещё раз.", { reply_markup: force("Ваш отзыв") }); return; }
  ctx.session.draft = { ...(ctx.session.draft ?? {}), reviewText: text };
  await askVideo(ctx);
});

composer.callbackQuery("profile:review:no-video", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "review-confirm";
  await ctx.reply("Проверьте отзыв перед отправкой.", { reply_markup: inlineKeyboard([[inlineButton("Отправить", "profile:review:confirm")], [inlineButton("Отмена", "profile:review:cancel")]]) });
});

composer.on("message:video", async (ctx, next) => {
  if (ctx.session.step !== "review-video") return next();
  const video = ctx.message.video;
  if ((video.duration ?? 0) > 30 || (video.file_size ?? 0) > 10 * 1024 * 1024) {
    await ctx.reply("Видео слишком большое. Нужен ролик до 30 секунд и 10 МБ — попробуйте ещё раз.");
    return;
  }
  ctx.session.draft = { ...(ctx.session.draft ?? {}), reviewVideo: video.file_id };
  ctx.session.step = "review-confirm";
  await ctx.reply("Видео добавлено. Отправить отзыв на проверку?", { reply_markup: inlineKeyboard([[inlineButton("Отправить", "profile:review:confirm")], [inlineButton("Отмена", "profile:review:cancel")]]) });
});

composer.callbackQuery("profile:review:cancel", async (ctx) => { await ctx.answerCallbackQuery(); ctx.session.step = undefined; ctx.session.draft = undefined; await ctx.editMessageText("Отзыв не сохранён."); });

composer.callbackQuery("profile:review:confirm", async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = ctx.session.draft ?? {};
  const reviewer = ctx.from?.id ?? 0;
  const target = Number(draft.reviewTarget);
  const rating = Number(draft.reviewRating);
  if (!target || !rating) { await ctx.reply("Не удалось собрать отзыв. Откройте профиль и начните снова."); return; }
  let result: "saved" | "duplicate" | "limited" | "spam" = "saved";
  let review!: UserReview;
  await changeDomain(ctx, (domain) => {
    const reviews = (domain.userReviews ??= []);
    const previous = reviews.find((item) => item.reviewerId === reviewer && item.targetUserId === target);
    if (previous) { result = "duplicate"; return; }
    const day = 24 * 60 * 60 * 1000;
    if (reviews.some((item) => item.reviewerId === reviewer && item.targetUserId === target && now() - item.createdAt < day)) { result = "limited"; return; }
    const normalized = typeof draft.reviewText === "string" ? draft.reviewText.trim().toLocaleLowerCase("ru-RU") : "";
    if (normalized && reviews.some((item) => item.reviewerId === reviewer && item.text?.trim().toLocaleLowerCase("ru-RU") === normalized && now() - item.createdAt < day)) { result = "spam"; return; }
    const user = domain.users?.find((item) => item.id === reviewer);
    const approved = domain.reviewAutoApprove === true && user?.phoneVerified === true && !reviews.some((item) => item.reviewerId === reviewer && item.status === "rejected");
    review = { id: nextId("review"), reviewerId: reviewer, targetUserId: target, rating, text: typeof draft.reviewText === "string" ? draft.reviewText : undefined, videoFileId: typeof draft.reviewVideo === "string" ? draft.reviewVideo : undefined, status: approved ? "approved" : "pending", flaggedCount: 0, createdAt: now(), updatedAt: now() };
    reviews.push(review);
    if (approved) recalculate(domain, target);
  });
  ctx.session.step = undefined; ctx.session.draft = undefined;
  if (result !== "saved") { await ctx.reply(result === "spam" ? "Похоже, такой отзыв уже отправлялся недавно." : "Вы уже оставляли отзыв этому участнику."); return; }
  const message = review.status === "approved" ? "Отзыв опубликован — спасибо, что поделились впечатлением!" : "Спасибо! Отзыв отправлен на проверку. Мы сообщим, когда он появится в профиле.";
  await ctx.reply(message, { reply_markup: inlineKeyboard([[inlineButton("Открыть профиль", `profile:open:${target}`)]]) });
  const admin = adminChatId(ctx);
  const notice = `Новый отзыв на проверку\nОценка: ${stars(review.rating)}${review.text ? `\n${review.text}` : ""}`;
  if (review.status === "pending") {
    if (admin) { try { await ctx.api.sendMessage(admin, notice, { reply_markup: inlineKeyboard([[inlineButton("Одобрить", `review:approve:${review.id}`), inlineButton("Отклонить", `review:reject:${review.id}`)], [inlineButton("Удалить", `review:remove:${review.id}`), inlineButton("Заблокировать автора", `review:ban:${review.id}`)]]) }); } catch { await changeDomain(ctx, (domain) => queueNotification(domain, "review", notice)); } }
    else await changeDomain(ctx, (domain) => queueNotification(domain, "review", notice));
  }
  try {
    await ctx.api.sendMessage(target, review.status === "approved" ? "Ваш профиль получил новый отзыв — он уже опубликован." : "На ваш профиль оставили новый отзыв. Он появится после проверки.", {
      reply_markup: inlineKeyboard([[inlineButton("Открыть профиль", `profile:open:${target}`)], [inlineButton("Пожаловаться", `review:flag:${review.id}`)]]),
    });
  } catch { /* A user may have blocked the bot; the review remains durable. */ }
});

function recalculate(domain: Awaited<ReturnType<typeof loadDomain>>, target: number): void {
  const approved = (domain.userReviews ?? []).filter((item) => item.targetUserId === target && item.status === "approved");
  const profile = profileFor(domain, target);
  profile.totalReviews = approved.length;
  profile.avgRating = approved.length ? approved.reduce((sum, item) => sum + item.rating, 0) / approved.length : 0;
  profile.updatedAt = now();
}

async function moderateReview(ctx: Ctx, action: "approve" | "reject" | "remove" | "ban", id: string): Promise<void> {
  if (!(await requireOwner(ctx))) return;
  let target = 0; let found = false;
  await changeDomain(ctx, (domain) => {
    const review = domain.userReviews?.find((item) => item.id === id);
    if (!review) return;
    found = true; target = review.targetUserId;
    if (action === "approve") review.status = "approved";
    if (action === "reject" || action === "remove") review.status = "rejected";
    if (action === "ban" && !domain.banned.includes(review.reviewerId)) domain.banned.push(review.reviewerId);
    review.updatedAt = now();
    recalculate(domain, target);
  });
  if (!found) { await ctx.editMessageText("Этот отзыв уже обработан или не найден."); return; }
  await ctx.editMessageText(action === "approve" ? "Отзыв опубликован." : action === "ban" ? "Автор отзыва заблокирован." : "Отзыв скрыт.");
  if (action === "approve") {
    try {
      await ctx.api.sendMessage(target, "Ваш отзыв одобрен и теперь виден в профиле.", { reply_markup: inlineKeyboard([[inlineButton("Открыть профиль", `profile:open:${target}`)]]) });
    } catch { /* A blocked user must not break moderation. */ }
  }
}

composer.callbackQuery(/^review:(approve|reject|remove|ban):(.+)$/, async (ctx) => { await ctx.answerCallbackQuery(); await moderateReview(ctx, ctx.match[1] as "approve" | "reject" | "remove" | "ban", ctx.match[2]); });
composer.callbackQuery(/^review:flag:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  let flagged = false; let hidden = false; let notice = "";
  await changeDomain(ctx, (domain) => { const review = domain.userReviews?.find((item) => item.id === ctx.match[1] && item.status === "approved"); if (review) { review.flaggedCount += 1; flagged = true; if (review.flaggedCount >= 3) { review.status = "rejected"; hidden = true; recalculate(domain, review.targetUserId); notice = `Отзыв ${review.id} автоматически скрыт после трёх жалоб.`; } } });
  if (hidden) {
    const admin = adminChatId(ctx);
    if (admin) { try { await ctx.api.sendMessage(admin, notice); } catch { await changeDomain(ctx, (domain) => queueNotification(domain, "review-flag", notice)); } }
    else await changeDomain(ctx, (domain) => queueNotification(domain, "review-flag", notice));
  }
  await ctx.reply(flagged ? "Спасибо, жалоба принята. Мы проверим отзыв." : "Этот отзыв уже недоступен.");
});

composer.command("reviews", async (ctx) => {
  if (!(await requireOwner(ctx))) return;
  const query = ctx.match.trim();
  const reviews = (await loadDomain(ctx)).userReviews?.filter((item) => item.status === "pending" && (!query || String(item.targetUserId) === query || String(item.reviewerId) === query)).slice(-10) ?? [];
  await ctx.reply(reviews.length ? `На проверке отзывов: ${reviews.length}` : "На проверке пока нет отзывов.");
});

export default composer;
