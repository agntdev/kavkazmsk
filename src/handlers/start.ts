import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { mainMenuKeyboard } from "../toolkit/index.js";
import { loadDomain } from "../domain.js";
import { sendMainScreen } from "./banners.js";

// The /start handler renders the bot's MAIN MENU — the primary way users operate
// a button-first bot. A feature adds its own button by calling
// `registerMainMenuItem(...)` in its own `src/handlers/<slug>.ts`; this handler
// renders whatever is registered (plus a Help button), so you do NOT edit this
// file to add a feature. Send ONE message — no placeholder line above the menu.
const composer = new Composer<Ctx>();

const WELCOME = "👋 Добро пожаловать! Здесь можно быстро найти или разместить объявление.";

async function menu(ctx: Ctx) {
  const domain = await loadDomain(ctx);
  return mainMenuKeyboard(2, domain.neuralEnabled === false ? new Set(["neural:open"]) : undefined);
}

composer.command("start", async (ctx) => {
  await sendMainScreen(ctx, WELCOME, await menu(ctx));
});

// "Back to menu" — re-render the main menu in place from any sub-view.
composer.callbackQuery("menu:main", async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendMainScreen(ctx, WELCOME, await menu(ctx));
});

export default composer;
