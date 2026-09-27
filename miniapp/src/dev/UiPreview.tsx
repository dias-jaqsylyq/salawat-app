/**
 * Dev-only gallery of the design tokens and shared components (open the dev
 * server with `?ui-preview`). Never part of a production build — see main.tsx.
 */
import { useEffect, useState, type ReactNode } from "react";
import { ChartColumn, Flame, Inbox, Pencil, Plus, Shield, Sparkles, Trophy, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScreenHeader } from "@/components/ui/screen-header";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { StatTile } from "@/components/ui/stat-tile";
import { Toaster, toast } from "@/components/ui/toast";

type Theme = "light" | "dark";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

export default function UiPreview() {
  const params = new URLSearchParams(window.location.search);
  const [theme, setTheme] = useState<Theme>(params.get("theme") === "dark" ? "dark" : "light");
  const [period, setPeriod] = useState<"weekly" | "all">("weekly");
  const [tab, setTab] = useState<"habits" | "posts" | "board" | "room">("habits");
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  return (
    <div className="mx-auto max-w-sm space-y-8 px-4 pt-6 pb-32">
      <ScreenHeader
        title="UI preview"
        subtitle="Design tokens and shared components"
        onBack={() => toast("Back pressed")}
        trailing={
          <Button type="button" variant="outline" size="sm">
            <Icon icon={Pencil} />
            Edit
          </Button>
        }
      />

      <SegmentedControl
        aria-label="Theme"
        value={theme}
        onChange={setTheme}
        options={[
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
      />

      <Section title="Type roles">
        <div className="space-y-1">
          <p className="text-title">Title 28</p>
          <p className="text-headline">Headline 17</p>
          <p className="text-body">Body 15 — the default reading size.</p>
          <p className="text-body font-semibold">Body 15 semibold</p>
          <p className="text-footnote text-muted-foreground">Footnote 13 — secondary text.</p>
          <p className="text-caption text-quaternary">Caption 11 — inactive (quaternary)</p>
          <p className="text-title numeric font-bold">1,234</p>
        </div>
      </Section>

      <Section title="Surfaces">
        <div className="grid grid-cols-4 gap-2 text-center text-caption text-muted-foreground">
          <div className="rounded-lg border bg-background py-4">bg</div>
          <div className="rounded-lg border bg-surface-1 py-4">1</div>
          <div className="rounded-lg bg-surface-2 py-4">2</div>
          <div className="rounded-lg bg-surface-3 py-4">3</div>
        </div>
      </Section>

      <Section title="Icons 16 / 20 / 24">
        <div className="flex items-end gap-4 text-foreground">
          <Icon icon={Sparkles} size="sm" />
          <Icon icon={Sparkles} size="md" />
          <Icon icon={Sparkles} size="lg" />
          <Icon icon={Flame} size="lg" filled className="text-accent" />
        </div>
      </Section>

      <Section title="Segmented control">
        <SegmentedControl
          aria-label="Period"
          size="sm"
          value={period}
          onChange={setPeriod}
          options={[
            { value: "weekly", label: "This week" },
            { value: "all", label: "All time" },
          ]}
        />
        <SegmentedControl
          aria-label="Admin section"
          value={tab}
          onChange={setTab}
          options={[
            { value: "habits", label: "Habits", icon: ChartColumn },
            { value: "posts", label: "Posts", icon: Plus },
            { value: "board", label: "Board", icon: Trophy },
            { value: "room", label: "Room", icon: Shield, disabled: true },
          ]}
        />
      </Section>

      <Section title="Badges">
        <div className="flex flex-wrap gap-2">
          <Badge>weekly</Badge>
          <Badge variant="brand" icon={Users}>
            My Habits
          </Badge>
          <Badge variant="accent" icon={Flame}>
            5-day streak
          </Badge>
          <Badge variant="warning">Set a category</Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant="gold" className="w-7">1</Badge>
          <Badge variant="silver" className="w-7">2</Badge>
          <Badge variant="bronze" className="w-7">3</Badge>
          <Badge className="w-7">4</Badge>
          <Badge size="sm" icon={Shield}>
            Admin
          </Badge>
        </div>
      </Section>

      <Section title="Stat tiles">
        <div className="grid grid-cols-2 gap-3">
          <StatTile label="Today" value="120" />
          <StatTile label="All-time" value="8,450" tone="brand" />
          <StatTile label="Streak" value="12" unit="days" icon={Flame} tone="accent" />
          <StatTile label="Loading" value="" loading />
        </div>
      </Section>

      <Section title="Skeleton">
        <div className="flex items-center gap-3">
          <Skeleton shape="circle" />
          <div className="flex-1 space-y-2">
            <Skeleton className="w-3/4" />
            <Skeleton className="w-1/2" />
          </div>
        </div>
        <Skeleton shape="block" className="h-16" />
      </Section>

      <Section title="Empty state">
        <div className="rounded-xl border bg-surface-1">
          <EmptyState
            icon={Inbox}
            title="No habits yet"
            description="Add your first habit and it shows up here to log every day."
            action={{ label: "Add a habit", onClick: () => setSheetOpen(true) }}
          />
        </div>
        <div className="rounded-xl border bg-surface-1">
          <EmptyState
            compact
            icon={Inbox}
            title="Nothing logged this week"
            action={{ label: "Log today", onClick: () => toast("Logging…") }}
          />
        </div>
      </Section>

      <Section title="Toast & sheet">
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => toast("Saved")}>
            Neutral
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => toast("Habit logged", { tone: "success" })}>
            Success
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => toast("Only 3 days left this week", { tone: "warning" })}
          >
            Warning
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              toast("Couldn't delete that habit.", {
                tone: "error",
                action: { label: "Retry", onClick: () => toast("Retrying…") },
              })
            }
          >
            Error
          </Button>
          <Button type="button" size="sm" onClick={() => setSheetOpen(true)}>
            Open sheet
          </Button>
        </div>
      </Section>

      <Sheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        title="New habit"
        description="Only you see your personal habits."
        footer={
          <Button type="button" className="w-full" onClick={() => setSheetOpen(false)}>
            Add habit
          </Button>
        }
      >
        <div className="space-y-2">
          <Label htmlFor="preview-habit-name">Name</Label>
          <Input id="preview-habit-name" placeholder="e.g. Read 10 pages" />
        </div>
      </Sheet>

      <Toaster />
    </div>
  );
}
