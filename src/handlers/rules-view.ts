import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard, registerMainMenuItem } from "../toolkit/index.js";
registerMainMenuItem({ label: "📜 Правила", data: "rules:view", order: 40 });
const composer = new Composer<Ctx>();
composer.callbackQuery("rules:view", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply("Публикуйте честные объявления о товарах, услугах, работе и жилье. Запрещены мошенничество, незаконные товары, угрозы, спам и чужие персональные данные.\n\nЕсли заметили нарушение, откройте объявление и нажмите «Пожаловаться».", { reply_markup: inlineKeyboard([[inlineButton("⬅️ В меню", "menu:main")]]) }); });
export default composer;
