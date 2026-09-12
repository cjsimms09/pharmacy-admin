"use client";

import { useState } from "react";

/**
 * The document, on screen beside the form.
 *
 * The whole job of this screen is copying dates and numbers off a scan, and doing that with the
 * file open in another tab means alt-tabbing between the thing you are reading and the box you
 * are typing into. So it sits here, and the controls are the ones a scan actually needs: zoom,
 * because expiry dates are printed small on a CPR card, and rotate, because half of everything
 * that comes off a flatbed or a phone arrives sideways.
 *
 * Rendering is the browser's own — an <img> for a photo, an <iframe> for a PDF. Nothing is
 * fetched or decoded here, so a 40-page PDF and a phone photo both open at the same speed and
 * neither depends on a viewer library that could fail to load.
 */
export function DocumentViewer({ src, mimeType, fileName }: { src: string; mimeType: string; fileName: string }) {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const isImage = mimeType.startsWith("image/");
  const isPdf = mimeType === "application/pdf";

  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
        {isImage && (
          <>
            <Btn onClick={() => setZoom((z) => Math.min(6, z * 1.35))} label="Zoom in">+</Btn>
            <Btn onClick={() => setZoom((z) => Math.max(0.25, z / 1.35))} label="Zoom out">−</Btn>
            <Btn onClick={() => { setZoom(1); setRotation(0); }} label="Reset">Fit</Btn>
            <span className="mx-1 w-10 text-center text-xs tabular-nums text-ink-3">{Math.round(zoom * 100)}%</span>
            <Btn onClick={() => setRotation((r) => (r + 90) % 360)} label="Rotate">Rotate</Btn>
          </>
        )}
        <a href={src} target="_blank" rel="noreferrer" className="ml-auto px-2 py-1 text-xs underline hover:text-ink">
          Open full size
        </a>
      </div>

      <div className={`overflow-auto bg-ground ${isImage ? "max-h-[75vh] p-3" : ""}`}>
        {isImage ? (
          <img
            src={src}
            alt={fileName}
            style={{ transform: `scale(${zoom}) rotate(${rotation}deg)`, transformOrigin: "top left" }}
            className="max-w-full transition-transform"
          />
        ) : isPdf ? (
          <iframe src={src} title={fileName} className="h-[75vh] w-full border-0 bg-white" />
        ) : (
          <div className="p-6 text-sm text-ink-3">
            This file type cannot be shown here.{" "}
            <a href={src} target="_blank" rel="noreferrer" className="underline">Open it</a> to read it, then type what
            it says into the form.
          </div>
        )}
      </div>
    </div>
  );
}

function Btn({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="rounded border border-line px-2 py-1 text-xs hover:bg-ground"
    >
      {children}
    </button>
  );
}
