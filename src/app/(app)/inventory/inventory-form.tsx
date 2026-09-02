import { Field } from "@/components/ui";
import { todayIso } from "@/lib/dates";

type Person = { id: string; firstName: string; lastName: string; active: boolean };
type Inv = {
  inventoryDate: string;
  takenAt: string;
  timeStarted: string | null;
  timeEnded: string | null;
  isKsAnnual: boolean;
  isDeaBiennial: boolean;
  isPicOutgoing: boolean;
  isPicIncoming: boolean;
  coversCii: boolean;
  coversCiiiV: boolean;
  coversDrugsOfConcern: boolean;
  notes: string | null;
};

export function InventoryForm({ action, people, inv, participantIds, submitLabel }: { action: (fd: FormData) => Promise<void>; people: Person[]; inv?: Inv; participantIds?: string[]; submitLabel: string }) {
  const sel = new Set(participantIds ?? []);
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-3">
      <Field label="Date of inventory" hint="No later than 375 days after the previous inventory (K.A.R. 68-20-16)."><input name="inventoryDate" type="date" className="field" required defaultValue={inv?.inventoryDate ?? todayIso()} /></Field>
      <Field label="Taken at">
        <select name="takenAt" className="field" defaultValue={inv?.takenAt ?? "close"}>
          <option value="opening">Opening of business</option>
          <option value="close">Close of business</option>
          <option value="24h">Open 24 hours (record times)</option>
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Time started"><input name="timeStarted" className="field" placeholder="e.g. 9:00 PM" defaultValue={inv?.timeStarted ?? ""} /></Field>
        <Field label="Time ended"><input name="timeEnded" className="field" defaultValue={inv?.timeEnded ?? ""} /></Field>
      </div>
      <div className="sm:col-span-3">
        <div className="label">Inventory type (check all that apply)</div>
        <div className="grid gap-1 text-sm sm:grid-cols-2">
          <label className="flex items-center gap-2"><input type="checkbox" name="isKsAnnual" defaultChecked={inv ? inv.isKsAnnual : true} /> Kansas annual</label>
          <label className="flex items-center gap-2"><input type="checkbox" name="isDeaBiennial" defaultChecked={inv?.isDeaBiennial} /> DEA biennial (a properly documented annual count satisfies this)</label>
          <label className="flex items-center gap-2"><input type="checkbox" name="isPicOutgoing" defaultChecked={inv?.isPicOutgoing} /> PIC change — outgoing (≤ 2 days before or on last day)</label>
          <label className="flex items-center gap-2"><input type="checkbox" name="isPicIncoming" defaultChecked={inv?.isPicIncoming} /> PIC change — incoming (≤ 2 days after starting)</label>
        </div>
      </div>
      <div className="sm:col-span-3">
        <div className="label">Covers</div>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" name="coversCii" defaultChecked={inv ? inv.coversCii : true} /> Schedule II (exact count, kept separately)</label>
          <label className="flex items-center gap-2"><input type="checkbox" name="coversCiiiV" defaultChecked={inv ? inv.coversCiiiV : true} /> Schedule III–V</label>
          <label className="flex items-center gap-2"><input type="checkbox" name="coversDrugsOfConcern" defaultChecked={inv ? inv.coversDrugsOfConcern : true} /> Drugs of concern (K.A.R. 68-21-7)</label>
        </div>
      </div>
      <div className="sm:col-span-3">
        <div className="label">Individuals participating</div>
        <p className="hint mb-1">Each participant's name, license number, and signature go on the cover sheet.</p>
        <div className="grid gap-1 text-sm sm:grid-cols-3">
          {people.filter((p) => p.active || sel.has(p.id)).map((p) => (
            <label key={p.id} className="flex items-center gap-2"><input type="checkbox" name="participantIds" value={p.id} defaultChecked={sel.has(p.id)} /> {p.firstName} {p.lastName}</label>
          ))}
        </div>
      </div>
      <Field label="Notes" className="sm:col-span-3"><textarea name="notes" className="field" rows={2} defaultValue={inv?.notes ?? ""} placeholder="Include will-call bins, expired controlled drugs, C-V OTC, LTC e-kits…" /></Field>
      <div className="sm:col-span-3"><button className="btn btn-primary">{submitLabel}</button></div>
    </form>
  );
}
