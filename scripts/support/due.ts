import "dotenv/config";
async function main(): Promise<void> {
  const { alerts } = await import("../../src/lib/alerts");
  for (const a of await alerts()) console.log(`[${a.level}] ${a.title}\n     ${a.why.slice(0, 220)}`);
}
main().then(() => process.exit(0), (e) => { console.error(String(e).slice(0, 400)); process.exit(1); });
