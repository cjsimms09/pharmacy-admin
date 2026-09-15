# The SFTP mailbox rejects every file it collects

*Helper B (cloud, Session 2's helper), 9 September 2026, on `feature/compliance` at `1c1fe0d`.
Measured by running `acceptableAttachment` against the base's own tree and against this branch's,
not by reading either.*

`1a71d99` built the SFTP mailbox RedSail asked for: *"To do this automatically, we would need a
SFTP site to send them to."* `sftp-pull.ts` collects every file on the host each half hour and puts
it through the same door an emailed attachment goes through:

```ts
const verdict = acceptableAttachment({ filename: f.name, content: buf });
```

**No `contentType`.** There is none to give — a file on a filesystem has a name and bytes and no
MIME type. But `acceptableAttachment` is MIME-aware: for a name with a known extension it requires
`REPORT_MIME.has(type)`, and `""` is not in that set. So the branch that should accept a `.csv`
refuses it for having *"an unknown type"*.

Run as `sftp-pull.ts` calls it, **against the base's own `autoroute.ts`**:

| file on the host | verdict |
| --- | --- |
| `REMIT_20260908.835` | refused — "not a type this reads" |
| `remit.edi` | refused — "not a type this reads" |
| `nadac_2026-09-05.csv` | refused — "sent as an unknown type" |
| `Mck9_6_2026.txt` | refused — "sent as an unknown type" |
| `catalogue` (no extension) | refused — "no file extension, sent as an unknown type" |
| `invoice_11490216.pdf` | refused — "sent as an unknown type" |
| `copay-remit-redsail.pdf` | refused — "sent as an unknown type" |

**Everything. Including the RedSail copay statement the host was built to receive.** The same call
with a type supplied, as the mail sweep supplies one, accepts the csv and the pdf — so the gate is
right and the call is missing an argument.

**And the file does not wait for anyone to notice.** On a refusal `sftp-pull.ts` writes an
`inbox_items` row with `status: "rejected"` and then renames the original into `done/`. The
sender's push succeeded, the site collected it, and the document is now in a folder nothing sweeps
again, with a reason that says the file was the wrong type when it was not.

## What this branch changes, and what it does not

The envelope branch in `acceptableAttachment` on this branch (BACKLOG 27) lets an X12 835 through
before any rule about names, so on **this** branch `REMIT_20260908.835` and `remit.edi` are
accepted. That is the only difference. **Every other row above is still refused**, on both trees.
So merging my work would leave the mailbox admitting remittances and nothing else — better, and
still not what the feature is for.

## The fix, and why I have not made it

`sftp-pull.ts` is new and not mine, and this is one argument at one call site. Two ways:

1. **At the call site.** Derive a type from the extension before asking — the puller knows the
   name, and the mapping already exists in `REPORT_EXT`/`REPORT_MIME`.
2. **In the gate**, by distinguishing *"the caller supplied a type and it is not one we read"* from
   *"the caller has no type to supply"*. `sftp-pull.ts` passes no field at all, so `contentType` is
   `undefined` there, while the mail sweep passes `a.contentType` from the parser.

I would take (1), and I have not taken (2) unilaterally although `autoroute.ts` is mine: the mail
parser can also yield `undefined` for a part with no `Content-Type` header, so treating "no type
supplied" as "judge on the extension alone" would quietly loosen the email door as well as open the
SFTP one. That is a decision about the email gate, and the email gate's rule — *"everything else
still needs a known extension and a known type"* — was written deliberately. It should be changed
on purpose or not at all.

**One thing to check on the real host before anything else:** whether files have already been
collected and moved to `done/`. Every one of them is a document the pharmacy received and the site
recorded as the wrong type. They are not lost — they are in `done/` — but nothing will look there
on its own.
