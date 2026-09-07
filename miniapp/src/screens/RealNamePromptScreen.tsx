import { useState, type FormEvent } from "react";
import { Moon } from "lucide-react";
import { patchProfile } from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import {
  NICKNAME_MATCHES_REAL_NAME_MESSAGE,
  REAL_NAME_MAX_LENGTH,
  nicknameMatchesRealName,
  validateRealName,
} from "../lib/realName.ts";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

interface Props {
  initData: string;
  nickname: string;
  onSaved: () => void;
}

export default function RealNamePromptScreen({ initData, nickname, onSaved }: Props) {
  const [realName, setRealName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;

    const realNameError = validateRealName(realName);
    if (realNameError) {
      setError(realNameError);
      return;
    }
    if (nicknameMatchesRealName(nickname, realName)) {
      setError(NICKNAME_MATCHES_REAL_NAME_MESSAGE);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await patchProfile(initData, { realName: realName.trim() });
      onSaved();
    } catch (err) {
      setError(messageForApiError(err, "Couldn't save your name — please try again."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <form onSubmit={handleSubmit}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Moon className="h-5 w-5 text-primary" aria-hidden="true" />
              Add your full name
            </CardTitle>
            <CardDescription>
              We now keep a real name for the admin list. Add yours to continue.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            <div className="space-y-1">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Your nickname
              </p>
              <p className="text-sm font-medium text-foreground">{nickname}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="real-name-prompt">Full name (real name)</Label>
              <Input
                id="real-name-prompt"
                type="text"
                value={realName}
                onChange={(e) => setRealName(e.target.value)}
                maxLength={REAL_NAME_MAX_LENGTH}
                autoComplete="name"
                placeholder="e.g. Ali Nurlanov"
              />
              <p className="text-xs text-muted-foreground">
                Only the challenge admin can see this. Other participants see your nickname.
              </p>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </CardContent>

          <CardFooter>
            <Button type="submit" disabled={submitting} className="w-full">
              {submitting ? "Saving…" : "Continue"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
