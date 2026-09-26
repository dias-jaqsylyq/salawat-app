/** Shown when someone opens the Mini App before finishing bot /start signup. */
export default function IncompleteRegistrationScreen() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 text-center">
      <h1 className="text-headline text-foreground">Finish signup in the bot</h1>
      <p className="mt-3 max-w-sm text-footnote text-muted-foreground">
        Registration happens in the bot chat. Open it, send{" "}
        <span className="font-semibold text-foreground">/start</span>, and choose whether you're
        setting up a new competition or joining an existing one — joining needs the room
        password from its admin. Then come back here via the menu button.
      </p>
    </div>
  );
}
