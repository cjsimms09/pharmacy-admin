import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// A gate that fails closed does nothing for a button that never asked: the press is refused and the page tells him to press the button he just pressed. Source only: no database, no model, no network. Every source in the tests of the scan itself is invented.

const ROOT = process.cwd();
const DOORS = ["src/lib/ai.ts", "src/lib/business-docs.ts", "src/lib/contract-extract.ts"];
const AI_MODULE = /(^|\/)ai$/;

type Source = { file: string; text: string };
type Parsed = { file: string; sf: ts.SourceFile };
type Site = { file: string; line: number; fn: string; name: string; wrapped: boolean; call: string | null; text: string };
type Allowed = { file: string; fn: string; names: string[]; why: string; ok?: (call: string | null, text: string) => boolean };

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") walk(p, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");

const readTree = (): Source[] => walk(path.join(ROOT, "src")).map((f) => ({ file: rel(f), text: fs.readFileSync(f, "utf8") }));

function parse(sources: Source[]): Parsed[] {
  return sources.map(({ file, text }) => ({
    file,
    sf: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS),
  }));
}

function refsIn(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isTypeNode(n)) return;
    if (ts.isIdentifier(n)) names.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return names;
}

function unitsOf(sf: ts.SourceFile): { name: string; node: ts.Node }[] {
  const out: { name: string; node: ts.Node }[] = [];
  for (const st of sf.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) out.push({ name: st.name.text, node: st });
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) out.push({ name: d.name.text, node: d.initializer });
    }
  }
  return out;
}

function namedImports(sf: ts.SourceFile): { from: string; imported: string; local: string }[] {
  const out: { from: string; imported: string; local: string }[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const nb = st.importClause?.namedBindings;
    if (!nb || !ts.isNamedImports(nb)) continue;
    for (const el of nb.elements) out.push({ from: st.moduleSpecifier.text, imported: (el.propertyName ?? el.name).text, local: el.name.text });
  }
  return out;
}

function reach(parsed: Parsed[]) {
  const units = parsed
    .filter((p) => p.file.startsWith("src/lib/"))
    .flatMap((p) => unitsOf(p.sf).map((u) => ({ file: p.file, name: u.name, refs: refsIn(u.node) })));
  const reaching = new Set<string>();
  const via = new Map<string, string>();
  const seeds: string[] = [];
  for (const u of units) {
    if (DOORS.includes(u.file) && u.name !== "client" && u.refs.has("client")) {
      reaching.add(u.name);
      via.set(u.name, "client");
      seeds.push(u.name);
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const u of units) {
      if (reaching.has(u.name)) continue;
      const hit = [...u.refs].find((r) => r !== u.name && reaching.has(r));
      if (hit) {
        reaching.add(u.name);
        via.set(u.name, hit);
        changed = true;
      }
    }
  }
  return { reaching, via, seeds };
}

function enclosingName(n: ts.Node): string {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) return p.name.getText();
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) return p.parent.name.text;
  }
  return "<module>";
}

function wrappedInAsk(n: ts.Node): boolean {
  let child: ts.Node = n;
  for (let p: ts.Node | undefined = n.parent; p; child = p, p = p.parent) {
    if (!ts.isCallExpression(p) || !ts.isIdentifier(p.expression)) continue;
    if (!p.arguments.some((a) => a === child)) continue;
    if (p.expression.text === "asked") {
      // Only the function handed over runs inside the ask; an argument worked out beside it does not.
      const handedOver = child === n || (ts.isPropertyAccessExpression(child) && child.name === n) || ts.isArrowFunction(child) || ts.isFunctionExpression(child);
      if (p.arguments[2] === child && handedOver) return true;
      continue;
    }
    if (p.expression.text === "after") return false;
  }
  return false;
}

function callOf(id: ts.Identifier): string | null {
  const callee: ts.Node = ts.isPropertyAccessExpression(id.parent) && id.parent.name === id ? id.parent : id;
  const p = callee.parent;
  return p && ts.isCallExpression(p) && p.expression === callee ? p.getText() : null;
}

function isNameOnly(n: ts.Identifier): boolean {
  const p = n.parent;
  return (
    (ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) || ts.isPropertyAssignment(p) ||
      ts.isPropertySignature(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isJsxAttribute(p)) &&
    p.name === n
  );
}

function sitesOf(parsed: Parsed[], reaching: Set<string>): Site[] {
  const sites: Site[] = [];
  for (const { file, sf } of parsed) {
    if (file.startsWith("src/lib/")) continue;
    const here = new Set(reaching);
    for (const i of namedImports(sf)) if (reaching.has(i.imported)) here.add(i.local);
    const visit = (n: ts.Node): void => {
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isTypeNode(n)) return;
      if (ts.isIdentifier(n) && here.has(n.text) && !isNameOnly(n)) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
        sites.push({ file, line, fn: enclosingName(n), name: n.text, wrapped: wrappedInAsk(n), call: callOf(n), text: sf.text });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return sites;
}

function scan(sources: Source[]) {
  const parsed = parse(sources);
  const { reaching, via, seeds } = reach(parsed);
  return { parsed, reaching, via, seeds, sites: sitesOf(parsed, reaching) };
}

function chainOf(name: string, via: Map<string, string>): string {
  const out = [name];
  for (let n = via.get(name); n && out.length < 12; n = via.get(n)) out.push(n);
  return out.join(" -> ");
}

function judge(sites: Site[], allowed: Allowed[]) {
  const loose: Site[] = [];
  const refused: Site[] = [];
  const used = new Set<string>();
  for (const s of sites) {
    if (s.wrapped) continue;
    const i = allowed.findIndex((a) => a.file === s.file && a.fn === s.fn && a.names.includes(s.name));
    if (i < 0) {
      loose.push(s);
      continue;
    }
    used.add(`${i}:${s.name}`);
    const guard = allowed[i].ok;
    if (guard && !guard(s.call, s.text)) refused.push(s);
  }
  const stale = allowed.flatMap((a, i) => a.names.filter((n) => !used.has(`${i}:${n}`)).map((n) => `${a.file} :: ${a.fn} :: ${n}`));
  return { loose, refused, stale };
}

function inServerAction(n: ts.Node, sf: ts.SourceFile): boolean {
  const opens = (body: readonly ts.Statement[]) => {
    for (const st of body) {
      if (!ts.isExpressionStatement(st) || !ts.isStringLiteral(st.expression)) return false;
      if (st.expression.text === "use server") return true;
    }
    return false;
  };
  if (opens(sf.statements)) return true;
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isArrowFunction(p) || ts.isMethodDeclaration(p)) && p.body && ts.isBlock(p.body) && opens(p.body.statements)) return true;
  }
  return false;
}

function strayAsks(parsed: Parsed[]): string[] {
  const out: string[] = [];
  for (const { file, sf } of parsed) {
    const calls: ts.CallExpression[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "asked") calls.push(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (calls.length === 0) continue;
    if (!file.startsWith("src/app/")) out.push(`${file}: calls asked() outside src/app, where a background path could ask for itself`);
    else if (!namedImports(sf).some((i) => /(^|\/)ai-gate$/.test(i.from) && i.imported === "asked" && i.local === "asked")) out.push(`${file}: calls asked() but does not import it from the gate`);
    else for (const c of calls) if (!inServerAction(c, sf)) out.push(`${file}:${sf.getLineAndCharacterOfPosition(c.getStart()).line + 1}: calls asked() outside a server action, so a page that merely loads, or is reloaded, could ask`);
  }
  return out;
}

function importsClient(sf: ts.SourceFile): boolean {
  if (namedImports(sf).some((i) => AI_MODULE.test(i.from) && i.imported === "client")) return true;
  let found = false;
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isObjectBindingPattern(n.name)) {
      const init = ts.isAwaitExpression(n.initializer) ? n.initializer.expression : n.initializer;
      if (ts.isCallExpression(init) && init.expression.kind === ts.SyntaxKind.ImportKeyword && init.arguments.length === 1) {
        const arg = init.arguments[0];
        if (ts.isStringLiteralLike(arg) && AI_MODULE.test(arg.text) && n.name.elements.some((e) => (e.propertyName ?? e.name).getText() === "client")) found = true;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

function strayDoors(parsed: Parsed[]): string[] {
  const out: string[] = [];
  for (const { file, sf } of parsed) {
    if (DOORS.includes(file)) continue;
    const visit = (n: ts.Node): void => {
      if (ts.isStringLiteralLike(n) && (n.text === "@anthropic-ai/sdk" || n.text.startsWith("@anthropic-ai/sdk/") || n.text.includes("api.anthropic.com"))) out.push(`${file}: names the model SDK or its address outside the three door modules`);
      if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Anthropic") out.push(`${file}: builds a model client outside the three door modules`);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (importsClient(sf)) out.push(`${file}: takes the model client from ai.ts and is not a door module, so the scan would not see what it reaches`);
  }
  return out;
}

function clientFunctions(sf: ts.SourceFile): ts.FunctionDeclaration[] {
  return sf.statements.filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "client");
}

function strayGates(parsed: Parsed[]): string[] {
  const out: string[] = [];
  for (const { file, sf } of parsed) {
    if (!DOORS.includes(file)) continue;
    const outside = (n: ts.Node): void => {
      if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Anthropic" && enclosingName(n) !== "client") out.push(`${file}: builds a model client outside client(), where the gate is not asked`);
      ts.forEachChild(n, outside);
    };
    outside(sf);
    for (const fn of clientFunctions(sf)) {
      let gate = -1;
      let first = Infinity;
      const inside = (n: ts.Node): void => {
        if (gate < 0 && ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "mustBeAsked") gate = n.getStart();
        const reads = ts.isIdentifier(n) && (n.text === "getSettings" || n.text === "decryptText");
        const builds = ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Anthropic";
        if (reads || builds) first = Math.min(first, n.getStart());
        ts.forEachChild(n, inside);
      };
      inside(fn);
      if (gate < 0) out.push(`${file}: client() never calls mustBeAsked`);
      else if (gate > first) out.push(`${file}: client() reads the key or builds the client before it calls mustBeAsked`);
    }
  }
  return out;
}

function heldOptions(parsed: Parsed[]): string[] {
  const out: string[] = [];
  const invoices = parsed.find((p) => p.file === "src/lib/invoices.ts");
  if (invoices) {
    const fn = invoices.sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "rereadShortInvoices");
    const values: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAssignment(n) && n.name.getText() === "allowModel") values.push(n.initializer.getText());
      ts.forEachChild(n, visit);
    };
    if (fn) visit(fn);
    if (!fn || values.length === 0 || values.some((v) => v !== "false")) out.push("src/lib/invoices.ts: rereadShortInvoices has to pass allowModel: false, because the nightly job calls it without asking");
  }
  return out;
}

function pageReadings(reaching: Set<string>, via: Map<string, string>): string[] {
  return ["feedsNow", "setupNow"].filter((n) => reaching.has(n)).map((n) => chainOf(n, via));
}

function expectNone(lines: string[], hint: string) {
  assert.equal(lines.length, 0, `${hint}\n  ${lines.join("\n  ")}`);
}

const FILING = "Filing reads the page with rules and the pharmacy own records. Where neither settles it the model is not asked: the invoice is held for him and says so. Wrapping this would make every filing spend.";
const RETIRED_PAGE = "The page is retired (src/lib/retired.ts redirects its address), so nobody can press this. Delete the handler with the page.";
const AUTOMATIC = "Runs on its own, so the gate refuses what it asks of the model, by design. Nothing here may be wrapped.";
const INBOX = "src/app/(app)/inbox/actions.ts";
const INTAKE = "src/app/(app)/intake/actions.ts";
const INVOICES_PAGE = "src/app/(app)/inventory/invoices/page.tsx";
const CONTRACTS = "src/app/(app)/payers/contracts/page.tsx";
const SORT = "src/app/(app)/payers/sort/page.tsx";
const BOOT = "src/instrumentation.ts";

const ALLOWED: Allowed[] = [
  { file: INTAKE, fn: "applyBusiness", names: ["writeInvoiceLines"], why: "Filing at the intake does not ask Claude to read the lines. The invoices page has the button that does.", ok: (c) => c !== null && !/allowModel/.test(c) },
  { file: BOOT, fn: "invoiceLinesTick", names: ["backfillInvoiceLines"], why: "The nightly re-read uses rules only: it passes allowModel: false, so the model is never asked.", ok: (c) => c !== null && /\ballowModel:\s*false\b/.test(c) },
  { file: BOOT, fn: "invoiceLinesTick", names: ["rereadShortInvoices"], why: "Rules only: the function passes allowModel: false itself (held by the options test below).", ok: (c) => c !== null },
  { file: INBOX, fn: "attributeInboxItem", names: ["rereadInboxItem"], why: FILING },
  { file: INBOX, fn: "rereadItem", names: ["rereadInboxItem"], why: FILING },
  { file: INBOX, fn: "teachInboxItem", names: ["rereadInboxItem"], why: FILING },
  { file: INBOX, fn: "reRouteInboxItem", names: ["importDropped"], why: FILING },
  { file: INBOX, fn: "resortAll", names: ["resortInbox"], why: FILING },
  { file: INBOX, fn: "sweepNow", names: ["sweepMailbox"], why: FILING },
  { file: INTAKE, fn: "applyBusiness", names: ["fileInvoice"], why: FILING },
  { file: INTAKE, fn: "readIntoIntake", names: ["importDropped"], why: FILING },
  { file: INVOICES_PAGE, fn: "fileThem", names: ["adoptAll"], why: FILING },
  { file: INVOICES_PAGE, fn: "upload", names: ["uploadInvoice"], why: FILING },
  { file: INVOICES_PAGE, fn: "supplierAddress", names: ["rereadFromSenders"], why: FILING },
  { file: "src/app/(app)/suppliers/page.tsx", fn: "save", names: ["rereadFromSenders"], why: FILING },
  { file: CONTRACTS, fn: "collect", names: ["collectExtraction"], why: RETIRED_PAGE },
  { file: CONTRACTS, fn: "read", names: ["queueExtraction"], why: RETIRED_PAGE },
  { file: CONTRACTS, fn: "readAll", names: ["queueExtraction"], why: RETIRED_PAGE },
  { file: CONTRACTS, fn: "readOne", names: ["queueExtraction"], why: RETIRED_PAGE },
  { file: SORT, fn: "collect", names: ["collectTriage"], why: RETIRED_PAGE },
  { file: SORT, fn: "proveIt", names: ["proveReader"], why: RETIRED_PAGE },
  { file: SORT, fn: "sort", names: ["queueTriage"], why: RETIRED_PAGE },
  { file: SORT, fn: "testOne", names: ["testReader"], why: RETIRED_PAGE },
  { file: SORT, fn: "why", names: ["recoverFailures"], why: RETIRED_PAGE },
  { file: BOOT, fn: "cqiTick", names: ["runCqiAutomation"], why: AUTOMATIC },
  { file: BOOT, fn: "sftpTick", names: ["pullSftp"], why: AUTOMATIC },
  { file: BOOT, fn: "tick", names: ["sweepMailbox"], why: AUTOMATIC },
  { file: BOOT, fn: "manualAuditTick", names: ["runManualAudit"], why: AUTOMATIC },
  {
    file: "src/app/(app)/tools/pioneer-sql/page.tsx",
    fn: "test",
    names: ["testConnection"],
    why: "The PioneerRx SQL page runs its own connection test: the same name as the Claude one, a different function.",
    ok: (c, text) => c !== null && !/from\s+["']@\/lib\/ai["']/.test(text),
  },
];

let real: ReturnType<typeof scan> | undefined;
const getReal = () => (real ??= scan(readTree()));
const where = (s: Site) => `${s.file}:${s.line}`;

function entry(file: string, fn: string, name: string): Allowed {
  const a = ALLOWED.find((x) => x.file.endsWith(file) && x.fn === fn && x.names.includes(name));
  if (!a) throw new Error(`${file} :: ${fn} :: ${name} is not on the list`);
  return a;
}

describe("every press that reaches the model asks for it", () => {
  test("the scan finds the doors of the model", () => {
    const { seeds, parsed } = getReal();
    for (const name of ["readInvoice", "readBusinessDocument", "reviewPolicy", "testConnection"]) {
      assert.ok(seeds.includes(name), `${name} should be one of the names that reach the model, and the scan did not find it`);
    }
    assert.ok(seeds.length >= 10, `only ${seeds.length} names reach the model; the scan has stopped finding them`);
    for (const file of ["src/lib/ai.ts", "src/lib/contract-extract.ts"]) {
      const p = parsed.find((x) => x.file === file);
      assert.equal(p ? clientFunctions(p.sf).length : 0, 1, `${file} should declare one client()`);
    }
  });

  test("every call outside src/lib to something that reaches the model is inside asked(), or is on the list with its reason", () => {
    const { sites, via } = getReal();
    const { loose, refused } = judge(sites, ALLOWED);
    expectNone(
      loose.map((s) => `${where(s)}  ${s.name} (in ${s.fn}) reaches the model, ${chainOf(s.name, via)}, and is not inside asked()`),
      "A press that reaches the model has to ask for it, or the gate refuses it and the page tells him to press the button he just pressed. Wrap the call: await asked(user.name, why, () => theCall(...)). If it is meant to run without asking, add it to ALLOWED with the reason:",
    );
    expectNone(
      refused.map((s) => `${where(s)}  ${s.call ?? s.name}`),
      "These are on the list because of what they pass, and what they pass has changed. Either the call reaches the model now and has to ask, or the guard on its entry is out of date:",
    );
  });

  test("nothing on the list is out of date", () => {
    const { stale } = judge(getReal().sites, ALLOWED);
    expectNone(stale, "These entries in ALLOWED match no call that is not already inside asked(). Delete them, so the list only ever says what is true:");
    for (const a of ALLOWED) assert.ok(a.why.length > 40, `${a.file} :: ${a.fn} needs its reason written out`);
  });

  test("each guard on the list refuses the call it is there to catch", () => {
    const refuses = (file: string, fn: string, name: string, call: string | null, text = "") => assert.equal(entry(file, fn, name).ok?.(call, text), false, `${file} :: ${fn} :: ${call}`);
    refuses("intake/actions.ts", "applyBusiness", "writeInvoiceLines", "writeInvoiceLines(id, text, { allowModel: true })");
    refuses("instrumentation.ts", "invoiceLinesTick", "backfillInvoiceLines", "backfillInvoiceLines({ allowModel: true })");
    refuses("instrumentation.ts", "invoiceLinesTick", "backfillInvoiceLines", "backfillInvoiceLines({})");
    refuses("tools/pioneer-sql/page.tsx", "test", "testConnection", "testConnection()", 'import { testConnection } from "@/lib/ai";');
  });

  test("only the three door modules reach the SDK or take the model client", () => {
    expectNone(strayDoors(getReal().parsed), "Every model call has to come through one of the three door modules, where the gate is asked first:");
  });

  test("both client() functions ask the gate before they read the key", () => {
    expectNone(strayGates(getReal().parsed), "The gate has to be the first thing client() does:");
  });

  test("asked() is called only from pages, actions and routes, and it is the real one", () => {
    expectNone(strayAsks(getReal().parsed), "Only something he pressed may ask, and only the asked() of the gate counts:");
  });

  test("the options that let a shared function reach the model are held where the list relies on them", () => {
    const { parsed } = getReal();
    assert.ok(parsed.some((p) => p.file === "src/lib/invoices.ts"), "src/lib/invoices.ts is gone, and the list entries that rely on it have to be looked at again");
    expectNone(heldOptions(parsed), "The list says these never reach the model:");
  });

  test("the feeds and setup readings do not reach the model, so a page that merely loads cannot spend", () => {
    const { reaching, via } = getReal();
    expectNone(
      pageReadings(reaching, via),
      "Today, the feeds page and the setup list make these readings every time they load. Testing Claude is a call to the API: it belongs behind the Test connection and Save and test buttons under Settings -> Claude, never in a reading a page makes on its own. They reach the model through:",
    );
  });
});

describe("the scan itself: each of these has to fail when it should", () => {
  const door = "function client() { return 1; }\nexport async function readThing() { return client(); }\nexport async function plain() { return 2; }\n";
  const lab = (files: Record<string, string>) => scan(Object.entries(files).map(([file, text]) => ({ file, text })));
  const app = (body: string, extra: Record<string, string> = {}) =>
    lab({ "src/lib/ai.ts": door, "src/app/page.tsx": `import { asked } from "@/lib/ai-gate";\nimport { readThing } from "@/lib/ai";\n${body}`, ...extra });
  const loose = (r: ReturnType<typeof scan>) => r.sites.filter((s) => !s.wrapped).map((s) => `${s.fn}:${s.name}`);

  test("a call with nothing around it is found, and one inside asked() is not", () => {
    assert.deepEqual(loose(app("export async function save() { await readThing(); }")), ["save:readThing"]);
    assert.deepEqual(loose(app('export async function save() { await asked("a", "b", () => readThing()); }')), []);
  });

  test("a call before the ask, or beside it, is not covered by it", () => {
    assert.deepEqual(loose(app('export async function save() { await readThing(); await asked("a", "b", async () => 1); }')), ["save:readThing"]);
  });

  test("a function handed over by name is covered by asked() and by nothing else", () => {
    assert.deepEqual(loose(app('export async function save() { await asked("a", "b", readThing); }')), []);
    assert.deepEqual(loose(app("export async function save() { after(readThing); }")), ["save:readThing"]);
  });

  test("only the function handed to asked() is covered, not something worked out in its other arguments", () => {
    assert.deepEqual(loose(app('export async function save() { await asked("a", String(await readThing()), async () => 1); }')), ["save:readThing"]);
    assert.deepEqual(loose(app('export async function save() { await asked("a", "b", readThing()); }')), ["save:readThing"]);
    assert.deepEqual(loose(app('export async function save() { await asked(String(await readThing()), "b", async () => 1); }')), ["save:readThing"]);
    assert.deepEqual(loose(app('export async function save() { await asked("a", "b", obj.readThing); }')), []);
    assert.deepEqual(loose(app('export async function save() { await asked("x", "y", async () => asked("a", String(await readThing()), async () => 1)); }')), []);
  });

  test("after() leaves the ask behind unless the ask is made inside it", () => {
    assert.deepEqual(loose(app('export async function save() { await asked("a", "b", async () => { after(() => readThing()); }); }')), ["save:readThing"]);
    assert.deepEqual(loose(app('export async function save() { after(() => asked("a", "b", () => readThing())); }')), []);
  });

  test("a library function that calls a door is itself found, and so is whoever calls it", () => {
    const r = app("export async function save() { await readAll(); }", { "src/lib/wrap.ts": 'import { readThing } from "./ai";\nexport async function readAll() { return readThing(); }\n' });
    assert.ok(r.reaching.has("readAll"));
    assert.deepEqual(loose(r), ["save:readAll"]);
    assert.equal(chainOf("readAll", r.via), "readAll -> readThing -> client");
  });

  test("a library function that never touches a door is left alone, and so is a call made inside the library", () => {
    assert.deepEqual(loose(app("export async function save() { await plain(); }")), []);
    assert.deepEqual(loose(lab({ "src/lib/ai.ts": door, "src/lib/wrap.ts": "export async function w() { return readThing(); }" })), []);
  });

  test("an import under another name is followed", () => {
    const r = lab({ "src/lib/ai.ts": door, "src/app/page.tsx": 'import { readThing as rt } from "@/lib/ai";\nexport async function save() { await rt(); }\n' });
    assert.deepEqual(loose(r), ["save:rt"]);
  });

  test("a name that is only declared, used as a key, or written in a type is not a call", () => {
    const body = "const other = { readThing: 1 };\nfunction f(readThing: number) { return other; }\nasync function readThing() { return 1; }\nexport type T = Awaited<ReturnType<typeof readThing>>;";
    assert.deepEqual(loose(app(body)), []);
  });

  test("an entry on the list that nothing matches is reported, and so is one whose guard fails", () => {
    const r = app("export async function save() { await readThing({ probe: true }); }");
    const listed = { file: "src/app/page.tsx", fn: "save", names: ["readThing"], why: "x".repeat(50) };
    assert.equal(judge(r.sites, [listed]).loose.length, 0);
    assert.deepEqual(judge(r.sites, [{ ...listed, names: ["other"] }]).loose.map((s) => s.name), ["readThing"]);
    assert.deepEqual(judge(r.sites, [listed, { ...listed, fn: "gone" }]).stale, ["src/app/page.tsx :: gone :: readThing"]);
    const refusing = judge(r.sites, [{ ...listed, ok: (c: string | null) => c !== null && !/probe/.test(c) }]);
    assert.equal(refusing.refused.length, 1);
    assert.equal(refusing.stale.length, 0);
    assert.equal(judge(r.sites, [{ ...listed, ok: (c: string | null) => c !== null && /probe/.test(c) }]).refused.length, 0);
  });

  test("asked() called from the library, or not taken from the gate, is reported", () => {
    const run = (file: string, text: string) => strayAsks(parse([{ file, text }])).length;
    const call = 'export async function g() { "use server"; return asked("a", "b", async () => 1); }';
    assert.equal(run("src/lib/x.ts", call), 1);
    assert.equal(run("src/instrumentation.ts", call), 1);
    assert.equal(run("src/app/page.tsx", `async function asked(a: string, b: string, f: () => Promise<number>) { return f(); }\n${call}`), 1);
    assert.equal(run("src/app/page.tsx", `import { asked } from "@/lib/ai-gate";\n${call}`), 0);
  });

  test("asked() called where a page merely loads is reported, and one inside a server action is not", () => {
    const head = 'import { asked } from "@/lib/ai-gate";\n';
    const run = (text: string, first = "") => strayAsks(parse([{ file: "src/app/page.tsx", text: first + head + text }])).length;
    const ask = 'await asked("a", "b", async () => 1);';
    assert.equal(run(`export default async function Page() { ${ask} return null; }`), 1, "in the body of the page, which a plain load or reload runs");
    assert.equal(run(`export default async function Page() { async function press() { "use server"; ${ask} } return null; }`), 0, "in an action declared inside the page");
    assert.equal(run(`export async function press() { ${ask} }`, '"use server";\n'), 0, "in a file whose every export is an action");
    assert.equal(run(`"use server";\nexport async function press() { ${ask} }`), 1, "a file-level directive after an import is not a directive");
    assert.equal(run(`export const press = async () => { "use server"; ${ask} };`), 0, "in an arrow function that is an action");
    assert.equal(run(`async function press() { "use server"; after(async () => { ${ask} }); }`), 0, "in a function handed to after() inside an action");
    assert.equal(run(`async function press() { const x = 1; "use server"; ${ask} }`), 1, "a directive after another statement is not a directive");
    assert.equal(run(`export default function Box() { ${ask} }`, '"use client";\n'), 1, "a client file is not an action");
    assert.equal(run(`async function helper() { ${ask} }\nexport async function press() { "use server"; await helper(); }`), 1, "a helper outside the action, even one the action calls");
  });

  test("a reading that reaches the model through a dynamic import is followed, so its callers are found", () => {
    const feeds = (body: string) => `export async function feedsNow(o: { probe?: boolean }) { ${body} return 1; }\n`;
    const reaches = (text: string) => lab({ "src/lib/ai.ts": door, "src/lib/feeds.ts": text }).reaching.has("feedsNow");
    assert.equal(reaches(feeds('if (o.probe) { const { readThing } = await import("./ai"); await readThing(); }')), true);
    assert.equal(reaches(feeds("")), false);
  });

  test("a page reading that reaches the model is handed to the check, by name and with the way it gets there", () => {
    const found = (file: string, text: string) => {
      const r = lab({ "src/lib/ai.ts": door, [file]: text });
      return pageReadings(r.reaching, r.via);
    };
    assert.deepEqual(found("src/lib/feeds.ts", "export async function feedsNow() { return readThing(); }"), ["feedsNow -> readThing -> client"]);
    assert.deepEqual(found("src/lib/setup-store.ts", "export async function setupNow() { return readThing(); }"), ["setupNow -> readThing -> client"]);
    assert.deepEqual(found("src/lib/feeds.ts", "export async function feedsNow() { return 1; }"), []);
  });

  test("a client built or taken outside the three door modules is reported", () => {
    const run = (file: string, text: string) => strayDoors(parse([{ file, text }])).length;
    assert.equal(run("src/lib/other.ts", 'import Anthropic from "@anthropic-ai/sdk";\nexport const c = new Anthropic({});'), 2);
    assert.equal(run("src/lib/other.ts", 'import { client } from "./ai";\nexport const c = client;'), 1);
    assert.equal(run("src/lib/other.ts", 'export async function f() { const { client } = await import("./ai"); return client; }'), 1);
    assert.equal(run("src/lib/other.ts", 'export const url = "https://api.anthropic.com/v1/messages";'), 1);
    assert.equal(run("src/lib/ai.ts", 'import Anthropic from "@anthropic-ai/sdk";\nexport const c = new Anthropic({});'), 0);
  });

  test("a client() that does not ask the gate first is reported", () => {
    const run = (text: string) => strayGates(parse([{ file: "src/lib/ai.ts", text }])).length;
    const fn = (body: string) => `export async function client() {\n${body}\n}`;
    assert.equal(run(fn("mustBeAsked('x');\nconst s = await getSettings();\nreturn new Anthropic({ s });")), 0);
    assert.equal(run(fn("const s = await getSettings();\nmustBeAsked('x');\nreturn new Anthropic({ s });")), 1);
    assert.equal(run(fn("return new Anthropic({});")), 1);
    assert.equal(run("export async function other() { return new Anthropic({}); }"), 1);
  });

  test("an option held at false is reported when it is not", () => {
    const inv = (text: string) => heldOptions(parse([{ file: "src/lib/invoices.ts", text }])).length;
    const reread = (v: string) => `export async function rereadShortInvoices() { return write({ allowModel: ${v} }); }`;
    assert.equal(inv(reread("false")), 0);
    assert.equal(inv(reread("true")), 1);
    assert.equal(inv("export async function rereadShortInvoices() { return 1; }"), 1);
  });
});
