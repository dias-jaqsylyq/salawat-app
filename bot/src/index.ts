import "./db/client.js";
import { config } from "./config.js";
import { createBot, setupMenuButton } from "./bot.js";
import { startBackupScheduler } from "./scheduler/backup.js";
import { startReminderScheduler } from "./scheduler/reminder.js";
import { startFastingReminderScheduler } from "./scheduler/fastingReminder.js";
import { createApiServer } from "./api/server.js";

const bot = createBot();

startReminderScheduler(bot);
startFastingReminderScheduler(bot);
startBackupScheduler();

if (config.miniAppUrlIsPlaceholder) {
  console.error(
    "MINI_APP_URL is unset or still a placeholder — skipping chat menu button setup. Set the real Vercel HTTPS URL and redeploy."
  );
} else {
  try {
    await setupMenuButton(bot);
  } catch (err) {
    console.error("Failed to set chat menu button (continuing without it):", err);
  }
}

createApiServer(bot).listen(config.port, () => {
  console.log(`API server listening on port ${config.port}`);
});

bot.start({
  onStart: (botInfo) => {
    console.log(`Salawat Challenge bot started as @${botInfo.username}`);
  },
});
