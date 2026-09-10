import { useEffect, useState, type FormEvent } from "react";
import { ChevronLeft } from "lucide-react";
import { getProfile, patchProfile } from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import {
  NICKNAME_MATCHES_REAL_NAME_MESSAGE,
  REAL_NAME_MAX_LENGTH,
  nicknameMatchesRealName,
  validateRealName,
} from "../lib/realName.ts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

interface Props {
  initData: string;
  /** Server TIMEZONE label for reminder helper copy. */
  timezoneLabel?: string;
  onBack: () => void;
  /** Called after a successful save so the parent can refresh progress. */
  onSaved: () => void;
}

const CONFIRM_MS = 900;

function validate(nickname: string, realName: string, reminderTime: string): string | null {
  const trimmedNickname = nickname.trim();
  if (trimmedNickname.length === 0 || trimmedNickname.length > 50) {
    return "Nickname must be 1–50 characters.";
  }
  const realNameError = validateRealName(realName);
  if (realNameError) return realNameError;
  if (nicknameMatchesRealName(trimmedNickname, realName)) {
    return NICKNAME_MATCHES_REAL_NAME_MESSAGE;
  }
  if (!/^\d{2}:\d{2}$/.test(reminderTime)) {
    return "Enter a valid reminder time (HH:mm).";
  }
  return null;
}

export default function SettingsScreen({
  initData,
  timezoneLabel = "Asia/Hong_Kong",
  onBack,
  onSaved,
}: Props) {
  const [nickname, setNickname] = useState("");
  const [realName, setRealName] = useState("");
  const [reminderEnabled, setReminderEnabled] = useState(true);
  const [reminderTime, setReminderTime] = useState("20:00");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getProfile(initData)
      .then((profile) => {
        if (cancelled) return;
        setNickname(profile.nickname);
        setRealName(profile.realName ?? "");
        setReminderEnabled(profile.reminderEnabled);
        setReminderTime(profile.reminderTime);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(messageForApiError(err, "Couldn't load settings."));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initData]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving || loading) return;

    const validationError = validate(nickname, realName, reminderTime);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError(null);
    setConfirmation(null);
    try {
      await patchProfile(initData, {
        nickname: nickname.trim(),
        realName: realName.trim(),
        reminderEnabled,
        reminderTime,
      });
      setConfirmation("Saved!");
      onSaved();
      window.setTimeout(() => {
        onBack();
      }, CONFIRM_MS);
    } catch (err) {
      setError(messageForApiError(err, "Couldn't save settings — please try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm px-4 py-6">
      <form onSubmit={(e) => void handleSubmit(e)}>
        <Card>
          <CardHeader className="space-y-3">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onBack}
                aria-label="Back to progress"
              >
                <ChevronLeft className="h-5 w-5" />
              </Button>
              <CardTitle>Settings</CardTitle>
            </div>
          </CardHeader>

          <CardContent className="space-y-8">
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <>
                <section className="space-y-4">
                  <h3 className="text-sm font-semibold text-foreground">Profile</h3>
                  <div className="space-y-2">
                    <Label htmlFor="settings-nickname">Nickname</Label>
                    <Input
                      id="settings-nickname"
                      type="text"
                      value={nickname}
                      onChange={(e) => setNickname(e.target.value)}
                      maxLength={50}
                      autoComplete="nickname"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="settings-real-name">Full name (real name)</Label>
                    <Input
                      id="settings-real-name"
                      type="text"
                      value={realName}
                      onChange={(e) => setRealName(e.target.value)}
                      maxLength={REAL_NAME_MAX_LENGTH}
                      autoComplete="name"
                    />
                    <p className="text-xs text-muted-foreground">
                      Only the admin can see this. Other participants see your nickname.
                    </p>
                  </div>
                </section>

                <section className="space-y-4">
                  <h3 className="text-sm font-semibold text-foreground">Reminders</h3>
                  <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="settings-reminder-enabled" className="flex-1">
                      Daily reminder
                    </Label>
                    <Switch
                      id="settings-reminder-enabled"
                      checked={reminderEnabled}
                      onCheckedChange={setReminderEnabled}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="settings-reminder-time">Reminder time</Label>
                    <Input
                      id="settings-reminder-time"
                      type="time"
                      value={reminderTime}
                      onChange={(e) => setReminderTime(e.target.value)}
                      disabled={!reminderEnabled}
                    />
                    <p className="text-xs text-muted-foreground">
                      Times use the server timezone ({timezoneLabel}).
                    </p>
                  </div>
                </section>
              </>
            )}

            {confirmation && <p className="text-sm text-primary">{confirmation}</p>}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </CardContent>

          <CardFooter>
            <Button type="submit" className="w-full" disabled={saving || loading}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </CardFooter>
        </Card>
      </form>
    </div>
  );
}
