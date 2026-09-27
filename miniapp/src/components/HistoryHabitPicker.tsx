import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import type { HistoryHabitListEntry } from "../api/types.ts";
import { CATEGORY_META } from "../lib/habitCategories.ts";
import { cn } from "@/lib/utils";

interface Props {
  habits: HistoryHabitListEntry[];
  selected: HistoryHabitListEntry;
  onSelect: (habit: HistoryHabitListEntry) => void;
}

function isSame(a: HistoryHabitListEntry, b: HistoryHabitListEntry): boolean {
  return a.kind === b.kind && a.id === b.id;
}

function HabitIcon({ category }: { category: HistoryHabitListEntry["category"] }) {
  if (category === null) return null;
  const glyph = CATEGORY_META[category].icon;
  return <Icon icon={glyph} className="text-primary" />;
}

/**
 * The History screen's "one habit at a time" switcher (HISTORY PRD): a
 * dropdown grouped into room habits, the caller's own ("My Habits", labeled
 * separately), and inactive room habits, kept as historical data rather than
 * dropped from the list.
 *
 * A plain custom dropdown rather than a Select/Popover primitive — neither
 * exists in this app's component set (components/ui has only Badge, Button,
 * Card, Input, Label, Progress, Switch, Textarea) — closed on an outside tap
 * via a full-screen invisible button rather than a portal library.
 */
export default function HistoryHabitPicker({ habits, selected, onSelect }: Props) {
  const [open, setOpen] = useState(false);

  const sections = [
    { label: "Room habits", items: habits.filter((h) => h.kind === "room" && h.isActive) },
    { label: "My Habits", items: habits.filter((h) => h.kind === "personal") },
    { label: "Inactive", items: habits.filter((h) => h.kind === "room" && !h.isActive) },
  ].filter((section) => section.items.length > 0);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex w-full items-center gap-2 rounded-xl border border-border bg-surface-2 px-3 py-3 text-left transition duration-100 active:scale-[0.97] active:bg-fill-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <HabitIcon category={selected.category} />
        <span className="flex-1 truncate text-body font-semibold text-foreground">{selected.name}</span>
        {selected.kind === "personal" && (
          <span className="shrink-0 rounded-full bg-secondary px-2 py-1 text-caption font-semibold text-secondary-foreground">
            My Habits
          </span>
        )}
        {selected.kind === "room" && !selected.isActive && (
          <span className="shrink-0 rounded-full bg-surface-3 px-2 py-1 text-caption font-semibold text-muted-foreground">
            Inactive
          </span>
        )}
        <Icon
          icon={ChevronDown}
          className={cn("text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <>
          {/* Closes the dropdown on an outside tap — invisible, sits under the panel. */}
          <button
            type="button"
            aria-label="Close habit picker"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="listbox"
            aria-label="Choose a habit"
            className="absolute inset-x-0 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg"
          >
            {sections.map((section) => (
              <div key={section.label} className="py-1">
                <p className="px-2 py-1 text-caption font-semibold uppercase tracking-wide text-muted-foreground">
                  {section.label}
                </p>
                {section.items.map((habit) => {
                  const active = isSame(habit, selected);
                  return (
                    <button
                      key={`${habit.kind}-${habit.id}`}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => {
                        onSelect(habit);
                        setOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-body transition duration-100 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        active
                          ? "bg-accent/15 text-foreground"
                          : "text-foreground hover:bg-fill active:bg-fill-pressed"
                      )}
                    >
                      <HabitIcon category={habit.category} />
                      <span className="flex-1 truncate">{habit.name}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
