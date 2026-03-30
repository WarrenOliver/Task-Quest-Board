import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import confetti from "canvas-confetti";
import type { Task } from "./types";
import { percentFromSteps } from "./types";
import { loadTasks, saveTasks } from "./db";
import { fileToResizedDataUrl } from "./imageUtils";

function playQuestCompleteConfetti(): void {
  const colors = ["#7cfc00", "#ffd700", "#ff69b4", "#6eb5ff", "#ffffff"];
  confetti({
    particleCount: 130,
    spread: 88,
    startVelocity: 38,
    origin: { x: 0.5, y: 0.45 },
    gravity: 0.95,
    ticks: 320,
    colors,
    scalar: 1.05,
  });
  window.setTimeout(() => {
    confetti({ particleCount: 45, angle: 55, spread: 48, origin: { x: 0, y: 0.68 }, colors });
    confetti({ particleCount: 45, angle: 125, spread: 48, origin: { x: 1, y: 0.68 }, colors });
  }, 200);
  window.setTimeout(() => {
    confetti({ particleCount: 70, spread: 360, startVelocity: 25, origin: { x: 0.5, y: 0.35 }, ticks: 200, colors });
  }, 450);
}

function uid(): string {
  return crypto.randomUUID();
}

const DRAG_THRESHOLD_PX = 8;
const REORDER_HIT_MARGIN = 10;

type QuestSection = "active" | "done";

function partitionTasksByCompletion(tasks: Task[]): { active: Task[]; done: Task[] } {
  const active: Task[] = [];
  const done: Task[] = [];
  for (const t of tasks) {
    if (t.percent === 100) done.push(t);
    else active.push(t);
  }
  return { active, done };
}

function reorderTaskInSection(
  tasks: Task[],
  taskId: string,
  insertIndexInSection: number,
  section: QuestSection
): Task[] {
  const { active, done } = partitionTasksByCompletion(tasks);
  const list = section === "active" ? active : done;
  const other = section === "active" ? done : active;
  const dragged = list.find((t) => t.id === taskId);
  if (!dragged) return tasks;
  const without = list.filter((t) => t.id !== taskId);
  const clamped = Math.max(0, Math.min(insertIndexInSection, without.length));
  const newList = [...without.slice(0, clamped), dragged, ...without.slice(clamped)];
  return section === "active" ? [...newList, ...other] : [...other, ...newList];
}

function computeReorderInsertIndex(
  gridEl: HTMLUListElement | null,
  clientX: number,
  clientY: number,
  draggingId: string,
  sectionTasks: Task[],
  fallbackIndex: number
): number {
  const without = sectionTasks.filter((t) => t.id !== draggingId);
  const max = without.length;
  if (!gridEl) return Math.max(0, Math.min(fallbackIndex, max));

  const lis = [...gridEl.querySelectorAll<HTMLElement>(":scope > li[data-reorder-slot]")];
  if (lis.length === 0) return Math.max(0, Math.min(fallbackIndex, max));

  const margin = REORDER_HIT_MARGIN;

  for (const el of lis) {
    const r = el.getBoundingClientRect();
    const inside =
      clientX >= r.left - margin &&
      clientX <= r.right + margin &&
      clientY >= r.top - margin &&
      clientY <= r.bottom + margin;
    if (!inside) continue;

    if (el.dataset.reorderSlot === "placeholder") {
      const ix = Number(el.dataset.insertIndex);
      return Number.isFinite(ix) ? Math.max(0, Math.min(ix, max)) : fallbackIndex;
    }

    const wi = el.dataset.withoutIndex;
    if (wi !== undefined) {
      const idx = Number(wi);
      if (!Number.isFinite(idx)) continue;
      const mid = r.left + r.width / 2;
      return clientX < mid ? Math.max(0, Math.min(idx, max)) : Math.max(0, Math.min(idx + 1, max));
    }
  }

  let best = fallbackIndex;
  let bestD = Infinity;
  for (const el of lis) {
    const r = el.getBoundingClientRect();
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    const d = (clientX - cx) ** 2 + (clientY - cy) ** 2;
    if (d >= bestD) continue;
    bestD = d;
    if (el.dataset.reorderSlot === "placeholder") {
      const ix = Number(el.dataset.insertIndex);
      best = Number.isFinite(ix) ? Math.max(0, Math.min(ix, max)) : fallbackIndex;
    } else {
      const wi = el.dataset.withoutIndex;
      const idx = Number(wi);
      if (!Number.isFinite(idx)) continue;
      const mid = r.left + r.width / 2;
      best = clientX < mid ? Math.max(0, Math.min(idx, max)) : Math.max(0, Math.min(idx + 1, max));
    }
  }
  return best;
}

/** Stops browsers from starting a native drag on quest icons (data URLs / images). */
const ICON_DRAG_LOCK: CSSProperties = {
  userSelect: "none",
  ...( { WebkitUserDrag: "none", KhtmlUserDrag: "none" } as CSSProperties ),
};

const defaultIcon =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
      <rect fill="#2a3358" width="128" height="128" rx="12"/>
      <text x="64" y="72" text-anchor="middle" fill="#7cfc00" font-size="48" font-family="monospace">?</text>
    </svg>`
  );

export function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [persistError, setPersistError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [completedQuestTitle, setCompletedQuestTitle] = useState<string | null>(null);
  const prevPercentsRef = useRef<Map<string, number> | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadTasks()
      .then((loaded) => {
        if (!cancelled) {
          setTasks(loaded);
          setHydrated(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError("Could not open your local SQLite database. Check that storage is allowed for this site.");
          setHydrated(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    setPersistError(null);
    saveTasks(tasks).catch(() => {
      setPersistError("Could not save to local database. Your browser may be full or blocking storage.");
    });
  }, [tasks, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    const nextMap = new Map(tasks.map((t) => [t.id, t.percent]));
    const prev = prevPercentsRef.current;
    if (prev === null) {
      prevPercentsRef.current = nextMap;
      return;
    }
    for (const task of tasks) {
      const was = prev.get(task.id);
      if (was !== undefined && was < 100 && task.percent === 100) {
        playQuestCompleteConfetti();
        setCompletedQuestTitle(task.title);
        break;
      }
    }
    prevPercentsRef.current = nextMap;
  }, [tasks, hydrated]);

  const selected = useMemo(
    () => tasks.find((t) => t.id === selectedId) ?? null,
    [tasks, selectedId]
  );

  const addTask = useCallback((title: string, imageDataUrl: string) => {
    const trimmed = title.trim() || "Untitled quest";
    setTasks((prev) => [
      ...prev,
      { id: uid(), title: trimmed, imageDataUrl, percent: 0, nextSteps: [] },
    ]);
    setCreating(false);
  }, []);

  const updateTask = useCallback((id: string, updater: (t: Task) => Task) => {
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        const next = updater({ ...t, nextSteps: t.nextSteps ?? [] });
        const steps = next.nextSteps ?? [];
        if (steps.length > 0) {
          return { ...next, percent: percentFromSteps(steps) };
        }
        return { ...next, percent: Math.round(Math.min(100, Math.max(0, next.percent))) };
      })
    );
  }, []);

  const updatePercent = useCallback((id: string, percent: number) => {
    const p = Math.round(Math.min(100, Math.max(0, percent)));
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        if ((t.nextSteps ?? []).length > 0) return t;
        return { ...t, percent: p };
      })
    );
  }, []);

  const removeTask = useCallback((id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
  }, []);

  const tasksRef = useRef<Task[]>([]);
  tasksRef.current = tasks;

  const gridRef = useRef<HTMLUListElement>(null);
  const completedGridRef = useRef<HTMLUListElement>(null);
  const reorderGhostRef = useRef<HTMLDivElement>(null);
  const suppressOpenAfterDragRef = useRef(false);
  const pendingReorderRef = useRef<{
    taskId: string;
    section: QuestSection;
    x: number;
    y: number;
    pointerId: number;
    listItemEl: HTMLElement;
  } | null>(null);
  const dragActiveRef = useRef<{
    taskId: string;
    section: QuestSection;
    pointerId: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const insertIndexRef = useRef(0);

  const [reorderDraggingId, setReorderDraggingId] = useState<string | null>(null);
  const [reorderInsertIndex, setReorderInsertIndex] = useState(0);
  const [reorderSection, setReorderSection] = useState<QuestSection | null>(null);

  const { active: activeQuests, done: completedQuests } = useMemo(
    () => partitionTasksByCompletion(tasks),
    [tasks]
  );

  const handleQuestPointerDown = useCallback((task: Task, section: QuestSection, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !e.isPrimary) return;
    const article = e.currentTarget;
    const li = article.closest("li");
    if (!li) return;

    pendingReorderRef.current = {
      taskId: task.id,
      section,
      x: e.clientX,
      y: e.clientY,
      pointerId: e.pointerId,
      listItemEl: li,
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      document.body.style.cursor = "";
    };

    const onMove = (ev: PointerEvent) => {
      const pending = pendingReorderRef.current;
      const active = dragActiveRef.current;

      if (active && ev.pointerId === active.pointerId) {
        ev.preventDefault();
        const g = reorderGhostRef.current;
        if (g) {
          g.style.transform = `translate(${ev.clientX - active.offsetX}px, ${ev.clientY - active.offsetY}px)`;
        }
        const { active: a, done: d } = partitionTasksByCompletion(tasksRef.current);
        const sectionTasks = active.section === "active" ? a : d;
        const gridEl = active.section === "active" ? gridRef.current : completedGridRef.current;
        const next = computeReorderInsertIndex(
          gridEl,
          ev.clientX,
          ev.clientY,
          active.taskId,
          sectionTasks,
          insertIndexRef.current
        );
        if (next !== insertIndexRef.current) {
          insertIndexRef.current = next;
          setReorderInsertIndex(next);
        }
        return;
      }

      if (!pending || ev.pointerId !== pending.pointerId) return;
      const dx = ev.clientX - pending.x;
      const dy = ev.clientY - pending.y;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;

      const rect = pending.listItemEl.getBoundingClientRect();
      const taskId = pending.taskId;
      const sec = pending.section;
      const { active: a0, done: d0 } = partitionTasksByCompletion(tasksRef.current);
      const sectionTasks0 = sec === "active" ? a0 : d0;
      const startIdx = sectionTasks0.findIndex((t) => t.id === taskId);
      dragActiveRef.current = {
        taskId,
        section: sec,
        pointerId: pending.pointerId,
        offsetX: ev.clientX - rect.left,
        offsetY: ev.clientY - rect.top,
      };
      pendingReorderRef.current = null;
      insertIndexRef.current = startIdx;

      flushSync(() => {
        setReorderDraggingId(taskId);
        setReorderInsertIndex(startIdx);
        setReorderSection(sec);
      });

      document.body.style.cursor = "grabbing";

      const g = reorderGhostRef.current;
      if (g) {
        g.style.width = `${rect.width}px`;
        g.style.height = `${rect.height}px`;
        g.style.transform = `translate(${ev.clientX - dragActiveRef.current.offsetX}px, ${ev.clientY - dragActiveRef.current.offsetY}px)`;
      }

      const gridEl0 = sec === "active" ? gridRef.current : completedGridRef.current;
      const next = computeReorderInsertIndex(
        gridEl0,
        ev.clientX,
        ev.clientY,
        taskId,
        sectionTasks0,
        insertIndexRef.current
      );
      if (next !== insertIndexRef.current) {
        insertIndexRef.current = next;
        setReorderInsertIndex(next);
      }
    };

    const onUp = (ev: PointerEvent) => {
      const pending = pendingReorderRef.current;
      const active = dragActiveRef.current;
      const pid = pending?.pointerId ?? active?.pointerId;
      if (pid === undefined || ev.pointerId !== pid) return;

      if (active) {
        setTasks((prev) =>
          reorderTaskInSection(prev, active.taskId, insertIndexRef.current, active.section)
        );
        suppressOpenAfterDragRef.current = true;
        dragActiveRef.current = null;
        setReorderDraggingId(null);
        setReorderSection(null);
      }
      pendingReorderRef.current = null;
      cleanup();
    };

    window.addEventListener("pointermove", onMove, { capture: true, passive: false });
    window.addEventListener("pointerup", onUp, { capture: true });
    window.addEventListener("pointercancel", onUp, { capture: true });
  }, []);

  const draggedTask = useMemo(
    () => (reorderDraggingId ? tasks.find((t) => t.id === reorderDraggingId) ?? null : null),
    [tasks, reorderDraggingId]
  );

  function renderQuestSection(
    section: QuestSection,
    sectionTasks: Task[],
    listRef: RefObject<HTMLUListElement | null>,
    ariaLabel: string
  ) {
    const draggingHere = reorderDraggingId !== null && reorderSection === section;
    return (
      <ul ref={listRef} style={styles.grid} aria-label={ariaLabel}>
        {draggingHere
          ? (() => {
              const without = sectionTasks.filter((t) => t.id !== reorderDraggingId);
              const before = without.slice(0, reorderInsertIndex);
              const after = without.slice(reorderInsertIndex);
              return (
                <>
                  {before.map((t, i) => (
                    <li
                      key={t.id}
                      style={styles.gridItem}
                      data-reorder-slot="task"
                      data-without-index={i}
                    >
                      <TaskSlot
                        task={t}
                        onOpen={() => setSelectedId(t.id)}
                        onDelete={() => removeTask(t.id)}
                        onCardPointerDown={(ev) => handleQuestPointerDown(t, section, ev)}
                        suppressOpenAfterDragRef={suppressOpenAfterDragRef}
                      />
                    </li>
                  ))}
                  <li
                    key="reorder-placeholder"
                    style={{ ...styles.gridItem, ...styles.gridPlaceholderCell }}
                    data-reorder-slot="placeholder"
                    data-insert-index={reorderInsertIndex}
                    aria-hidden
                  >
                    {without.length === 0 && draggedTask && (
                      <div style={styles.gridPlaceholderSizeShim} aria-hidden>
                        <TaskSlot
                          task={draggedTask}
                          onOpen={() => {}}
                          onDelete={() => {}}
                          interactive={false}
                        />
                      </div>
                    )}
                    <div style={styles.gridPlaceholderOutline} />
                  </li>
                  {after.map((t, j) => (
                    <li
                      key={t.id}
                      style={styles.gridItem}
                      data-reorder-slot="task"
                      data-without-index={reorderInsertIndex + j}
                    >
                      <TaskSlot
                        task={t}
                        onOpen={() => setSelectedId(t.id)}
                        onDelete={() => removeTask(t.id)}
                        onCardPointerDown={(ev) => handleQuestPointerDown(t, section, ev)}
                        suppressOpenAfterDragRef={suppressOpenAfterDragRef}
                      />
                    </li>
                  ))}
                </>
              );
            })()
          : sectionTasks.map((task) => (
              <li key={task.id} style={styles.gridItem}>
                <TaskSlot
                  task={task}
                  onOpen={() => setSelectedId(task.id)}
                  onDelete={() => removeTask(task.id)}
                  onCardPointerDown={(ev) => handleQuestPointerDown(task, section, ev)}
                  suppressOpenAfterDragRef={suppressOpenAfterDragRef}
                />
              </li>
            ))}
      </ul>
    );
  }

  return (
    <div style={styles.shell}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>Quest board</h1>
          <p style={styles.subtitle}>
            Track tasks like inventory slots — upload an icon, set progress. Data stays on this device in a
            local SQLite file (via your browser).
          </p>
        </div>
        <button type="button" style={styles.primaryBtn} onClick={() => setCreating(true)} disabled={!hydrated}>
          + New quest
        </button>
      </header>

      {!hydrated && (
        <div style={styles.loading}>
          <p style={styles.loadingText}>Loading quest data…</p>
        </div>
      )}

      {loadError && (
        <div style={styles.persistBanner} role="alert">
          {loadError}
        </div>
      )}

      {persistError && (
        <div style={styles.persistBanner} role="alert">
          {persistError}
        </div>
      )}

      {hydrated && tasks.length === 0 ? (
        <div style={styles.empty}>
          <p>No quests yet. Create one and drop in your own “item icon”.</p>
          <button type="button" style={styles.primaryBtn} onClick={() => setCreating(true)}>
            Create first quest
          </button>
        </div>
      ) : hydrated ? (
        <div style={styles.gridWrap}>
          {renderQuestSection("active", activeQuests, gridRef, "Active quests")}
          {completedQuests.length > 0 && (
            <section style={styles.completedSection} aria-label="Completed quests">
              <h2 style={styles.completedHeading}>Completed</h2>
              {renderQuestSection("done", completedQuests, completedGridRef, "Completed quest cards")}
            </section>
          )}
          {draggedTask && (
            <div ref={reorderGhostRef} style={styles.reorderGhost}>
              <TaskSlot task={draggedTask} onOpen={() => {}} onDelete={() => {}} interactive={false} />
            </div>
          )}
        </div>
      ) : null}

      {creating && (
        <CreateQuestModal
          onClose={() => setCreating(false)}
          onCreate={addTask}
        />
      )}

      {selected && (
        <EditQuestModal
          task={selected}
          onClose={() => setSelectedId(null)}
          onPercentChange={(p) => updatePercent(selected.id, p)}
          onUpdateTask={(updater) => updateTask(selected.id, updater)}
          onDelete={() => removeTask(selected.id)}
        />
      )}

      {completedQuestTitle !== null && (
        <CompletionModal
          taskTitle={completedQuestTitle}
          onClose={() => setCompletedQuestTitle(null)}
        />
      )}
    </div>
  );
}

function CompletionModal({ taskTitle, onClose }: { taskTitle: string; onClose: () => void }) {
  const titleId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      style={styles.celebrationOverlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onClose}
    >
      <div style={styles.celebrationModal} onClick={(e) => e.stopPropagation()}>
        <p id={titleId} style={styles.celebrationKicker}>
          You did it!
        </p>
        <p style={styles.celebrationBody}>
          You completed <strong style={styles.celebrationName}>{taskTitle}</strong>
        </p>
        <button type="button" style={styles.primaryBtn} onClick={onClose}>
          Awesome
        </button>
      </div>
    </div>
  );
}

function TaskSlot({
  task,
  onOpen,
  onDelete,
  interactive = true,
  onCardPointerDown,
  suppressOpenAfterDragRef,
}: {
  task: Task;
  onOpen: () => void;
  onDelete: () => void;
  interactive?: boolean;
  onCardPointerDown?: (e: ReactPointerEvent<HTMLElement>) => void;
  suppressOpenAfterDragRef?: MutableRefObject<boolean>;
}) {
  const complete = task.percent === 100;
  const canReorder = interactive && !!onCardPointerDown;

  function handleMainClick() {
    if (!interactive) return;
    if (suppressOpenAfterDragRef?.current) {
      suppressOpenAfterDragRef.current = false;
      return;
    }
    onOpen();
  }

  const mainContent = (
    <>
      <div style={{ ...styles.iconFrame, ...(complete ? styles.iconFrameComplete : {}) }}>
        <img
          src={task.imageDataUrl}
          alt=""
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          style={{ ...styles.iconImg, ...ICON_DRAG_LOCK }}
          width={96}
          height={96}
        />
        <svg style={styles.progressRing} viewBox="0 0 100 100" aria-hidden>
          <circle cx="50" cy="50" r="44" fill="none" stroke="rgba(0,0,0,0.5)" strokeWidth="8" />
          <circle
            cx="50"
            cy="50"
            r="44"
            fill="none"
            stroke={complete ? "rgba(124, 200, 88, 0.45)" : "var(--accent)"}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${(task.percent / 100) * 276.46} 276.46`}
            transform="rotate(-90 50 50)"
          />
        </svg>
        <span style={{ ...styles.percentBadge, ...(complete ? styles.percentBadgeComplete : {}) }}>
          {task.percent}%
        </span>
      </div>
      <h2 style={{ ...styles.slotTitle, ...(complete ? styles.slotTitleComplete : {}) }}>{task.title}</h2>
    </>
  );

  return (
    <article
      style={{
        ...styles.slot,
        ...(complete ? styles.slotComplete : {}),
        ...(canReorder ? styles.slotReorderable : {}),
      }}
      onPointerDown={canReorder ? onCardPointerDown : undefined}
      onDragStart={canReorder ? (e) => e.preventDefault() : undefined}
    >
      {complete && (
        <span style={styles.completedCheckBadge} role="img" aria-label="Completed">
          ✓
        </span>
      )}
      {interactive ? (
        <button
          type="button"
          style={styles.slotMain}
          onClick={handleMainClick}
          onDragStart={(e) => e.preventDefault()}
          aria-label={`Open ${task.title}`}
        >
          {mainContent}
        </button>
      ) : (
        <div style={styles.slotMain} aria-hidden>
          {mainContent}
        </div>
      )}
      {interactive && (
        <button
          type="button"
          style={styles.trashBtn}
          onClick={onDelete}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={`Delete ${task.title}`}
        >
          ✕
        </button>
      )}
    </article>
  );
}

function CreateQuestModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (title: string, imageDataUrl: string) => void;
}) {
  const titleId = useId();
  const fileId = useId();
  const [title, setTitle] = useState("");
  const [preview, setPreview] = useState<string>(defaultIcon);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setErr(null);
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setErr("Pick an image file.");
      return;
    }
    setPendingFile(file);
    setBusy(true);
    try {
      const dataUrl = await fileToResizedDataUrl(file);
      setPreview(dataUrl);
    } catch {
      setErr("Could not load that image.");
      setPendingFile(null);
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    let image = preview;
    if (pendingFile) {
      setBusy(true);
      try {
        image = await fileToResizedDataUrl(pendingFile);
      } catch {
        setErr("Could not process image.");
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    onCreate(title, image);
  }

  return (
    <div
      style={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={onClose}
    >
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h2 id={titleId} style={styles.modalTitle}>
          New quest
        </h2>
        <form onSubmit={submit}>
          <label style={styles.label} htmlFor={fileId}>
            Quest icon (image)
          </label>
          <input id={fileId} type="file" accept="image/*" onChange={onFileChange} style={styles.fileInput} />
          <div style={styles.previewWrap}>
            <img
              src={preview}
              alt="Preview"
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
              style={{ ...styles.previewImg, ...ICON_DRAG_LOCK }}
              width={128}
              height={128}
            />
          </div>
          <label style={styles.label} htmlFor="quest-title-input">
            Quest name
          </label>
          <input
            id="quest-title-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Ship the demo"
            style={styles.textInput}
            maxLength={80}
            autoFocus
          />
          {err && <p style={styles.error}>{err}</p>}
          <div style={styles.modalActions}>
            <button type="button" style={styles.ghostBtn} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" style={styles.primaryBtn} disabled={busy}>
              {busy ? "Working…" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EditQuestModal({
  task,
  onClose,
  onPercentChange,
  onUpdateTask,
  onDelete,
}: {
  task: Task;
  onClose: () => void;
  onPercentChange: (p: number) => void;
  onUpdateTask: (updater: (t: Task) => Task) => void;
  onDelete: () => void;
}) {
  const sliderId = useId();
  const stepInputId = useId();
  const [newStepLabel, setNewStepLabel] = useState("");

  const steps = task.nextSteps ?? [];
  const stepDriven = steps.length > 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function addStep(e: FormEvent) {
    e.preventDefault();
    const label = newStepLabel.trim();
    if (!label) return;
    onUpdateTask((t) => ({
      ...t,
      nextSteps: [...(t.nextSteps ?? []), { id: uid(), label, done: false }],
    }));
    setNewStepLabel("");
  }

  function toggleStep(stepId: string) {
    onUpdateTask((t) => ({
      ...t,
      nextSteps: (t.nextSteps ?? []).map((s) =>
        s.id === stepId ? { ...s, done: !s.done } : s
      ),
    }));
  }

  function removeStep(stepId: string) {
    onUpdateTask((t) => ({
      ...t,
      nextSteps: (t.nextSteps ?? []).filter((s) => s.id !== stepId),
    }));
  }

  return (
    <div style={styles.overlay} role="dialog" aria-modal="true" onClick={onClose}>
      <div style={{ ...styles.modal, maxWidth: "min(480px, 100%)" }} onClick={(e) => e.stopPropagation()}>
        <div style={styles.editHeader}>
          <div style={styles.iconFrameSmall}>
            <img
              src={task.imageDataUrl}
              alt=""
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
              style={{ ...styles.iconImgSmall, ...ICON_DRAG_LOCK }}
              width={72}
              height={72}
            />
          </div>
          <div>
            <h2 style={{ ...styles.modalTitle, marginBottom: "0.35rem" }}>{task.title}</h2>
            <p style={styles.subtitle}>
              {stepDriven
                ? "Check off next steps — progress matches how many are done."
                : "Add next steps below, or drag the bar for manual progress."}
            </p>
          </div>
        </div>

        <h3 style={styles.sectionHeading}>Next steps</h3>
        {steps.length === 0 ? (
          <p style={styles.stepsHint}>No steps yet. Add one to tie progress to your checklist.</p>
        ) : (
          <ul style={styles.stepList}>
            {steps.map((s) => (
              <li key={s.id} style={styles.stepRow}>
                <button
                  type="button"
                  style={{
                    ...styles.stepCheck,
                    ...(s.done ? styles.stepCheckOn : {}),
                  }}
                  onClick={() => toggleStep(s.id)}
                  aria-pressed={s.done}
                  aria-label={s.done ? `Mark incomplete: ${s.label}` : `Complete: ${s.label}`}
                >
                  {s.done ? "✓" : ""}
                </button>
                <span
                  style={{
                    ...styles.stepLabel,
                    ...(s.done ? styles.stepLabelDone : {}),
                  }}
                >
                  {s.label}
                </span>
                <button
                  type="button"
                  style={styles.stepRemove}
                  onClick={() => removeStep(s.id)}
                  aria-label={`Remove step: ${s.label}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={addStep} style={styles.addStepForm}>
          <label style={styles.srOnly} htmlFor={stepInputId}>
            New step
          </label>
          <input
            id={stepInputId}
            value={newStepLabel}
            onChange={(e) => setNewStepLabel(e.target.value)}
            placeholder="Describe a next step…"
            style={styles.stepInput}
            maxLength={120}
          />
          <button type="submit" style={styles.addStepBtn} disabled={!newStepLabel.trim()}>
            Add
          </button>
        </form>

        <label style={{ ...styles.label, marginTop: "1.25rem" }} htmlFor={sliderId}>
          Progress: <strong style={{ color: "var(--gold)" }}>{task.percent}%</strong>
          {stepDriven && (
            <span style={{ color: "var(--text-muted)", fontWeight: "normal" }}> (from steps)</span>
          )}
        </label>
        <input
          id={sliderId}
          type="range"
          min={0}
          max={100}
          value={task.percent}
          onChange={(e) => onPercentChange(Number(e.target.value))}
          style={styles.slider}
          disabled={stepDriven}
        />
        <div style={{ ...styles.barTrack, opacity: stepDriven ? 0.65 : 1 }}>
          <div style={{ ...styles.barFill, width: `${task.percent}%` }} />
        </div>
        {stepDriven && (
          <p style={styles.sliderHint}>Remove all steps to set progress manually again.</p>
        )}

        <div style={styles.modalActions}>
          <button type="button" style={styles.dangerBtn} onClick={onDelete}>
            Delete quest
          </button>
          <button type="button" style={styles.primaryBtn} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  shell: {
    maxWidth: 1100,
    margin: "0 auto",
    padding: "1.5rem 1.25rem 3rem",
    minHeight: "100%",
  },
  header: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: "1rem",
    marginBottom: "2rem",
    paddingBottom: "1.25rem",
    borderBottom: "3px solid var(--border)",
    boxShadow: "0 4px 0 var(--shadow)",
  },
  title: {
    fontFamily: '"Press Start 2P", monospace',
    fontSize: "clamp(0.75rem, 2.5vw, 1rem)",
    lineHeight: 1.6,
    margin: "0 0 0.5rem",
    color: "var(--gold)",
    textShadow: "2px 2px 0 #1a1020",
  },
  subtitle: {
    margin: 0,
    color: "var(--text-muted)",
    fontSize: "1.15rem",
    maxWidth: "36ch",
  },
  primaryBtn: {
    fontFamily: '"Press Start 2P", monospace',
    fontSize: "0.65rem",
    padding: "0.85rem 1.25rem",
    border: "3px solid var(--accent-dim)",
    background: "linear-gradient(180deg, #9f3 0%, var(--accent) 40%, var(--accent-dim) 100%)",
    color: "#0d0f1a",
    boxShadow: "0 4px 0 #2a4a00, inset 0 1px 0 rgba(255,255,255,0.35)",
    borderRadius: 4,
  },
  ghostBtn: {
    padding: "0.65rem 1rem",
    border: "2px solid var(--border)",
    background: "var(--bg-panel)",
    borderRadius: 4,
    color: "var(--text-muted)",
  },
  dangerBtn: {
    padding: "0.65rem 1rem",
    border: "2px solid var(--danger)",
    background: "transparent",
    borderRadius: 4,
    color: "var(--danger)",
  },
  loading: {
    textAlign: "center",
    padding: "3rem 1rem",
    color: "var(--text-muted)",
  },
  loadingText: {
    margin: 0,
    fontSize: "1.25rem",
  },
  persistBanner: {
    marginBottom: "1rem",
    padding: "0.75rem 1rem",
    background: "rgba(255,68,102,0.12)",
    border: "2px solid var(--danger)",
    borderRadius: 6,
    color: "#ffb3c0",
    fontSize: "1.05rem",
  },
  empty: {
    textAlign: "center",
    padding: "3rem 1rem",
    color: "var(--text-muted)",
    border: "2px dashed var(--border)",
    borderRadius: 8,
    background: "var(--bg-panel)",
  },
  grid: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
    gap: "1.25rem",
  },
  gridWrap: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: "2rem",
  },
  completedSection: {
    margin: 0,
    padding: 0,
    border: "none",
  },
  completedHeading: {
    fontFamily: '"Press Start 2P", monospace',
    fontSize: "0.55rem",
    margin: "0 0 1rem",
    color: "var(--text-muted)",
    letterSpacing: "0.04em",
  },
  gridItem: { margin: 0 },
  /** Fills the grid cell (same stretch as sibling cards); outline is absolutely positioned inside. */
  gridPlaceholderCell: {
    position: "relative",
    minHeight: 0,
    alignSelf: "stretch",
  },
  gridPlaceholderOutline: {
    position: "absolute",
    inset: 0,
    border: "3px dashed var(--accent)",
    borderRadius: 8,
    background: "rgba(13,15,26,0.2)",
    boxSizing: "border-box",
    pointerEvents: "none",
  },
  /** In-flow invisible card so a lone placeholder row matches real card height. */
  gridPlaceholderSizeShim: {
    visibility: "hidden",
    pointerEvents: "none",
  },
  reorderGhost: {
    position: "fixed",
    left: 0,
    top: 0,
    zIndex: 100,
    pointerEvents: "none",
    willChange: "transform",
    boxShadow: "0 16px 40px rgba(0,0,0,0.55)",
    opacity: 0.98,
  },
  slot: {
    position: "relative",
    background: "var(--bg-panel)",
    border: "3px solid var(--border)",
    borderRadius: 8,
    boxShadow: "0 6px 0 var(--shadow), inset 0 0 0 1px rgba(255,255,255,0.06)",
    overflow: "hidden",
  },
  slotComplete: {
    filter: "saturate(0.72) brightness(1.08)",
    opacity: 0.92,
    borderColor: "rgba(90, 102, 140, 0.55)",
  },
  slotReorderable: {
    cursor: "grab",
    touchAction: "none",
  },
  slotMain: {
    width: "100%",
    padding: "1rem 0.75rem",
    border: "none",
    background: "transparent",
    textAlign: "center",
    display: "block",
  },
  iconFrame: {
    position: "relative",
    width: 112,
    height: 112,
    margin: "0 auto 0.75rem",
    background: "linear-gradient(145deg, #1e2440, #0f1224)",
    border: "4px solid #4a5a9a",
    borderRadius: 12,
    boxShadow: "inset 0 2px 8px rgba(0,0,0,0.5), 0 0 0 2px #0a0c18",
    display: "grid",
    placeItems: "center",
  },
  iconFrameComplete: {
    borderColor: "rgba(100, 118, 160, 0.65)",
    background: "linear-gradient(145deg, #242a45, #171b2e)",
    boxShadow: "inset 0 2px 8px rgba(0,0,0,0.42), 0 0 0 2px rgba(12,14,28,0.85)",
  },
  iconFrameSmall: {
    width: 88,
    height: 88,
    flexShrink: 0,
    background: "linear-gradient(145deg, #1e2440, #0f1224)",
    border: "3px solid #4a5a9a",
    borderRadius: 10,
    display: "grid",
    placeItems: "center",
  },
  iconImg: {
    width: 96,
    height: 96,
    objectFit: "contain",
    imageRendering: "pixelated",
    borderRadius: 6,
  },
  iconImgSmall: {
    width: 72,
    height: 72,
    objectFit: "contain",
    imageRendering: "pixelated",
    borderRadius: 4,
  },
  sectionHeading: {
    fontFamily: '"Press Start 2P", monospace',
    fontSize: "0.55rem",
    margin: "0 0 0.65rem",
    color: "var(--accent)",
    letterSpacing: "0.02em",
  },
  stepsHint: {
    margin: "0 0 0.75rem",
    color: "var(--text-muted)",
    fontSize: "1.05rem",
  },
  stepList: {
    listStyle: "none",
    margin: "0 0 0.75rem",
    padding: 0,
    maxHeight: 220,
    overflowY: "auto",
    border: "2px solid var(--border)",
    borderRadius: 6,
    background: "#0d0f1a",
  },
  stepRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.65rem",
    padding: "0.5rem 0.6rem",
    borderBottom: "1px solid rgba(61,79,143,0.45)",
    margin: 0,
  },
  stepCheck: {
    flexShrink: 0,
    width: 32,
    height: 32,
    padding: 0,
    border: "3px solid var(--border)",
    borderRadius: 4,
    background: "linear-gradient(180deg, #1a1f38, #121528)",
    color: "var(--accent)",
    fontSize: "1.1rem",
    lineHeight: 1,
    display: "grid",
    placeItems: "center",
    boxShadow: "inset 0 2px 4px rgba(0,0,0,0.4)",
  },
  stepCheckOn: {
    borderColor: "var(--accent-dim)",
    background: "linear-gradient(180deg, #3d5c1a, var(--accent-dim))",
    boxShadow: "0 2px 0 #1a3008, inset 0 1px 0 rgba(255,255,255,0.2)",
  },
  stepLabel: {
    flex: 1,
    textAlign: "left",
    fontSize: "1.15rem",
    lineHeight: 1.25,
    wordBreak: "break-word",
  },
  stepLabelDone: {
    color: "var(--text-muted)",
    textDecoration: "line-through",
  },
  stepRemove: {
    flexShrink: 0,
    width: 28,
    height: 28,
    padding: 0,
    border: "2px solid var(--border)",
    borderRadius: 4,
    background: "transparent",
    color: "var(--text-muted)",
    fontSize: "0.85rem",
    lineHeight: 1,
  },
  addStepForm: {
    display: "flex",
    gap: "0.5rem",
    marginBottom: "0.25rem",
  },
  stepInput: {
    flex: 1,
    minWidth: 0,
    padding: "0.5rem 0.65rem",
    background: "#0d0f1a",
    border: "2px solid var(--border)",
    borderRadius: 4,
    fontSize: "1.05rem",
  },
  addStepBtn: {
    flexShrink: 0,
    fontFamily: '"Press Start 2P", monospace',
    fontSize: "0.55rem",
    padding: "0.5rem 0.75rem",
    border: "2px solid var(--accent-dim)",
    background: "var(--bg-panel)",
    color: "var(--accent)",
    borderRadius: 4,
  },
  srOnly: {
    position: "absolute",
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: "hidden",
    clip: "rect(0,0,0,0)",
    whiteSpace: "nowrap",
    border: 0,
  },
  sliderHint: {
    margin: "0.35rem 0 0",
    fontSize: "1rem",
    color: "var(--text-muted)",
  },
  progressRing: {
    position: "absolute",
    inset: 4,
    width: "calc(100% - 8px)",
    height: "calc(100% - 8px)",
    pointerEvents: "none",
  },
  percentBadge: {
    position: "absolute",
    bottom: -6,
    right: -6,
    fontFamily: '"Press Start 2P", monospace',
    fontSize: "0.45rem",
    background: "#0d0f1a",
    color: "var(--gold)",
    border: "2px solid var(--gold)",
    padding: "0.35rem 0.4rem",
    borderRadius: 4,
    boxShadow: "0 2px 0 #000",
  },
  percentBadgeComplete: {
    color: "rgba(255, 215, 120, 0.75)",
    borderColor: "rgba(200, 175, 90, 0.55)",
  },
  slotTitle: {
    margin: 0,
    fontSize: "1.05rem",
    color: "var(--text)",
    lineHeight: 1.2,
    wordBreak: "break-word",
  },
  slotTitleComplete: {
    color: "rgba(200, 210, 235, 0.72)",
  },
  completedCheckBadge: {
    position: "absolute",
    top: 6,
    left: 6,
    zIndex: 3,
    width: 28,
    height: 28,
    borderRadius: 4,
    background: "linear-gradient(180deg, #5cad42, #3d8228)",
    border: "2px solid rgba(200, 255, 150, 0.55)",
    color: "#f0ffe8",
    fontSize: "0.95rem",
    fontWeight: 700,
    lineHeight: 1,
    display: "grid",
    placeItems: "center",
    boxShadow: "0 2px 0 rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.2)",
    pointerEvents: "none",
  },
  trashBtn: {
    position: "absolute",
    top: 6,
    right: 6,
    zIndex: 4,
    width: 28,
    height: 28,
    padding: 0,
    border: "2px solid var(--border)",
    borderRadius: 4,
    background: "rgba(13,15,26,0.85)",
    color: "var(--text-muted)",
    fontSize: "0.9rem",
    lineHeight: 1,
  },
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(5,6,12,0.82)",
    display: "grid",
    placeItems: "center",
    padding: "1rem",
    zIndex: 50,
    backdropFilter: "blur(4px)",
  },
  celebrationOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(5,6,12,0.55)",
    display: "grid",
    placeItems: "center",
    padding: "1rem",
    zIndex: 60,
    pointerEvents: "auto",
  },
  celebrationModal: {
    width: "min(400px, 100%)",
    textAlign: "center",
    background: "var(--bg-panel)",
    border: "4px solid var(--gold)",
    borderRadius: 10,
    padding: "2rem 1.5rem",
    boxShadow: "0 0 0 4px rgba(255,215,0,0.15), 0 16px 0 var(--shadow)",
  },
  celebrationKicker: {
    fontFamily: '"Press Start 2P", monospace',
    fontSize: "clamp(0.65rem, 3vw, 0.85rem)",
    color: "var(--accent)",
    margin: "0 0 1rem",
    lineHeight: 1.7,
    textShadow: "0 0 12px rgba(124,252,0,0.35)",
  },
  celebrationBody: {
    margin: "0 0 1.75rem",
    fontSize: "1.35rem",
    lineHeight: 1.4,
    color: "var(--text)",
  },
  celebrationName: {
    color: "var(--gold)",
    fontWeight: "normal",
  },
  modal: {
    width: "min(420px, 100%)",
    background: "var(--bg-panel)",
    border: "4px solid var(--border)",
    borderRadius: 10,
    padding: "1.5rem",
    boxShadow: "0 12px 0 var(--shadow)",
  },
  modalTitle: {
    fontFamily: '"Press Start 2P", monospace',
    fontSize: "0.7rem",
    margin: "0 0 1rem",
    color: "var(--gold)",
  },
  label: {
    display: "block",
    marginBottom: "0.35rem",
    color: "var(--text-muted)",
    fontSize: "1.1rem",
  },
  textInput: {
    width: "100%",
    padding: "0.6rem 0.75rem",
    marginBottom: "1rem",
    background: "#0d0f1a",
    border: "2px solid var(--border)",
    borderRadius: 4,
  },
  fileInput: {
    marginBottom: "0.75rem",
    fontSize: "1rem",
  },
  previewWrap: {
    display: "flex",
    justifyContent: "center",
    marginBottom: "1rem",
    padding: "0.75rem",
    background: "#0d0f1a",
    borderRadius: 8,
    border: "2px dashed var(--border)",
  },
  previewImg: {
    imageRendering: "pixelated",
    borderRadius: 8,
    border: "3px solid #4a5a9a",
  },
  error: { color: "var(--danger)", margin: "0 0 0.75rem", fontSize: "1.05rem" },
  modalActions: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.75rem",
    justifyContent: "flex-end",
    marginTop: "1.25rem",
  },
  editHeader: {
    display: "flex",
    gap: "1rem",
    alignItems: "center",
    marginBottom: "1.25rem",
  },
  slider: {
    width: "100%",
    accentColor: "var(--accent)",
    height: 10,
    marginBottom: "0.5rem",
  },
  barTrack: {
    height: 14,
    background: "#0d0f1a",
    border: "2px solid var(--border)",
    borderRadius: 4,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    background: "linear-gradient(90deg, var(--accent-dim), var(--accent))",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.25)",
    transition: "width 0.08s ease-out",
  },
};
