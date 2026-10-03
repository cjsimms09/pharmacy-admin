import { PROTOCOL_VACCINES, EMERGENCY_STEPS, type ProtocolBlock } from "@/lib/immunization-protocol";

/**
 * The protocol's wording, rendered once.
 *
 * The same document is printed for a physician to sign, read on screen by the person who works to
 * it, and attached to the email that asks them to read it. It was written out longhand in the
 * print page, which meant the copy somebody signed for having read and the copy they were sent
 * could quietly stop being the same document — and nobody would ever notice, because noticing
 * would mean reading both. So every rendering walks the block list from the library, and this
 * component is how two of the three do it.
 */
export function ProtocolBody({ blocks, dense = false }: { blocks: ProtocolBlock[]; dense?: boolean }) {
  const p = dense ? "mt-3" : "mt-4 text-sm leading-relaxed";
  const small = dense ? "mt-3 text-[10px]" : "mt-4 text-xs leading-relaxed text-ink-2";

  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === "para") return <p key={i} className={p}>{b.text}</p>;
        if (b.kind === "heading") {
          return <p key={i} className={`${dense ? "mt-4" : "mt-6 text-sm"} font-semibold underline`}>{b.text}</p>;
        }
        if (b.kind === "statute") {
          return (
            <p key={i} className={small}>
              <b>{b.heading}</b> {b.text}
            </p>
          );
        }
        if (b.kind === "vaccines") {
          return (
            <table key={i} className={`${dense ? "mt-3 text-[10px]" : "mt-4 text-xs"} w-full font-semibold`}>
              <tbody>
                {PROTOCOL_VACCINES.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td key={c} className="py-0.5 pr-4 align-top">{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }
        return (
          <ol key={i} className={`ml-5 list-decimal ${dense ? "" : "mt-2 text-sm leading-relaxed"}`}>
            {EMERGENCY_STEPS.map((s) => <li key={s} className="mt-0.5">{s}</li>)}
          </ol>
        );
      })}
    </>
  );
}
