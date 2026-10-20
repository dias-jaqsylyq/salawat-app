import { ChartColumn, Plus, Shield, Trophy, UsersRound, type LucideIcon } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export type Tab = "progress" | "log" | "leaderboard" | "stats" | "admin";

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: "progress", label: "Progress", icon: ChartColumn },
  { id: "log", label: "Log", icon: Plus },
  { id: "leaderboard", label: "Leaderboard", icon: Trophy },
  { id: "stats", label: "Stats", icon: UsersRound },
  { id: "admin", label: "Admin", icon: Shield },
];

interface Props {
  activeTab: Tab;
  onChange: (tab: Tab) => void;
  /** When true, ignore tab presses (e.g. while flushing pending Log taps). */
  disabled?: boolean;
  /** Admin navigation is omitted entirely for non-admin accounts. */
  showAdmin?: boolean;
}

export default function TabBar({
  activeTab,
  onChange,
  disabled = false,
  showAdmin = false,
}: Props) {
  const visibleTabs = showAdmin ? TABS : TABS.filter((tab) => tab.id !== "admin");
  return (
    <nav className="fixed inset-x-0 bottom-0 flex border-t bg-card pb-[env(safe-area-inset-bottom)]">
      {visibleTabs.map((tab) => {
        const glyph = tab.icon;
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(tab.id)}
            className={cn(
              "flex min-w-0 flex-1 flex-col items-center gap-1 py-2 text-caption font-semibold transition duration-100 active:scale-[0.97] active:bg-fill-pressed",
              isActive ? "text-primary" : "text-muted-foreground",
              disabled && "pointer-events-none opacity-60"
            )}
          >
            <Icon icon={glyph} size="md" />
            <span className="max-w-full truncate">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
