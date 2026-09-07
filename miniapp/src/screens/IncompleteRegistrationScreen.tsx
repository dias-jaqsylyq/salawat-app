/** Shown when someone opens the Mini App before finishing bot /start signup. */
export default function IncompleteRegistrationScreen() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 text-center">
      <h1 className="text-lg font-semibold text-foreground">Finish signup in the bot</h1>
      <p className="mt-3 max-w-sm text-sm text-muted-foreground">
        Registration now happens in the Salawat Challenge bot chat. Open the bot, send{" "}
        <span className="font-medium text-foreground">/start</span>, and complete the short
        conversation. Then come back here via the menu button.
      </p>
    </div>
  );
}
