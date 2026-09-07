import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { logSalawat } from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import { hapticMedium } from "../lib/haptics.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Props {
  initData: string;
  total: number;
  todayTotal: number;
  /** Called after a successful log so the caller can refresh shared progress state. */
  onLogged: () => void;
  /**
   * Registers a flush callback the parent can await before leaving this tab.
   * Resolves when pending taps are fully drained; rejects if a flush POST fails.
   */
  onRegisterFlush?: (flush: (() => Promise<void>) | null) => void;
}

/** Must stay in sync with salawat-bot MAX_LOG_COUNT. */
const MAX_LOG_COUNT = 10_000;
/** Honor-system confirm threshold for large submissions. */
const CONFIRM_THRESHOLD = 1_000;
/** Auto-submit pending taps in batches of this size. */
const AUTO_SUBMIT_EVERY = 10;

const SALAWAT = {
  arabic: "اللَّهُمَّ صَلِّ عَلَى مُحَمَّدٍ وَعَلَى آلِ مُحَمَّدٍ",
  transliteration: "Allahumma salli ala Muhammadin wa ala aali Muhammad",
  english: "O Allah, send prayers upon Muhammad and upon the family of Muhammad",
} as const;

type SyncStatus = "synced" | "pending" | "syncing" | "error";

function syncLabel(status: SyncStatus, pendingCount: number): string {
  switch (status) {
    case "synced":
      return "Synced";
    case "pending":
      return `${pendingCount} pending`;
    case "syncing":
      return "Saving…";
    case "error":
      return "Couldn't save — will retry";
  }
}

export default function LogSalawatScreen({
  initData,
  total,
  todayTotal,
  onLogged,
  onRegisterFlush,
}: Props) {
  const [sessionCount, setSessionCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [inFlightClaim, setInFlightClaim] = useState(0);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("synced");
  const [amountInput, setAmountInput] = useState("");
  const [amountSubmitting, setAmountSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Server-confirmed totals; optimistic display adds pending + in-flight. */
  const [serverToday, setServerToday] = useState(todayTotal);
  const [serverTotal, setServerTotal] = useState(total);

  const pendingRef = useRef(0);
  const inFlightRef = useRef(false);
  const flushAllAfterRef = useRef(false);
  const mountedRef = useRef(true);
  const initDataRef = useRef(initData);
  const onLoggedRef = useRef(onLogged);
  const serverTodayRef = useRef(serverToday);
  const flushRef = useRef<(mode: "batch" | "all") => Promise<void>>(async () => {});
  const flushWaitersRef = useRef<Array<{ resolve: () => void; reject: (err: unknown) => void }>>([]);

  initDataRef.current = initData;
  onLoggedRef.current = onLogged;
  serverTodayRef.current = serverToday;

  useEffect(() => {
    setServerToday(todayTotal);
    setServerTotal(total);
  }, [todayTotal, total]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function resolveFlushWaiters() {
    const waiters = flushWaitersRef.current;
    flushWaitersRef.current = [];
    for (const waiter of waiters) waiter.resolve();
  }

  function rejectFlushWaiters(err: unknown) {
    const waiters = flushWaitersRef.current;
    flushWaitersRef.current = [];
    for (const waiter of waiters) waiter.reject(err);
  }

  const flush = useCallback(async (mode: "batch" | "all") => {
    if (inFlightRef.current) {
      if (mode === "all") flushAllAfterRef.current = true;
      return;
    }

    const pending = pendingRef.current;
    const n = mode === "all" ? pending : Math.min(AUTO_SUBMIT_EVERY, pending);
    if (n <= 0) {
      if (mode === "all") resolveFlushWaiters();
      return;
    }

    inFlightRef.current = true;
    pendingRef.current = pending - n;

    if (mountedRef.current) {
      setPendingCount(pendingRef.current);
      setInFlightClaim(n);
      setSyncStatus("syncing");
      setError(null);
    }

    try {
      const { newTotal, newTodayTotal } = await logSalawat(initDataRef.current, n);
      inFlightRef.current = false;
      onLoggedRef.current();

      if (mountedRef.current) {
        setInFlightClaim(0);
        setServerTotal(newTotal);
        setServerToday(newTodayTotal ?? serverTodayRef.current + n);
        setSyncStatus(pendingRef.current > 0 ? "pending" : "synced");
      }

      const wantAll = flushAllAfterRef.current || mode === "all";
      flushAllAfterRef.current = false;

      if (wantAll && pendingRef.current > 0) {
        await flushRef.current("all");
      } else if (pendingRef.current >= AUTO_SUBMIT_EVERY) {
        void flushRef.current("batch");
      } else if (wantAll) {
        resolveFlushWaiters();
      }
    } catch (err) {
      pendingRef.current += n;
      inFlightRef.current = false;
      flushAllAfterRef.current = false;

      if (mountedRef.current) {
        setInFlightClaim(0);
        setPendingCount(pendingRef.current);
        setSyncStatus("error");
        setError(messageForApiError(err, "Couldn't log that — please try again."));
      }
      rejectFlushWaiters(err);
    }
  }, []);

  flushRef.current = flush;

  const flushAll = useCallback((): Promise<void> => {
    if (pendingRef.current <= 0 && !inFlightRef.current) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      flushWaitersRef.current.push({ resolve, reject });
      void flush("all");
    });
  }, [flush]);

  useEffect(() => {
    onRegisterFlush?.(flushAll);
    return () => onRegisterFlush?.(null);
  }, [onRegisterFlush, flushAll]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") {
        void flushAll().catch(() => {});
      }
    };
    const onPageHide = () => {
      void flushAll().catch(() => {});
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [flushAll]);

  function handleTap() {
    const nextPending = pendingRef.current + 1;
    pendingRef.current = nextPending;
    setSessionCount((c) => c + 1);
    setPendingCount(nextPending);
    setSyncStatus(inFlightRef.current ? "syncing" : "pending");
    setError(null);
    hapticMedium();

    if (nextPending >= AUTO_SUBMIT_EVERY && !inFlightRef.current) {
      void flush("batch");
    }
  }

  async function handleAmountSubmit(e: FormEvent) {
    e.preventDefault();
    if (amountSubmitting) return;

    const trimmed = amountInput.trim();
    if (trimmed.length === 0) return;

    const count = Number(trimmed);
    if (!Number.isInteger(count) || count <= 0) {
      setError("Enter a positive whole number.");
      return;
    }
    if (count > MAX_LOG_COUNT) {
      setError(`Maximum ${MAX_LOG_COUNT.toLocaleString()} salawat per submission.`);
      return;
    }
    if (count >= CONFIRM_THRESHOLD) {
      const ok = window.confirm(`Log ${count.toLocaleString()} salawat?`);
      if (!ok) return;
    }

    setAmountSubmitting(true);
    setError(null);
    try {
      const { newTotal, newTodayTotal } = await logSalawat(initData, count);
      hapticMedium();
      setSessionCount((c) => c + count);
      setServerTotal(newTotal);
      setServerToday(newTodayTotal ?? serverToday + count);
      setAmountInput("");
      onLogged();
    } catch (err) {
      setError(messageForApiError(err, "Couldn't log that — please try again."));
    } finally {
      setAmountSubmitting(false);
    }
  }

  const displayToday = serverToday + pendingCount + inFlightClaim;
  const displayTotal = serverTotal + pendingCount + inFlightClaim;

  return (
    <div className="mx-auto max-w-sm space-y-5 px-4 py-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-foreground">Log Salawat</h2>
        <div className="grid grid-cols-2 gap-3 rounded-lg bg-secondary/40 px-4 py-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Today</p>
            <p className="text-xl font-semibold tabular-nums text-foreground">
              {displayToday.toLocaleString()}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Total</p>
            <p className="text-xl font-semibold tabular-nums text-foreground">
              {displayTotal.toLocaleString()}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-3 rounded-lg bg-secondary/30 px-4 py-5 text-center">
        <p
          lang="ar"
          dir="rtl"
          className="text-2xl leading-relaxed text-foreground"
          style={{ fontFamily: "Scheherazade New, Amiri, 'Noto Naskh Arabic', serif" }}
        >
          {SALAWAT.arabic}
        </p>
        <p className="text-sm italic text-muted-foreground">{SALAWAT.transliteration}</p>
        <p className="text-sm text-muted-foreground">{SALAWAT.english}</p>
      </div>

      <div className="flex flex-col items-center gap-3 py-2">
        <button
          type="button"
          onClick={handleTap}
          aria-label="Tap to count one salawat"
          className="flex h-40 w-40 touch-manipulation items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md transition-transform active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <span className="text-5xl font-bold tabular-nums">{sessionCount}</span>
        </button>
        <p className="text-sm text-muted-foreground">
          Session · {syncLabel(syncStatus, pendingCount)}
        </p>
      </div>

      <form onSubmit={(e) => void handleAmountSubmit(e)} className="flex items-stretch gap-3">
        <Input
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          placeholder="e.g. 25"
          aria-label="Amount to add"
          value={amountInput}
          disabled={amountSubmitting}
          onChange={(e) => setAmountInput(e.target.value)}
          className="h-11 flex-1 text-base tabular-nums"
        />
        <Button
          type="submit"
          variant="default"
          size="lg"
          disabled={amountSubmitting || amountInput.trim().length === 0}
          className="min-w-[5.5rem] shrink-0"
        >
          {amountSubmitting ? "Adding…" : "Add"}
        </Button>
      </form>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
