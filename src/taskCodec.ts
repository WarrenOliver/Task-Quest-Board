import type { Task, TaskStep } from "./types";
import { percentFromSteps } from "./types";

export function parseTask(x: unknown): Task | null {
  if (typeof x !== "object" || x === null) return null;
  const o = x as Record<string, unknown>;
  if (
    typeof o.id !== "string" ||
    typeof o.title !== "string" ||
    typeof o.imageDataUrl !== "string" ||
    typeof o.percent !== "number" ||
    o.percent < 0 ||
    o.percent > 100
  ) {
    return null;
  }
  const nextSteps = parseSteps(o.nextSteps);
  const percent =
    nextSteps.length > 0 ? percentFromSteps(nextSteps) : Math.round(o.percent);
  return {
    id: o.id,
    title: o.title,
    imageDataUrl: o.imageDataUrl,
    percent,
    nextSteps,
  };
}

export function parseSteps(x: unknown): TaskStep[] {
  if (!Array.isArray(x)) return [];
  const out: TaskStep[] = [];
  for (const item of x) {
    if (typeof item !== "object" || item === null) continue;
    const s = item as Record<string, unknown>;
    if (typeof s.id !== "string" || typeof s.label !== "string" || typeof s.done !== "boolean") continue;
    out.push({ id: s.id, label: s.label, done: s.done });
  }
  return out;
}
