import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { CATEGORIES } from "../domain.js";
import { inlineButton, inlineKeyboard, registerMainMenuItem, type InlineButton } from "../toolkit/index.js";

registerMainMenuItem({ label: "Все категории", data: "all_categories", order: 15 });

const composer = new Composer<Ctx>();

/**
 * The home-menu entry opens the same category picker used by Browse. Keeping
 * the callback separate makes the entry discoverable without adding a second
 * command, while the resulting buttons continue through Browse's filters.
 */
composer.callbackQuery("all_categories", async (ctx) => {
  await ctx.answerCallbackQuery();
  const rows: InlineButton[][] = [
    [inlineButton("Показать все объявления", "browse:all")],
    ...CATEGORIES.map((category, index) => [inlineButton(category, `browse:cat:${index}`)]),
    [inlineButton("⬅️ Назад", "menu:main")],
  ];
  await ctx.reply("Выберите категорию.", { reply_markup: inlineKeyboard(rows) });
});

export default composer;
