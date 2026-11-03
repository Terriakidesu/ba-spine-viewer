import type { EditorTimeline } from "./editorModel";

function partTextKey(part: Record<string, unknown>): string {
  const source = part.subtitle ?? part.text;
  const subtitle = source && typeof source === "object" ? source as Record<string, unknown> : {};
  return `${String(subtitle.en ?? "")}\u0000${String(subtitle.ja ?? "")}\u0000${String(subtitle.ko ?? "")}`;
}

function deduplicateParts(parts: Record<string, unknown>[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const part of parts) {
    const start = typeof part.start === "number" && Number.isFinite(part.start) ? part.start : null;
    const previousIndex = start === null ? -1 : result.findIndex((previous) => {
      const previousStart = previous.start;
      return typeof previousStart === "number" && Math.abs(previousStart - start) < 0.0001 && partTextKey(previous) === partTextKey(part);
    });
    if (previousIndex < 0) result.push(part);
    else {
      const previousEnd = result[previousIndex]!.end;
      const currentEnd = part.end;
      if (typeof currentEnd === "number" && (typeof previousEnd !== "number" || currentEnd > previousEnd)) result[previousIndex] = part;
    }
  }
  return result;
}

function cueTextKey(cue: EditorTimeline["subtitles"][number]): string {
  return `${cue.text.en}\u0000${cue.text.ja}\u0000${cue.text.ko}`;
}

function deduplicateCues(cues: EditorTimeline["subtitles"]): EditorTimeline["subtitles"] {
  const result: EditorTimeline["subtitles"] = [];
  for (const cue of cues) {
    const previousIndex = result.findIndex((previous) => Math.abs(previous.start - cue.start) < 0.0001 && cueTextKey(previous) === cueTextKey(cue));
    if (previousIndex < 0) result.push(cue);
    else if (cue.end > result[previousIndex]!.end) result[previousIndex] = cue;
  }
  return result;
}

/** Apply all timeline cues for one character back onto an imported subtitle document. */
export function applyTimelinesToSubtitleDocument(
  document: Record<string, unknown>,
  directory: string,
  timelines: readonly EditorTimeline[],
): Record<string, unknown> {
  const next = structuredClone(document) as Record<string, unknown>;
  const character = Array.isArray(next.characters)
    ? next.characters.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).directory === directory) as Record<string, unknown> | undefined
    : next;
  const lines = character && Array.isArray(character.lines) ? character.lines as Record<string, unknown>[] : [];
  for (const line of lines) {
    const lineId = String(line.id ?? "");
    const cues = deduplicateCues(timelines.flatMap((item) => item.subtitles.filter((cue) => cue.lineId === lineId)).sort((a, b) => a.start - b.start));
    const originalParts = Array.isArray(line.parts)
      ? line.parts.filter((part): part is Record<string, unknown> => Boolean(part && typeof part === "object"))
      : [];
    const parts = deduplicateParts(originalParts);
    if (!cues.length) {
      if (parts.length !== originalParts.length) line.parts = parts;
      continue;
    }
    if (parts.length) {
      for (const [index, cue] of cues.entries()) {
        const part = parts[index];
        if (!part) continue;
        part.subtitle = { ...cue.text };
        part.start = cue.start;
        part.end = cue.end;
      }
      line.parts = parts;
    } else {
      line.subtitle = { ...cues[0]!.text };
    }
    line.markers = cues.map((cue) => cue.start);
  }
  return next;
}

export function serializeSubtitleDocument(
  document: Record<string, unknown>,
  directory: string,
  timelines: readonly EditorTimeline[],
): string {
  return `${JSON.stringify(applyTimelinesToSubtitleDocument(document, directory, timelines), null, 2)}\n`;
}
