import type { NextFunction, Request, Response } from "express";
import { InputFile, type Bot } from "grammy";
import multer from "multer";
import type { MyContext } from "../../context.js";
import type { User } from "../../types.js";
import { validOptionalCaption } from "../broadcastFormatting.js";
import {
  broadcastToAll,
  BroadcastInProgressError,
} from "../broadcastService.js";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => {
    const pdfName = decodeMulterFilename(file.originalname).toLowerCase().endsWith(".pdf");
    const pdfMime = file.mimetype === "application/pdf";
    callback(null, pdfName && pdfMime);
  },
}).single("file");

export function hasPdfSignature(buffer: Buffer): boolean {
  return buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

export function adminPdfUpload(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  upload(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ success: false, error: "file_too_large" });
      return;
    }
    if (err) {
      res.status(400).json({ success: false, error: "invalid_file" });
      return;
    }
    next();
  });
}

/**
 * Multer/busboy historically exposes UTF-8 names as latin1. If the string is
 * already real Unicode, leave it alone.
 */
export function decodeMulterFilename(original: string): string {
  if ([...original].some((ch) => ch.charCodeAt(0) > 255)) return original;
  const decoded = Buffer.from(original, "latin1").toString("utf8");
  return decoded.includes("\uFFFD") ? original : decoded;
}

/** Keep letters (including non-ASCII), digits, and a small safe punctuation set. */
export function safeFilename(original: string): string {
  const base = decodeMulterFilename(original).replace(/^.*[/\\]/, "");
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N}._ ()'+-]/gu, "_")
    .replace(/_+/g, "_")
    .trim();
  if (!cleaned || cleaned === ".pdf") return "document.pdf";
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
}

/**
 * grammy writes `filename=${name}` without quotes. Wrap so Telegram does not
 * truncate at the first space ("Monday Fast.pdf" → "Monday").
 */
export function telegramUploadFilename(filename: string): string {
  return `"${filename.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function createPdfSender(
  bot: Bot<MyContext>,
  buffer: Buffer,
  filename: string,
  caption?: string
): (user: User) => Promise<void> {
  let telegramFileId: string | undefined;
  return async (user: User): Promise<void> => {
    const document = telegramFileId ?? new InputFile(buffer, telegramUploadFilename(filename));
    const sent = await bot.api.sendDocument(user.telegram_id, document, {
      caption,
    });
    telegramFileId ??= sent.document?.file_id;
  };
}

export function createBroadcastFileRoute(bot: Bot<MyContext>) {
  return async (req: Request, res: Response): Promise<void> => {
    const file = req.file;
    if (!file || !hasPdfSignature(file.buffer)) {
      res.status(400).json({ success: false, error: "invalid_pdf" });
      return;
    }
    if (!validOptionalCaption(req.body?.message)) {
      res.status(400).json({ success: false, error: "invalid_caption" });
      return;
    }

    const caption = req.body?.message?.trim() || undefined;
    const filename = safeFilename(file.originalname);

    try {
      const result = await broadcastToAll(
        createPdfSender(bot, file.buffer, filename, caption)
      );
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
