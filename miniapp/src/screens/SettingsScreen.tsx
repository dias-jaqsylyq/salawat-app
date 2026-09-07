import { useEffect, useState, type FormEvent } from "react";
import { ChevronLeft } from "lucide-react";
import { getProfile, patchProfile } from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import type { ChallengeMeta } from "../api/types.ts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import ResetProgressDangerZone from "../components/ResetProgressDangerZone.tsx";

interface Props {
  initData: string;
  challenge: ChallengeMeta;
  /** Challenge TIMEZONE label for reminder helper copy. */
  timezoneLabel?: string;
  onBack: () => void;
  /** Called after a successful save so the parent can refresh progress. */
  onSaved: () => void;
}

/** Must stay in sync with salawat-bot MAX_GOAL. */
const MAX_GOAL = 100_000_000;
const CONFIRM_MS = 900;

function validate(
  nickname: string,
  dailyGoal: string,
  reminderTime: string,
  fastingReminderTime: string
): string | null {
  const trimmed = nickname.trim();
  if (trimmed.length === 0 || trimmed.length > 50) {
    return "Nickname must be 1–50 characters.";
  }
  const goalNum = Number(dailyGoal);
  if (!Number.isInteger(goalNum) || goalNum <= 0) {
    return "Daily goal must be a positive whole number.";
  }
  if (goalNum > MAX_GOAL) {
    return `Daily goal must be at most ${MAX_GOAL.toLocaleString()}.`;
  }
  if (!/^\d{2}:\d{2}$/.test(reminderTime) || !/^\d{2}:\d{2}$/.test(fastingReminderTime)) {
    return "Enter a valid reminder time (HH:mm).";
  }
  return null;
}

export default function SettingsScreen({
  initData,
  challenge,
  timezoneLabel = "Asia/Hong_Kong",
  onBack,
  onSaved,
}: Props) {
  const [nickname, setNickname] = useState("");
  const [dailyGoal, setDailyGoal] = useState("");
  const [reminderEnabled, setReminderEnabled] = useState(true);
  const [reminderTime, setReminderTime] = useState("20:00");
  const [fastingReminderEnabled, setFastingReminderEnabled] = useState(false);
  const [fastingReminderTime, setFastingReminderTime] = useState("20:00");
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
        setDailyGoal(String(profile.dailyGoal));
        setReminderEnabled(profile.reminderEnabled);
        setReminderTime(profile.reminderTime);
        setFastingReminderEnabled(profile.fastingReminderEnabled ?? false);
        setFastingReminderTime(profile.fastingReminderTime ?? "20:00");
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

    const validationError = validate(nickname, dailyGoal, reminderTime, fastingReminderTime);
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
        dailyGoal: Number(dailyGoal),
        reminderEnabled,
        reminderTime,
        fastingReminderEnabled,
        fastingReminderTime,
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
                    <Label htmlFor="settings-goal">Daily goal</Label>
                    <Input
                      id="settings-goal"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={MAX_GOAL}
                      step={1}
                      value={dailyGoal}
                      onChange={(e) => setDailyGoal(e.target.value)}
                    />
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
                      Times use the challenge timezone ({timezoneLabel}).
                    </p>
                  </div>
                </section>

                <section className="space-y-4">
                  <h3 className="text-sm font-semibold text-foreground">Fasting Reminders</h3>
                  <p className="text-sm text-muted-foreground">
                    Get a reminder every Sunday and Wednesday evening to prepare for the Sunnah fast of Monday and Thursday.
                  </p>
                  <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="settings-fasting-reminder-enabled" className="flex-1">
                      Sunday & Wednesday reminder
                    </Label>
                    <Switch
                      id="settings-fasting-reminder-enabled"
                      checked={fastingReminderEnabled}
                      onCheckedChange={setFastingReminderEnabled}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="settings-fasting-reminder-time">Reminder time</Label>
                    <Input
                      id="settings-fasting-reminder-time"
                      type="time"
                      value={fastingReminderTime}
                      onChange={(e) => setFastingReminderTime(e.target.value)}
                      disabled={!fastingReminderEnabled}
                    />
                    <p className="text-xs text-muted-foreground">
                      One time for both days, in {timezoneLabel}.
                    </p>
                  </div>
                </section>

                <section className="space-y-2">
                  <h3 className="text-sm font-semibold text-foreground">About</h3>
                  <p className="text-sm text-muted-foreground">
                    Challenge {challenge.challengeStartDate} → {challenge.challengeEndDate}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Prizes are based on total salawat logged (all-time), not daily goals or streaks.
                  </p>
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
      <ResetProgressDangerZone
        initData={initData}
        onReset={onSaved}
        onBack={onBack}
      />
    </div>
  );
}
