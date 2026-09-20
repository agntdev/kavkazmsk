import { buildBot } from "./bot.js";
import { setDefaultCommands } from "./toolkit/index.js";

async function main() {
  const token = process.env.BOT_TOKEN?.trim();
  if (!token) {
    console.error("BOT_TOKEN is required. Add the Telegram bot token to the service secrets.");
    process.exit(1);
  }
  const bot = await buildBot(token);
  // Fail during deployment/startup, with Telegram's actual diagnostic, instead
  // of spawning polling against an invalid token and looking "alive" while
  // every update is rejected. This also catches a revoked token before we
  // publish the command menu.
  await bot.init();
  // Publish the "/" command list to Telegram (discoverability). A button-first
  // bot exposes only /start + /help; everything else is reached via menu buttons.
  await setDefaultCommands(bot);
  void bot.start({
    onStart: ({ username }) => console.log(`KavkazMsk is running as @${username}`),
  }).catch((err) => {
    // Polling setup errors (for example an occupied token or revoked token)
    // otherwise become an unhandled rejection after main() has returned.
    console.error("Telegram polling stopped during startup:", err);
    process.exitCode = 1;
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
