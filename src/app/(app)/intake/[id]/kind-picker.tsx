"use client";

import { useState } from "react";

/**
 * Choosing where a document belongs changes which fields matter, so the extra fields follow the
 * choice rather than all being on screen at once.
 */
export function KindPicker({
  initialKind,
  labels,
  person,
  credential,
  training,
  ce,
}: {
  initialKind: string;
  labels: Record<string, string>;
  person: React.ReactNode;
  credential: React.ReactNode;
  training: React.ReactNode;
  ce: React.ReactNode;
}) {
  const [kind, setKind] = useState(initialKind);
  const needsPerson = kind === "person_credential" || kind === "person_training" || kind === "person_ce";

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block sm:col-span-2">
        <span className="label">This document is…</span>
        <select name="kind" className="field" value={kind} onChange={(e) => setKind(e.target.value)}>
          {Object.entries(labels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      {needsPerson && <div className="sm:col-span-2">{person}</div>}
      {(kind === "person_credential" || kind === "pharmacy_credential") && <div className="grid gap-3 sm:col-span-2">{credential}</div>}
      {kind === "person_training" && <div className="grid gap-3 sm:col-span-2 sm:grid-cols-3">{training}</div>}
      {kind === "person_ce" && <div className="grid gap-3 sm:col-span-2 sm:grid-cols-2">{ce}</div>}
    </div>
  );
}
