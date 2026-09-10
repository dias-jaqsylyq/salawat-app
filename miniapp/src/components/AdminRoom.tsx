import { useState, type FormEvent } from "react";
import { Check, Copy, KeyRound, RotateCw, Share2 } from "lucide-react";
import { patchAdminRoom, setRoomPassword } from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import type { AdminRoomResponse } from "../api/types.ts";
import { copyText } from "../lib/clipboard.ts";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

/** Must stay in sync with salawat-bot utils/roomPassword.ts. */
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 64;
/** Telegram's start-payload charset — anything else makes an unusable invite link. */
const PASSWORD_PATTERN = /^[A-Za-z0-9_-]+$/;

const COPIED_MS = 1500;

interface Props {
  initData: string;
  room: AdminRoomResponse | null;
  loading: boolean;
  /** Load error from the parent's GET /api/admin/room. */
  error: string | null;
  /** Called with the server's new room state after any successful change. */
  onRoomChanged: (room: AdminRoomResponse) => void;
}

function validatePassword(value: string): string | null {
  if (value.length < MIN_PASSWORD_LENGTH || value.length > MAX_PASSWORD_LENGTH) {
    return `Password must be ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} characters.`;
  }
  if (!PASSWORD_PATTERN.test(value)) {
    return "Use only letters, digits, hyphens and underscores.";
  }
  return null;
}

/** Copy button that confirms in place — there is no toast system in this app. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const ok = await copyText(value);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), COPIED_MS);
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0"
      onClick={() => void handleCopy()}
      aria-label={label}
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

export default function AdminRoom({ initData, room, loading, error, onRoomChanged }: Props) {
  const [customPassword, setCustomPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [savingCategories, setSavingCategories] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (loading && !room) {
    return (
      <Card>
        <CardContent className="py-6">
          <p className="text-sm text-muted-foreground">Loading room…</p>
        </CardContent>
      </Card>
    );
  }

  if (!room) {
    return (
      <Card>
        <CardContent className="py-6">
          <p role="alert" className="text-sm text-destructive">
            {error ?? "Couldn't load this room."}
          </p>
        </CardContent>
      </Card>
    );
  }

  async function handleRegenerate() {
    if (savingPassword) return;
    const confirmed = window.confirm(
      "Generate a new room password?\n\nThe old password and invite link stop working. " +
        "Everyone already in the room stays in — only new joins are affected."
    );
    if (!confirmed) return;

    setSavingPassword(true);
    setPasswordError(null);
    setNotice(null);
    try {
      onRoomChanged(await setRoomPassword(initData));
      setCustomPassword("");
      setNotice("New password generated. Share the new link.");
    } catch (err) {
      setPasswordError(messageForApiError(err, "Couldn't generate a new password."));
    } finally {
      setSavingPassword(false);
    }
  }

  async function handleSetPassword(event: FormEvent) {
    event.preventDefault();
    if (savingPassword) return;

    const trimmed = customPassword.trim();
    const validationError = validatePassword(trimmed);
    if (validationError) {
      setPasswordError(validationError);
      return;
    }

    setSavingPassword(true);
    setPasswordError(null);
    setNotice(null);
    try {
      onRoomChanged(await setRoomPassword(initData, trimmed));
      setCustomPassword("");
      setNotice("Password updated. Share the new link.");
    } catch (err) {
      setPasswordError(messageForApiError(err, "Couldn't set that password."));
    } finally {
      setSavingPassword(false);
    }
  }

  async function handleToggleCategories(checked: boolean) {
    if (savingCategories) return;
    setSavingCategories(true);
    setCategoriesError(null);
    setNotice(null);
    try {
      onRoomChanged(await patchAdminRoom(initData, { categoriesEnabled: checked }));
      setNotice(
        checked
          ? "Categories on. Give each habit a category in the Habits tab."
          : "Categories off. Habits show as one flat list."
      );
    } catch (err) {
      setCategoriesError(messageForApiError(err, "Couldn't change the categories setting."));
    } finally {
      setSavingCategories(false);
    }
  }

  function handleShare() {
    if (!room?.inviteLink) return;
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(
      room.inviteLink
    )}&text=${encodeURIComponent(`Join ${room.name} on the habit tracker`)}`;
    const webApp = window.Telegram?.WebApp;
    if (webApp?.openTelegramLink) {
      webApp.openTelegramLink(shareUrl);
    } else {
      window.open(shareUrl, "_blank", "noopener");
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            Room password
          </CardTitle>
          <CardDescription>
            Anyone with this password can join {room.name}. Share it the way you'd share a
            group invite link.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2 rounded-lg border bg-secondary/30 px-3 py-2.5">
            <code className="min-w-0 flex-1 break-all font-mono text-sm text-foreground">
              {room.password}
            </code>
            <CopyButton value={room.password} label="Copy room password" />
          </div>

          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full"
            onClick={() => void handleRegenerate()}
            disabled={savingPassword}
          >
            <RotateCw className="h-4 w-4" />
            {savingPassword ? "Working…" : "Generate a new password"}
          </Button>

          <form onSubmit={(event) => void handleSetPassword(event)} className="space-y-2">
            <Label htmlFor="admin-room-password">Or set your own</Label>
            <div className="flex items-center gap-2">
              <Input
                id="admin-room-password"
                value={customPassword}
                onChange={(event) => setCustomPassword(event.target.value)}
                placeholder="e.g. fajr-club-2026"
                maxLength={MAX_PASSWORD_LENGTH}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={savingPassword}
              />
              <Button type="submit" className="shrink-0" disabled={savingPassword || !customPassword.trim()}>
                Set
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {MIN_PASSWORD_LENGTH}–{MAX_PASSWORD_LENGTH} characters, letters/digits/-/_ only.
              Case-sensitive.
            </p>
          </form>

          {passwordError && (
            <p role="alert" className="text-sm text-destructive">
              {passwordError}
            </p>
          )}
          {notice && (
            <p aria-live="polite" className="text-sm text-primary">
              {notice}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Share2 className="h-4 w-4" aria-hidden="true" />
            Invite link
          </CardTitle>
          <CardDescription>
            Following it pre-fills the password and starts signup for a new member.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {room.inviteLink ? (
            <>
              <div className="flex items-center gap-2 rounded-lg border bg-secondary/30 px-3 py-2.5">
                <span className="min-w-0 flex-1 break-all font-mono text-xs text-foreground">
                  {room.inviteLink}
                </span>
                <CopyButton value={room.inviteLink} label="Copy invite link" />
              </div>
              <Button type="button" className="min-h-11 w-full" onClick={handleShare}>
                <Share2 className="h-4 w-4" />
                Share link
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              The bot hasn't reported its username yet, so there's no link to share. The
              password above still works — participants can enter it after /start.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Habit categories</CardTitle>
          <CardDescription>
            Group habits under IQ, SQ, PQ and EQ instead of showing one flat list.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="admin-room-categories" className="flex-1 font-normal">
              Categories enabled
            </Label>
            <Switch
              id="admin-room-categories"
              checked={room.categoriesEnabled}
              disabled={savingCategories}
              onCheckedChange={(checked) => void handleToggleCategories(checked)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Turning this on doesn't restore categories habits had before — set each habit's
            category again in the Habits tab. Turning it off keeps them stored, just unused.
          </p>
          {categoriesError && (
            <p role="alert" className="text-sm text-destructive">
              {categoriesError}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
