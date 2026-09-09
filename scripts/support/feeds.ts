/** What the PioneerRx pull has actually done, from the settings it writes. */
import { getSettings } from "../../src/lib/settings";

async function main() {
  const s = await getSettings();
  for (const [k, v] of Object.entries(s).sort()) {
    if (/pioneer|sftp/i.test(k)) console.log(`${k.padEnd(34)} ${String(v).slice(0, 150)}`);
  }
}
main().then(() => process.exit(0));
