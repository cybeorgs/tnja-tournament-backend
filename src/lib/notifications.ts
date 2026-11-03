// Start-up tasks. No tournament emails are sent: the only automatic emails are the registration
// emails (lib/registrationEmails.ts).
import { confirmUnpaid } from "./fees.js";

/**
 * On start-up: entries left unpaid from when registration had a fee are confirmed (nothing is due
 * any more). Runs once.
 */
export function startReminderScheduler() {
  confirmUnpaid()
    .then((n) => n && console.log(`[registration] ${n} unpaid entr${n === 1 ? "y" : "ies"} from before free registration confirmed.`))
    .catch((err) => console.error("[registration] Confirming unpaid entries failed:", err));
}
