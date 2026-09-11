import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTelegram } from "./telegram/useTelegram.ts";
import { getHabits, getIsAdmin, getProgress, patchProfile } from "./api/client.ts";
import { messageForApiError } from "./api/errors.ts";
import type { Habit, RegisteredProgress } from "./api/types.ts";
import IncompleteRegistrationScreen from "./screens/IncompleteRegistrationScreen.tsx";
import NoRoomScreen from "./screens/NoRoomScreen.tsx";
import RealNamePromptScreen from "./screens/RealNamePromptScreen.tsx";
import LogHabitsScreen from "./screens/LogHabitsScreen.tsx";
import ProgressScreen from "./screens/ProgressScreen.tsx";
import LeaderboardScreen from "./screens/LeaderboardScreen.tsx";
import SettingsScreen from "./screens/SettingsScreen.tsx";
import AdminScreen from "./screens/AdminScreen.tsx";
import TabBar, { type Tab } from "./components/TabBar.tsx";
import { Button } from "@/components/ui/button";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "needs-registration" }
  | { status: "needs-real-name"; progress: RegisteredProgress }
  /** Registered, but between rooms — joining another one happens in the bot. */
  | { status: "no-room"; progress: RegisteredProgress }
  | { status: "ready"; progress: RegisteredProgress };

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">{children}</div>;
}

/** Keeps the app's theme in sync with Telegram's color scheme (falls back to system preference outside Telegram). */
function useSyncDarkMode() {
  useEffect(() => {
    const isDark =
      window.Telegram?.WebApp?.colorScheme === "dark" ||
      (!window.Telegram?.WebApp && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", isDark);
  }, []);
}

export default function App() {
  const { initData, available } = useTelegram();

  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [activeTab, setActiveTab] = useState<Tab>("progress");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  /** null = not loaded yet, distinct from a genuinely empty active-habit list. */
  const [habits, setHabits] = useState<Habit[] | null>(null);

  useSyncDarkMode();

  const handleTabChange = useCallback(
    (next: Tab) => {
      if (next === "admin" && !isAdmin) return;
      setActiveTab(next);
    },
    [isAdmin]
  );

  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const loadProgress = useCallback(async () => {
    try {
      const result = await getProgress(initData);
      if (!result.registered) {
        setState({ status: "needs-registration" });
        return;
      }
      if (result.needsRealName) {
        setState({ status: "needs-real-name", progress: result });
        return;
      }
      if (result.room === null) {
        setState({ status: "no-room", progress: result });
        return;
      }
      setState({ status: "ready", progress: result });
    } catch (err) {
      setState({
        status: "error",
        message: messageForApiError(err, "Couldn't reach the server."),
      });
    }
  }, [initData]);

  const loadHabits = useCallback(async () => {
    try {
      setHabits(await getHabits(initData));
    } catch {
      setHabits((prev) => prev ?? []);
    }
  }, [initData]);

  useEffect(() => {
    if (available) {
      void loadProgress();
    }
  }, [available, loadProgress]);

  useEffect(() => {
    if (!available) {
      setHabits(null);
      return;
    }
    void loadHabits();
  }, [available, loadHabits]);

  // Admin status is room-scoped and is dropped the moment someone leaves for
  // another room (PRD §3a), so it is re-resolved whenever the current room
  // changes — not once per session. No room at all means no admin, with nothing
  // to ask the server.
  const currentRoomId =
    state.status === "ready" || state.status === "no-room"
      ? (state.progress.room?.id ?? null)
      : null;

  const refreshAdminStatus = useCallback(async () => {
    try {
      const result = await getIsAdmin(initData);
      setIsAdmin(result.isAdmin);
    } catch {
      setIsAdmin(false);
    }
  }, [initData]);

  useEffect(() => {
    if (!available || currentRoomId === null) {
      setIsAdmin(false);
      return;
    }
    let cancelled = false;
    void getIsAdmin(initData)
      .then((result) => {
        if (!cancelled) setIsAdmin(result.isAdmin);
      })
      .catch(() => {
        // Fail closed without breaking the participant experience.
        if (!cancelled) setIsAdmin(false);
      });
    return () => {
      cancelled = true;
    };
  }, [available, initData, currentRoomId]);

  useEffect(() => {
    if (!isAdmin && activeTab === "admin") setActiveTab("progress");
  }, [activeTab, isAdmin]);

  // Silently sync the browser-detected timezone once per session, so reminders
  // fire at the user's own local time instead of the server's default. Fires
  // every time the app is opened (not just the first time ever) — that's what
  // keeps it correct after travel, with no separate "already detected" state
  // to track. Gated on "ready" so this never races an unregistered account
  // (PATCH /api/profile would just 403 for them) or a real-name-prompt user.
  const timezoneSyncedRef = useRef(false);
  useEffect(() => {
    if (state.status !== "ready" || timezoneSyncedRef.current) return;
    timezoneSyncedRef.current = true;
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      void patchProfile(initData, { timezone }).catch(() => {
        // Best-effort — reminders just keep using the server default until
        // this succeeds on a later open.
      });
    } catch {
      // Intl.DateTimeFormat().resolvedOptions().timeZone is effectively
      // always available, but never let detection failure affect the app.
    }
  }, [state.status, initData]);

  // Refetch progress + habits whenever Progress or Log is shown (keep prior UI; no
  // loading flash) — picks up habits an admin created/toggled without a full reload.
  useEffect(() => {
    if (state.status !== "ready") return;
    if (settingsOpen) return;
    if (activeTab !== "progress" && activeTab !== "log") return;
    void loadProgress();
    void loadHabits();
  }, [activeTab, settingsOpen, state.status, loadProgress, loadHabits]);

  if (!available) {
    return (
      <Centered>
        <p className="text-muted-foreground">Open this from the Salawat Challenge bot's menu button in Telegram.</p>
      </Centered>
    );
  }

  if (state.status === "loading") {
    return (
      <Centered>
        <p className="text-muted-foreground">Loading…</p>
      </Centered>
    );
  }

  if (state.status === "error") {
    return (
      <Centered>
        <p className="text-destructive">{state.message}</p>
        <Button onClick={() => void loadProgress()} className="mt-3">
          Retry
        </Button>
      </Centered>
    );
  }

  if (state.status === "needs-registration") {
    return <IncompleteRegistrationScreen />;
  }

  if (state.status === "no-room") {
    return (
      <NoRoomScreen
        nickname={state.progress.nickname}
        onRefresh={() => {
          void loadProgress();
          void loadHabits();
        }}
      />
    );
  }

  if (state.status === "needs-real-name") {
    return (
      <RealNamePromptScreen
        initData={initData}
        nickname={state.progress.nickname}
        onSaved={() => void loadProgress()}
      />
    );
  }

  return (
    <>
      {settingsOpen ? (
        <div className="min-h-screen bg-background">
          <SettingsScreen
            initData={initData}
            onBack={closeSettings}
            onSaved={() => void loadProgress()}
            onLeftRoom={() => {
              closeSettings();
              void loadProgress();
            }}
          />
        </div>
      ) : (
        <div className="min-h-screen bg-background pb-16">
          {activeTab === "progress" && (
            <ProgressScreen
              initData={initData}
              progress={state.progress}
              habits={habits}
              onOpenSettings={openSettings}
            />
          )}
          {activeTab === "log" && (
            <LogHabitsScreen
              initData={initData}
              habits={habits}
              progress={state.progress}
              onLogged={() => void loadProgress()}
            />
          )}
          {activeTab === "leaderboard" && <LeaderboardScreen initData={initData} />}
          {activeTab === "admin" && isAdmin && (
            <AdminScreen
              initData={initData}
              onAdminStatusChanged={() => void refreshAdminStatus()}
            />
          )}
          <TabBar activeTab={activeTab} onChange={handleTabChange} showAdmin={isAdmin} />
        </div>
      )}
    </>
  );
}
