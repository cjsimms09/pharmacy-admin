import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Nothing reaches the model unless the owner pressed something.
 *
 * His rule, in his words: "nothing in our site should be using API unless I hit a button."
 *
 * It is not only about the bill, though the bill is real — the spend ran past its own monthly cap
 * and switched three readers off mid-month, which is the worst possible way to find out. It is that
 * an automatic call happens to a document nobody is looking at, produces a reading nobody checks,
 * and files it. The pharmacy then holds a figure with no person behind it.
 *
 * ── Why this is a gate and not a setting ──
 *
 * There are two doors to the model: `ai.ts` builds a client and so does `contract-extract.ts`. A
 * switch on one leaves the other open, and the next module to want the model builds a third. So the
 * rule lives where the client is built, both callers come through here, and the default is no.
 *
 * ── Why an async store and not a flag ──
 *
 * A module-level boolean is wrong on a server: two requests overlap, one sets it, the other reads
 * it, and an automatic sweep borrows a button press somebody else made. `AsyncLocalStorage` carries
 * the fact down one call tree only, which is exactly the scope of "this happened because he pressed
 * that".
 *
 * ── What a refusal means ──
 *
 * Not a failure. Every reader that calls the model already has a path for the model being
 * unavailable — the rules read what they can and the document waits for a person. A refusal here
 * lands on that path, which is the behaviour he asked for: the work waits until he looks at it.
 */

type Asked = { who: string; why: string };

const store = new AsyncLocalStorage<Asked>();

/** Thrown when something tried to reach the model on its own. Carries what it was trying to do. */
export class NotAsked extends Error {
  readonly what: string;
  constructor(what: string) {
    super(
      `${what} needs the model, and nothing calls it on its own. Open the page and press the button, ` +
        "and it will run then.",
    );
    this.name = "NotAsked";
    this.what = what;
  }
}

/**
 * Run something the owner asked for. Everything inside it may reach the model.
 *
 * `why` is recorded on the usage log, so the bill can be read as a list of things somebody pressed
 * rather than as a total.
 */
export function asked<T>(who: string, why: string, fn: () => Promise<T>): Promise<T> {
  return store.run({ who, why }, fn);
}

/** Who asked, if anybody. Null inside a scheduled sweep, a script, or a background job. */
export function whoAsked(): Asked | null {
  return store.getStore() ?? null;
}

/** The gate itself. Every path that builds a model client calls this first. */
export function mustBeAsked(what: string): Asked {
  const a = store.getStore();
  if (!a) throw new NotAsked(what);
  return a;
}

/** True where this call tree was started by a person. For a page that wants to explain itself. */
export function wasAsked(): boolean {
  // Through whoAsked, because getStore() returns undefined outside a run and not null — and the
  // first version of this compared against null, so it answered "yes, somebody asked" every time.
  // The gate itself was never wrong (it tests falsiness); only this did, and only a test found it.
  return whoAsked() !== null;
}
