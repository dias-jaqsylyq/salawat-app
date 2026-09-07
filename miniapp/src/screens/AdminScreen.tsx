import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  BarChart3,
  FileText,
  Link as LinkIcon,
  Megaphone,
  MessageSquareText,
  Users,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import {
  broadcastAdminContent,
  broadcastAdminPdf,
  getAdminStats,
} from "../api/client.ts";
import { messageForApiError } from "../api/errors.ts";
import type { AdminBroadcastResponse } from "../api/types.ts";
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
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import AdminResults from "../components/AdminResults.tsx";

type AdminMode = "text" | "link" | "pdf";
type AdminSection = "broadcasts" | "results";

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MODES: {
  id: AdminMode;
  label: string;
  icon: typeof MessageSquareText;
}[] = [
  { id: "text", label: "Text Post", icon: MessageSquareText },
  { id: "link", label: "Link", icon: LinkIcon },
  { id: "pdf", label: "PDF", icon: FileText },
];

interface Props {
  initData: string;
}

function validHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function fileSizeLabel(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function AdminScreen({ initData }: Props) {
  const [section, setSection] = useState<AdminSection>("broadcasts");
  const [mode, setMode] = useState<AdminMode>("text");
  const [participantCount, setParticipantCount] = useState<number | null>(null);
  const [mawlidStartDate, setMawlidStartDate] = useState("");
  const [mawlidEndDate, setMawlidEndDate] = useState("");
  const [textMessage, setTextMessage] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkCaption, setLinkCaption] = useState("");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfCaption, setPdfCaption] = useState("");
  const [fileInputKey, setFileInputKey] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AdminBroadcastResponse | null>(null);
  const firstFieldRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getAdminStats(initData)
      .then((stats) => {
        if (!cancelled) {
          setParticipantCount(stats.participantCount);
          setMawlidStartDate(stats.mawlidStartDate);
          setMawlidEndDate(stats.mawlidEndDate);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(messageForApiError(err, "Couldn't load participant count."));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [initData]);

  useEffect(() => {
    setError(null);
    setResult(null);
    window.requestAnimationFrame(() => firstFieldRef.current?.focus());
  }, [mode]);

  function selectPdf(file: File | null): void {
    setResult(null);
    if (!file) {
      setPdfFile(null);
      return;
    }
    const looksLikePdf =
      file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (!looksLikePdf) {
      setPdfFile(null);
      setError("Choose a PDF file.");
      setFileInputKey((key) => key + 1);
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setPdfFile(null);
      setError("PDF must be 20 MB or smaller.");
      setFileInputKey((key) => key + 1);
      return;
    }
    setError(null);
    setPdfFile(file);
  }

  function validate(): string | null {
    if (mode === "text") {
      if (!textMessage.trim()) return "Enter a text post before sending.";
      if (textMessage.length > 4096) return "Text post must be 4,096 characters or fewer.";
    }
    if (mode === "link") {
      if (!validHttpUrl(linkUrl.trim())) return "Enter a valid HTTP or HTTPS URL.";
      if (linkCaption.length > 1024) return "Caption must be 1,024 characters or fewer.";
    }
    if (mode === "pdf") {
      if (!pdfFile) return "Choose a PDF file before sending.";
      if (pdfCaption.length > 1024) return "Caption must be 1,024 characters or fewer.";
    }
    return null;
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (sending || participantCount === null) return;

    const validation = validate();
    if (validation) {
      setError(validation);
      return;
    }

    const contentLabel =
      mode === "text" ? "this text post" : mode === "link" ? "this link" : "this PDF";
    const confirmed = window.confirm(
      `Send ${contentLabel} to ${participantCount.toLocaleString()} participant${
        participantCount === 1 ? "" : "s"
      }?`
    );
    if (!confirmed) return;

    setSending(true);
    setError(null);
    setResult(null);
    try {
      let response: AdminBroadcastResponse;
      if (mode === "text") {
        response = await broadcastAdminContent(initData, {
          type: "text",
          message: textMessage.trim(),
        });
        setTextMessage("");
      } else if (mode === "link") {
        response = await broadcastAdminContent(initData, {
          type: "link",
          url: linkUrl.trim(),
          message: linkCaption.trim() || undefined,
        });
        setLinkUrl("");
        setLinkCaption("");
      } else {
        response = await broadcastAdminPdf(
          initData,
          pdfFile!,
          pdfCaption.trim() || undefined
        );
        setPdfFile(null);
        setPdfCaption("");
        setFileInputKey((key) => key + 1);
      }
      setResult(response);
      setParticipantCount(response.participantCount);
    } catch (err) {
      setError(messageForApiError(err, "Couldn't send that broadcast."));
    } finally {
      setSending(false);
    }
  }

  const countLabel =
    participantCount === null ? "Loading…" : participantCount.toLocaleString();

  return (
    <main className="mx-auto max-w-sm space-y-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Admin</h1>
        <p className="text-sm text-muted-foreground">
          Broadcast updates and save live leaderboard results.
        </p>
      </div>

      <div className="flex items-center justify-between rounded-xl border bg-secondary/40 px-4 py-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Participants
          </p>
          <p className="text-2xl font-semibold tabular-nums text-foreground">{countLabel}</p>
        </div>
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Users className="h-5 w-5" aria-hidden="true" />
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Admin section"
        className="grid grid-cols-2 gap-1 rounded-xl bg-secondary/60 p-1"
      >
        {([
          { id: "broadcasts" as const, label: "Broadcasts", icon: Megaphone },
          { id: "results" as const, label: "Results", icon: BarChart3 },
        ]).map((item) => {
          const Icon = item.icon;
          const active = section === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSection(item.id)}
              className={cn(
                "flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {item.label}
            </button>
          );
        })}
      </div>

      {section === "broadcasts" ? (
        <>
      <div
        role="tablist"
        aria-label="Broadcast type"
        className="grid grid-cols-3 gap-1 rounded-xl bg-secondary/60 p-1"
      >
        {MODES.map((item) => {
          const Icon = item.icon;
          const active = mode === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setMode(item.id)}
              className={cn(
                "flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {item.label}
            </button>
          );
        })}
      </div>

      <form onSubmit={(event) => void handleSubmit(event)}>
        <Card>
          {mode === "text" && (
            <>
              <CardHeader>
                <CardTitle>Text Post</CardTitle>
                <CardDescription>
                  Use <code>**bold**</code> or <code>*italic*</code>. Raw HTML is ignored.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="admin-text-message">Message</Label>
                  <Textarea
                    id="admin-text-message"
                    ref={(node) => {
                      firstFieldRef.current = node;
                    }}
                    value={textMessage}
                    onChange={(event) => setTextMessage(event.target.value)}
                    placeholder="Share an ayah, reminder, or quote…"
                    maxLength={4096}
                    disabled={sending}
                    rows={7}
                  />
                  <p className="text-right text-xs tabular-nums text-muted-foreground">
                    {textMessage.length.toLocaleString()} / 4,096
                  </p>
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-medium text-foreground">Preview</p>
                  <div className="min-h-24 rounded-lg border bg-secondary/25 px-3 py-3 text-sm leading-relaxed text-foreground">
                    {textMessage.trim() ? (
                      <ReactMarkdown
                        skipHtml
                        allowedElements={["p", "strong", "em", "br"]}
                        components={{
                          p: ({ children }) => (
                            <p className="whitespace-pre-wrap [&:not(:last-child)]:mb-2">{children}</p>
                          ),
                        }}
                      >
                        {textMessage}
                      </ReactMarkdown>
                    ) : (
                      <p className="text-muted-foreground">Formatted preview appears here.</p>
                    )}
                  </div>
                </div>
              </CardContent>
            </>
          )}

          {mode === "link" && (
            <>
              <CardHeader>
                <CardTitle>Link</CardTitle>
                <CardDescription>
                  Telegram will generate a preview for YouTube and other supported URLs.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="admin-link-url">URL</Label>
                  <Input
                    id="admin-link-url"
                    ref={(node) => {
                      firstFieldRef.current = node;
                    }}
                    type="url"
                    inputMode="url"
                    value={linkUrl}
                    onChange={(event) => setLinkUrl(event.target.value)}
                    placeholder="https://youtube.com/…"
                    disabled={sending}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="admin-link-caption">Caption (optional)</Label>
                  <Textarea
                    id="admin-link-caption"
                    value={linkCaption}
                    onChange={(event) => setLinkCaption(event.target.value)}
                    placeholder="Why participants should watch this…"
                    maxLength={1024}
                    disabled={sending}
                    rows={4}
                  />
                </div>
                {(linkUrl.trim() || linkCaption.trim()) && (
                  <div className="rounded-lg border bg-secondary/25 px-3 py-3 text-sm">
                    {linkCaption.trim() && (
                      <p className="mb-2 whitespace-pre-wrap text-foreground">{linkCaption}</p>
                    )}
                    <p className="break-all text-primary">{linkUrl || "Link preview"}</p>
                  </div>
                )}
              </CardContent>
            </>
          )}

          {mode === "pdf" && (
            <>
              <CardHeader>
                <CardTitle>PDF Document</CardTitle>
                <CardDescription>
                  Upload one PDF up to 20 MB. It is forwarded directly to Telegram.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="admin-pdf-file">PDF file</Label>
                  <Input
                    key={fileInputKey}
                    id="admin-pdf-file"
                    ref={(node) => {
                      firstFieldRef.current = node;
                    }}
                    type="file"
                    accept="application/pdf,.pdf"
                    disabled={sending}
                    onChange={(event) => selectPdf(event.target.files?.[0] ?? null)}
                    className="h-12 cursor-pointer file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium"
                  />
                  {pdfFile && (
                    <div className="flex items-center gap-3 rounded-lg bg-secondary/35 px-3 py-2.5">
                      <FileText className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{pdfFile.name}</p>
                        <p className="text-xs text-muted-foreground">{fileSizeLabel(pdfFile.size)}</p>
                      </div>
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="admin-pdf-caption">Caption (optional)</Label>
                  <Textarea
                    id="admin-pdf-caption"
                    value={pdfCaption}
                    onChange={(event) => setPdfCaption(event.target.value)}
                    placeholder="A short note about this document…"
                    maxLength={1024}
                    disabled={sending}
                    rows={4}
                  />
                </div>
              </CardContent>
            </>
          )}

          <CardContent className="space-y-3 border-t pt-4">
            <Button
              type="submit"
              className="min-h-11 w-full"
              disabled={sending || participantCount === null || participantCount === 0}
            >
              {sending
                ? "Sending…"
                : `Send to ${participantCount?.toLocaleString() ?? "…"} participant${
                    participantCount === 1 ? "" : "s"
                  }`}
            </Button>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {result && (
              <div
                aria-live="polite"
                className="rounded-lg border border-primary/25 bg-primary/10 px-3 py-2.5 text-sm text-foreground"
              >
                <p className="font-medium">
                  Sent to {result.sentCount.toLocaleString()} of{" "}
                  {result.participantCount.toLocaleString()} participants.
                </p>
                {result.failedCount > 0 && (
                  <p className="mt-1 text-muted-foreground">
                    {result.failedCount.toLocaleString()} failed. Check the bot logs for details.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </form>
        </>
      ) : mawlidStartDate && mawlidEndDate ? (
        <AdminResults
          initData={initData}
          mawlidStartDate={mawlidStartDate}
          mawlidEndDate={mawlidEndDate}
        />
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Loading result periods…
          </CardContent>
        </Card>
      )}
    </main>
  );
}
