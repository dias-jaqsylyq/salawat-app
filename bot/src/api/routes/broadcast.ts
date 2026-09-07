import type { Request, Response } from "express";
import type { Bot } from "grammy";
import type { MyContext } from "../../context.js";
import {
  adminMarkdownToTelegramHtml,
  validHttpUrl,
  validMessage,
  validOptionalCaption,
} from "../broadcastFormatting.js";
import {
  broadcastToAll,
  BroadcastInProgressError,
} from "../broadcastService.js";

interface BroadcastBody {
  type?: unknown;
  message?: unknown;
  url?: unknown;
  fileUrl?: unknown;
}

function invalid(res: Response, error: string): void {
  res.status(400).json({ success: false, error });
}

export function createBroadcastRoute(bot: Bot<MyContext>) {
  return async (req: Request, res: Response): Promise<void> => {
    const body = req.body as BroadcastBody | undefined;
    if (
      !body ||
      typeof body.type !== "string" ||
      !["text", "link", "file"].includes(body.type)
    ) {
      invalid(res, "invalid_broadcast_type");
      return;
    }

    try {
      if (body.type === "text") {
        if (!validMessage(body.message)) {
          invalid(res, "invalid_message");
          return;
        }
        const html = adminMarkdownToTelegramHtml(body.message.trim());
        const result = await broadcastToAll(async (user) => {
          await bot.api.sendMessage(user.telegram_id, html, {
            parse_mode: "HTML",
          });
        });
        res.json({ success: true, ...result });
        return;
      }

      if (body.type === "link") {
        if (
          typeof body.url !== "string" ||
          !validHttpUrl(body.url) ||
          !validOptionalCaption(body.message)
        ) {
          invalid(res, "invalid_link");
          return;
        }
        const caption =
          typeof body.message === "string" ? body.message.trim() : undefined;
        const text = caption ? `${caption}\n\n${body.url}` : body.url;
        const result = await broadcastToAll(async (user) => {
          await bot.api.sendMessage(user.telegram_id, text);
        });
        res.json({ success: true, ...result });
        return;
      }

      if (
        typeof body.fileUrl !== "string" ||
        !validHttpUrl(body.fileUrl, true) ||
        !validOptionalCaption(body.message)
      ) {
        invalid(res, "invalid_file_url");
        return;
      }
      const caption =
        typeof body.message === "string" ? body.message.trim() || undefined : undefined;
      const fileUrl = body.fileUrl;
      const result = await broadcastToAll(async (user) => {
        await bot.api.sendDocument(user.telegram_id, fileUrl, {
          caption,
        });
      });
      res.json({ success: true, ...result });
    } catch (err) {
      if (err instanceof BroadcastInProgressError) {
        res.status(409).json({ success: false, error: "broadcast_in_progress" });
        return;
      }
      throw err;
    }
  };
}
