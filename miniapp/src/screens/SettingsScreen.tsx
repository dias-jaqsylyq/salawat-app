import { useEffect, useState, type FormEvent } from "react";
import { ChevronLeft, DoorOpen, Users } from "lucide-react";
import { getProfile, leaveRoom, patchProfile } from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import type { Room, StreakDisplay } from "../api/types.ts";
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
import { cn } from "@/lib/utils";

interface Props {
  initData: string;
  /** Server TIMEZONE label for reminder helper copy. */
  timezoneLabel?: string;
  onBack: () => void;
  /** Called after a successful save so the parent can refresh progress. */
  onSaved: () => void;
  /** Called after leaving the room, so the parent can re-resolve the now-roomless state. */
  onLeftRoom: () => void;
}

const CONFIRM_MS = 900;

const STREAK_DISPLAYS: { id: StreakDisplay; label: string; hint: string }[] = [
  { id: "current", label: "Current", hint: "One running streak count per habit." },
  { id: "weekly", label: "Weekly", hint: "This week's days, one row per habit." },
];

/** 0 = Sunday … 6 = Saturday, matching users.week_start_day. */
const WEEK_START_DAYS = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 0, label: "Sunday" },
];

function validate(
  nickname: string,
  realName: string,
  reminderTime: string,
  fastingReminderTime: string
): string | null {
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
  if (!/^\d{2}:\d{2}$/.test(fastingReminderTime)) {
    return "Enter a valid fasting reminder time (HH:mm).";
  }
  return null;
}

export default function SettingsScreen({
  initData,
  timezoneLabel = "Asia/Hong_Kong",
  onBack,
  onSaved,
  onLeftRoom,
}: Props) {
  const [nickname, setNickname] = useState("");
  const [realName, setRealName] = useState("");
  const [reminderEnabled, setReminderEnabled] = useState(true);
  const [reminderTime, setReminderTime] = useState("20:00");
  const [fastingReminderEnabled, setFastingReminderEnabled] = useState(false);
  const [fastingReminderTime, setFastingReminderTime] = useState("20:00");
  const [streakDisplay, setStreakDisplay] = useState<StreakDisplay>("weekly");
  const [weekStartDay, setWeekStartDay] = useState(1);
  const [timezone, setTimezone] = useState<string | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaveError, setLeaveError] = useState<string | null>(null);
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
        setFastingReminderEnabled(profile.fastingReminderEnabled);
        setFastingReminderTime(profile.fastingReminderTime);
        setStreakDisplay(profile.streakDisplay);
        setWeekStartDay(profile.weekStartDay);
        setTimezone(profile.timezone);
        setRoom(profile.room);
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

  async function handleLeaveRoom() {
    if (leaving || saving || !room) return;
    const confirmed = window.confirm(
      `Leave ${room.name}?\n\nYou'll stop appearing on its leaderboard and won't be able to log ` +
        "habits until you join a room again with its password, in the bot."
    );
    if (!confirmed) return;

    setLeaving(true);
    setLeaveError(null);
    try {
      await leaveRoom(initData);
      onLeftRoom();
    } catch (err) {
      // last_admin is the expected refusal here: a room may never be left
      // without admins (PRD §3a).
      setLeaveError(messageForApiError(err, "Couldn't leave the room — please try again."));
    } finally {
      setLeaving(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving || loading) return;

    const validationError = validate(nickname, realName, reminderTime, fastingReminderTime);
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
        fastingReminderEnabled,
        fastingReminderTime,
        // Saved with the rest of the form, not applied as you tap: the streak
        // shape is a preference, not a live toggle on the Progress screen.
        streakDisplay,
        weekStartDay,
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
                      Reminders arrive in your own timezone ({timezone ?? timezoneLabel}),
                      detected automatically.
                    </p>
                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <div className="flex-1">
                      <Label htmlFor="settings-fasting-enabled">Fasting reminder</Label>
                      <p className="text-xs text-muted-foreground">
                        Sunday and Wednesday evenings, about Monday's and Thursday's fast.
                      </p>
                    </div>
                    <Switch
                      id="settings-fasting-enabled"
                      checked={fastingReminderEnabled}
                      onCheckedChange={setFastingReminderEnabled}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="settings-fasting-time">Fasting reminder time</Label>
                    <Input
                      id="settings-fasting-time"
                      type="time"
                      value={fastingReminderTime}
                      onChange={(e) => setFastingReminderTime(e.target.value)}
                      disabled={!fastingReminderEnabled}
                    />
                    <p className="text-xs text-muted-foreground">
                      One time covers both evenings.
                    </p>
                  </div>
                </section>

                <section className="space-y-4">
                  <h3 className="text-sm font-semibold text-foreground">Streaks</h3>
                  <div className="space-y-2">
                    <Label htmlFor="settings-streak-display">Display</Label>
                    <div
                      id="settings-streak-display"
                      role="radiogroup"
                      aria-label="Streak display"
                      className="grid grid-cols-2 gap-1 rounded-xl bg-secondary/60 p-1"
                    >
                      {STREAK_DISPLAYS.map((option) => {
                        const active = streakDisplay === option.id;
                        return (
                          <button
                            key={option.id}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            onClick={() => setStreakDisplay(option.id)}
                            className={cn(
                              "min-h-11 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              active
                                ? "bg-background text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground"
                            )}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {STREAK_DISPLAYS.find((o) => o.id === streakDisplay)?.hint} Applies when you
                      save.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="settings-week-start">Week starts on</Label>
                    <select
                      id="settings-week-start"
                      value={weekStartDay}
                      onChange={(e) => setWeekStartDay(Number(e.target.value))}
                      className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={streakDisplay !== "weekly"}
                    >
                      {WEEK_START_DAYS.map((day) => (
                        <option key={day.value} value={day.value}>
                          {day.label}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground">
                      The day the weekly view's calendar week begins.
                    </p>
                  </div>
                </section>

                <section className="space-y-4">
                  <h3 className="text-sm font-semibold text-foreground">Room</h3>
                  {room ? (
                    <>
                      <div className="flex items-center gap-3 rounded-lg bg-secondary/40 px-3 py-2.5">
                        <Users className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">{room.name}</p>
                          <p className="text-xs text-muted-foreground">Your current room</p>
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11 w-full text-destructive hover:text-destructive"
                        onClick={() => void handleLeaveRoom()}
                        disabled={leaving || saving}
                      >
                        <DoorOpen className="h-4 w-4" />
                        {leaving ? "Leaving…" : "Leave room"}
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        Your logs are kept, but they stop counting here. Joining another room
                        happens in the bot, with that room's password.
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      You're not in a room. Send /start in the bot and enter a room password to
                      join one.
                    </p>
                  )}
                  {leaveError && (
                    <p role="alert" className="text-sm text-destructive">
                      {leaveError}
                    </p>
                  )}
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
