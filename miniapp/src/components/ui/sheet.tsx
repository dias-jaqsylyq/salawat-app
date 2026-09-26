import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useTelegramBackButton } from "@/telegram/useBackButton";

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** Pinned under the scrolling body — usually the primary action. */
  footer?: ReactNode;
}

/**
 * Bottom sheet for forms. Radix Dialog underneath: focus trap, Esc and scrim tap
 * close it, page scroll is locked; Telegram's header back button closes it too.
 */
function Sheet({ open, onOpenChange, title, description, children, footer }: SheetProps) {
  useTelegramBackButton(open, () => onOpenChange(false));

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim duration-200 data-[state=open]:animate-in data-[state=open]:fade-in data-[state=closed]:animate-out data-[state=closed]:fade-out motion-reduce:animate-none" />
        <Dialog.Content
          // Without a description, tell Radix there is none rather than pointing at nothing.
          {...(description ? {} : { "aria-describedby": undefined })}
          className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[85dvh] max-w-lg flex-col rounded-t-xl bg-surface-1 pb-[env(safe-area-inset-bottom)] shadow-lg outline-none duration-200 data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom motion-reduce:animate-none"
        >
          <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-surface-3" />
          <div className="flex items-start gap-3 px-4 pt-2 pb-3">
            <div className="min-w-0 flex-1 pt-2">
              <Dialog.Title className="text-headline text-foreground">{title}</Dialog.Title>
              {description && (
                <Dialog.Description className="mt-1 text-footnote text-muted-foreground">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" size="icon" className="-mr-2" aria-label="Close">
                <Icon icon={X} size="md" />
              </Button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{children}</div>
          {footer && <div className="border-t px-4 py-3">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export { Sheet };
