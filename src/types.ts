export type TaskStep = {
  id: string;
  label: string;
  done: boolean;
};

export type Task = {
  id: string;
  title: string;
  /** data URL (resized JPEG) */
  imageDataUrl: string;
  percent: number;
  nextSteps: TaskStep[];
};

export function percentFromSteps(steps: TaskStep[]): number {
  if (steps.length === 0) return 0;
  const done = steps.filter((s) => s.done).length;
  return Math.floor((done / steps.length) * 100);
}
