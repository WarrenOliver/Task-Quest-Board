import initSqlJs, { type Database } from "sql.js";
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import type { Task, TaskStep } from "./types";
import { parseTask, parseSteps } from "./taskCodec";
import { percentFromSteps } from "./types";

const LEGACY_LS_KEY = "gamified-tasks-v1";
const IDB_NAME = "gamified-tasks-sqlite";
const IDB_VERSION = 1;
const IDB_STORE = "db";

let dbInstance: Database | null = null;
let initPromise: Promise<Database> | null = null;

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
  });
}

async function idbGet(): Promise<Uint8Array | null> {
  const idb = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get("sqlite");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const v = req.result;
      if (v instanceof ArrayBuffer) resolve(new Uint8Array(v));
      else if (v instanceof Uint8Array) resolve(v);
      else resolve(null);
    };
  });
}

async function idbPut(data: Uint8Array): Promise<void> {
  const idb = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    tx.objectStore(IDB_STORE).put(copy.buffer, "sqlite");
  });
}

function ensureSchema(database: Database): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      image_data_url TEXT NOT NULL,
      percent INTEGER NOT NULL,
      next_steps_json TEXT NOT NULL
    );
  `);
}

function taskCount(database: Database): number {
  const stmt = database.prepare("SELECT COUNT(*) AS c FROM tasks");
  stmt.step();
  const row = stmt.getAsObject() as { c: number };
  stmt.free();
  return Number(row.c) || 0;
}

function migrateFromLocalStorage(database: Database): void {
  if (taskCount(database) > 0) return;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEGACY_LS_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(parsed)) return;

  const insert = database.prepare(
    `INSERT INTO tasks (id, title, image_data_url, percent, next_steps_json)
     VALUES (?, ?, ?, ?, ?)`
  );
  database.run("BEGIN");
  try {
    for (const item of parsed) {
      const t = parseTask(item);
      if (!t) continue;
      insert.run([
        t.id,
        t.title,
        t.imageDataUrl,
        t.percent,
        JSON.stringify(t.nextSteps ?? []),
      ]);
    }
    database.run("COMMIT");
  } catch (e) {
    database.run("ROLLBACK");
    throw e;
  } finally {
    insert.free();
  }
  try {
    localStorage.removeItem(LEGACY_LS_KEY);
  } catch {
    /* ignore */
  }
}

function rowToTask(row: Record<string, unknown>): Task | null {
  const id = row.id;
  const title = row.title;
  const imageDataUrl = row.image_data_url;
  const percent = row.percent;
  const nextStepsJson = row.next_steps_json;
  if (
    typeof id !== "string" ||
    typeof title !== "string" ||
    typeof imageDataUrl !== "string" ||
    typeof percent !== "number" ||
    typeof nextStepsJson !== "string"
  ) {
    return null;
  }
  let nextSteps: TaskStep[];
  try {
    nextSteps = parseSteps(JSON.parse(nextStepsJson));
  } catch {
    nextSteps = [];
  }
  const p = nextSteps.length > 0 ? percentFromSteps(nextSteps) : Math.round(percent);
  return { id, title, imageDataUrl, percent: p, nextSteps };
}

async function createDatabase(): Promise<Database> {
  const SQL = await initSqlJs({
    locateFile: (file: string) => (file.endsWith(".wasm") ? sqlWasmUrl : file),
  });
  const existing = await idbGet();
  const database = existing?.byteLength ? new SQL.Database(existing) : new SQL.Database();
  ensureSchema(database);
  migrateFromLocalStorage(database);
  const data = database.export();
  await idbPut(new Uint8Array(data));
  return database;
}

async function getDb(): Promise<Database> {
  if (dbInstance) return dbInstance;
  if (!initPromise) {
    initPromise = createDatabase().then((d) => {
      dbInstance = d;
      return d;
    });
  }
  return initPromise;
}

export async function loadTasks(): Promise<Task[]> {
  const database = await getDb();
  const stmt = database.prepare(
    "SELECT id, title, image_data_url, percent, next_steps_json FROM tasks ORDER BY rowid"
  );
  const tasks: Task[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    const t = rowToTask(row as Record<string, unknown>);
    if (t) tasks.push(t);
  }
  stmt.free();
  return tasks;
}

export async function saveTasks(tasks: Task[]): Promise<void> {
  const database = await getDb();
  database.run("BEGIN");
  try {
    database.run("DELETE FROM tasks");
    const stmt = database.prepare(
      `INSERT INTO tasks (id, title, image_data_url, percent, next_steps_json)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const t of tasks) {
      stmt.run([
        t.id,
        t.title,
        t.imageDataUrl,
        t.percent,
        JSON.stringify(t.nextSteps ?? []),
      ]);
    }
    stmt.free();
    database.run("COMMIT");
  } catch (e) {
    database.run("ROLLBACK");
    throw e;
  }
  await idbPut(new Uint8Array(database.export()));
}
