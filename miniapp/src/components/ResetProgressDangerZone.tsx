import { useState } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import { resetProgress } from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  initData: string;
  onReset: () => void;
  onBack: () => void;
}

const SUCCESS_MS = 1200;

export default function ResetProgressDangerZone({
  initData,
  onReset,
  onBack,
}: Props) {
  const [dropFromJamaat, setDropFromJamaat] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmationText, setConfirmationText] = useState("");
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  function openConfirmation(): void {
    setConfirmationText("");
    setError(null);
    setSuccess(false);
    setConfirming(true);
  }

  function cancelConfirmation(): void {
    if (resetting) return;
    setConfirming(false);
    setConfirmationText("");
    setError(null);
  }

  async function confirmReset(): Promise<void> {
    if (confirmationText !== "RESET" || resetting) return;
    setResetting(true);
    setError(null);
    setSuccess(false);
    try {
      await resetProgress(initData, dropFromJamaat);
      setSuccess(true);
      setConfirming(false);
      setConfirmationText("");
      setDropFromJamaat(false);
      onReset();
      window.setTimeout(onBack, SUCCESS_MS);
    } catch (err) {
      setError(messageForApiError(err, "Couldn't reset progress — please try again."));
    } finally {
      setResetting(false);
    }
  }

  return (
    <Card className="mt-4 border-destructive/35">
      <CardHeader>
        <div className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          <CardTitle className="text-lg">Danger Zone</CardTitle>
        </div>
        <CardDescription className="leading-relaxed">
          Permanently delete your logged salawat, total, streak, and makeup history.
          Your nickname, daily goal, and reminder settings are kept. This cannot be undone.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg bg-destructive/5 px-3 py-3">
          <input
            id="reset-drop-from-jamaat"
            type="checkbox"
            checked={dropFromJamaat}
            disabled={resetting}
            onChange={(event) => setDropFromJamaat(event.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="space-y-1">
            <Label
              htmlFor="reset-drop-from-jamaat"
              className="font-normal leading-snug"
            >
              Also remove my total from the Jamaat total
            </Label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Leave unchecked to preserve what you already contributed to the all-time
              Jamaat total.
            </p>
          </div>
        </div>

        {!confirming ? (
          <Button
            type="button"
            variant="destructive"
            className="min-h-11 w-full"
            onClick={openConfirmation}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Reset My Progress
          </Button>
        ) : (
          <div className="space-y-3 rounded-lg border border-destructive/35 p-3">
            <div className="space-y-2">
              <Label htmlFor="reset-confirmation">Type RESET to confirm</Label>
              <Input
                id="reset-confirmation"
                value={confirmationText}
                onChange={(event) => setConfirmationText(event.target.value)}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                disabled={resetting}
                autoFocus
                aria-describedby="reset-confirmation-help"
              />
              <p
                id="reset-confirmation-help"
                className="text-xs text-muted-foreground"
              >
                Enter RESET in capital letters exactly.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={resetting}
                onClick={cancelConfirmation}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={confirmationText !== "RESET" || resetting}
                onClick={() => void confirmReset()}
              >
                {resetting ? "Resetting…" : "Confirm Reset"}
              </Button>
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {success && (
          <p aria-live="polite" className="text-sm font-medium text-primary">
            Progress reset. Your profile and reminders were kept.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
