import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { shuffleReminders, type VirtueReminder } from "../lib/reminders.ts";
import { Button } from "@/components/ui/button";

const ARABIC_FONT = "Scheherazade New, Amiri, 'Noto Naskh Arabic', serif";

function ReminderBody({ reminder }: { reminder: VirtueReminder }) {
  if (reminder.kind === "ayah") {
    return (
      <>
        <p
          lang="ar"
          dir="rtl"
          className="text-2xl leading-relaxed text-foreground"
          style={{ fontFamily: ARABIC_FONT }}
        >
          {reminder.arabic}
        </p>
        <p className="text-sm text-muted-foreground">{reminder.english}</p>
        <p className="text-xs text-muted-foreground">{reminder.reference}</p>
      </>
    );
  }

  return (
    <>
      <p className="text-sm text-muted-foreground">{reminder.english}</p>
      <p className="text-sm text-muted-foreground">— {reminder.narrator}</p>
      <p className="text-xs text-muted-foreground">{reminder.reference}</p>
    </>
  );
}

export default function VirtueReminder() {
  const [order] = useState(() => shuffleReminders());
  const [index, setIndex] = useState(0);

  const reminder = order[index]!;

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Today&apos;s reminder
      </p>
      <section className="relative space-y-3 rounded-lg bg-secondary/30 px-4 py-5 text-center">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute end-2 top-2 h-8 w-8"
          aria-label="Show another reminder"
          onClick={() => setIndex((i) => (i + 1) % order.length)}
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
        <ReminderBody reminder={reminder} />
      </section>
    </div>
  );
}
