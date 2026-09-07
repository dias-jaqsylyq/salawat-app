import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTelegram } from "./telegram/useTelegram.ts";
import { getIsAdmin, getProgress } from "./api/client.ts";
import { messageForApiError } from "./api/errors.ts";
import type { DayBreakdown, RegisteredProgress } from "./api/types.ts";
import IncompleteRegistrationScreen from "./screens/IncompleteRegistrationScreen.tsx";
import RealNamePromptScreen from "./screens/RealNamePromptScreen.tsx";
import LogSalawatScreen from "./screens/LogSalawatScreen.tsx";
import ProgressScreen from "./screens/ProgressScreen.tsx";
import LeaderboardScreen from "./screens/LeaderboardScreen.tsx";
import SettingsScreen from "./screens/SettingsScreen.tsx";
import AdminScreen from "./screens/AdminScreen.tsx";
import CelebrationOverlay from "./components/CelebrationOverlay.tsx";
import TabBar, { type Tab } from "./components/TabBar.tsx";
import { Button } from "@/components/ui/button";
import {
  type CelebrationEvent,
  diffMilestones,
  getCelebrated,
  markCelebrated,
  seedAchieved,
} from "./lib/milestones.ts";
import { resolveTelegramId } from "./lib/telegramId.ts";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "needs-registration" }
  | { status: "needs-real-name"; progress: RegisteredProgress }
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
  const { initData, available, user } = useTelegram();
  const telegramId = resolveTelegramId(initData, user?.id);

  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [activeTab, setActiveTab] = useState<Tab>("progress");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tabSwitching, setTabSwitching] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [celebrationQueue, setCelebrationQueue] = useState<CelebrationEvent[]>([]);
  const [activeCelebration, setActiveCelebration] = useState<CelebrationEvent | null>(null);

  const flushLogRef = useRef<(() => Promise<void>) | null>(null);
  const prevProgressRef = useRef<RegisteredProgress | null>(null);
  const celebratedRef = useRef<Set<string>>(getCelebrated(telegramId));

  useSyncDarkMode();

  useEffect(() => {
    celebratedRef.current = getCelebrated(telegramId);
  }, [telegramId]);

  // Advance queue → active overlay.
  useEffect(() => {
    if (activeCelebration) return;
    if (celebrationQueue.length === 0) return;
    const [next, ...rest] = celebrationQueue;
    setActiveCelebration(next ?? null);
    setCelebrationQueue(rest);
  }, [celebrationQueue, activeCelebration]);

  const enqueueCelebrations = useCallback((events: CelebrationEvent[]) => {
    if (events.length === 0) return;
    setCelebrationQueue((q) => [...q, ...events]);
  }, []);

  const handleCelebrationContinue = useCallback(() => {
    if (activeCelebration) {
      markCelebrated(telegramId, [activeCelebration.id]);
      celebratedRef.current.add(activeCelebration.id);
    }
    setActiveCelebration(null);
  }, [activeCelebration, telegramId]);

  const handleTabChange = useCallback(
    async (next: Tab) => {
      if (next === activeTab || tabSwitching) return;
      if (next === "admin" && !isAdmin) return;

      if (activeTab === "log" && next !== "log") {
        const flush = flushLogRef.current;
        if (flush) {
          setTabSwitching(true);
          try {
            await flush();
          } catch {
            // Stay on Log — LogSalawatScreen already surfaces the error.
            return;
          } finally {
            setTabSwitching(false);
          }
        }
      }

      setActiveTab(next);
    },
    [activeTab, tabSwitching, isAdmin],
  );

  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const handleDayOverride = useCallback((update: { streak: number; last7Days: DayBreakdown[] }) => {
    setState((prev) => {
      if (prev.status !== "ready") return prev;
      const nextProgress = {
        ...prev.progress,
        streak: update.streak,
        last7Days: update.last7Days,
      };
      prevProgressRef.current = nextProgress;
      return { status: "ready", progress: nextProgress };
    });
  }, []);

  const registerLogFlush = useCallback((flush: (() => Promise<void>) | null) => {
    flushLogRef.current = flush;
  }, []);

  const loadProgress = useCallback(async () => {
    try {
      const result = await getProgress(initData);
      if (!result.registered) {
        setState({ status: "needs-registration" });
        return;
      }

      const prev = prevProgressRef.current;
      if (prev === null) {
        // First hydrate: seed historical milestones without animating.
        seedAchieved(telegramId, result);
        celebratedRef.current = getCelebrated(telegramId);
      } else {
        const events = diffMilestones(prev, result, celebratedRef.current);
        // In-session dedupe if loadProgress races before Continue.
        for (const event of events) celebratedRef.current.add(event.id);
        enqueueCelebrations(events);
      }
      prevProgressRef.current = result;
      if (result.needsRealName) {
        setState({ status: "needs-real-name", progress: result });
        return;
      }
      setState({ status: "ready", progress: result });
    } catch (err) {
      setState({
        status: "error",
        message: messageForApiError(err, "Couldn't reach the server."),
      });
    }
  }, [initData, telegramId, enqueueCelebrations]);

  useEffect(() => {
    if (available) {
      void loadProgress();
    }
  }, [available, loadProgress]);

  useEffect(() => {
    if (!available) {
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
  }, [available, initData]);

  useEffect(() => {
    if (!isAdmin && activeTab === "admin") setActiveTab("progress");
  }, [activeTab, isAdmin]);

  // Refetch progress whenever the Progress tab is shown (keep prior UI; no loading flash).
  useEffect(() => {
    if (state.status !== "ready") return;
    if (settingsOpen) return;
    if (activeTab !== "progress") return;
    void loadProgress();
  }, [activeTab, settingsOpen, state.status, loadProgress]);

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
            challenge={state.progress}
            onBack={closeSettings}
            onSaved={() => void loadProgress()}
          />
        </div>
      ) : (
        <div className="min-h-screen bg-background pb-16">
          {activeTab === "progress" && (
            <ProgressScreen
              progress={state.progress}
              initData={initData}
              onOpenSettings={openSettings}
              onDayOverride={handleDayOverride}
            />
          )}
          {activeTab === "log" && (
            <LogSalawatScreen
              initData={initData}
              total={state.progress.total}
              todayTotal={state.progress.todayTotal ?? 0}
              onLogged={() => void loadProgress()}
              onRegisterFlush={registerLogFlush}
            />
          )}
          {activeTab === "leaderboard" && (
            <LeaderboardScreen initData={initData} progress={state.progress} />
          )}
          {activeTab === "admin" && isAdmin && (
            <AdminScreen initData={initData} />
          )}
          <TabBar
            activeTab={activeTab}
            onChange={(tab) => void handleTabChange(tab)}
            disabled={tabSwitching}
            showAdmin={isAdmin}
          />
        </div>
      )}

      {activeCelebration && (
        <CelebrationOverlay celebration={activeCelebration} onContinue={handleCelebrationContinue} />
      )}
    </>
  );
}
