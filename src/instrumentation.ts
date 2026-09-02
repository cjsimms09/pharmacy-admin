/**
 * Runs once when the server starts. Schedules the automatic mailbox check so reports arrive
 * without anyone clicking anything. Only active in the Node.js runtime of a running server.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.DISABLE_BACKGROUND_JOBS === "1") return;

  const EVERY_MS = 30 * 60 * 1000;
  const START_DELAY_MS = 60 * 1000; // let the server settle before the first check

  const tick = async () => {
    try {
      const { getSettings } = await import("./lib/settings");
      const s = await getSettings();
      if (s.mail_enabled !== "yes" || !s.mail_user || !s.mail_password_enc) return;
      const { sweepMailbox } = await import("./lib/mailbox");
      await sweepMailbox({ userId: null, userName: "Automatic check" });
    } catch {
      // Never let a mail problem take the app down; the result is recorded in settings and the audit log.
    }
  };

  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), EVERY_MS).unref?.();
  }, START_DELAY_MS).unref?.();
}
