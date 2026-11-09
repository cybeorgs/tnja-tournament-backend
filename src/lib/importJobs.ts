// ─── Background import jobs ──────────────────────────────────────────────────
// A large import takes longer than the reverse proxy waits for a response (Nginx: 60 s → 504),
// so the import request only starts the work and returns a job id; the page polls for progress.
// Jobs live in memory for an hour (the API runs as a single process).

import { randomUUID } from "node:crypto";
import { HttpError } from "../middleware/errors.js";

export interface ImportJob<R = unknown> {
  id: string;
  kind: string;
  /** Who started it (admin id): only they can read it */
  owner: string;
  status: "RUNNING" | "DONE" | "FAILED";
  /** CHECKING (validating rows) | SAVING */
  phase: "CHECKING" | "SAVING" | "EMAILING";
  total: number;
  done: number;
  result: R | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

const jobs = new Map<string, ImportJob>();
const KEEP_MS = 60 * 60 * 1000;

function prune() {
  const now = Date.now();
  for (const [id, job] of jobs) if (job.finishedAt && now - job.finishedAt > KEEP_MS) jobs.delete(id);
}

/** One import of a kind at a time (e.g. per tournament): a second click doesn't start a parallel run. */
export function runningJob(kind: string) {
  return [...jobs.values()].find((j) => j.kind === kind && j.status === "RUNNING") ?? null;
}

/** Start `work` in the background; it reports progress through the job it is given. */
export function startJob<R>(kind: string, owner: string, work: (job: ImportJob<R>) => Promise<R>): ImportJob<R> {
  prune();
  const existing = runningJob(kind);
  if (existing) throw new HttpError(409, "An import is already running. Wait for it to finish.");
  const job: ImportJob<R> = { id: randomUUID(), kind, owner, status: "RUNNING", phase: "CHECKING", total: 0, done: 0, result: null, error: null, startedAt: Date.now(), finishedAt: null };
  jobs.set(job.id, job as ImportJob);
  work(job)
    .then((result) => Object.assign(job, { status: "DONE", result, finishedAt: Date.now() }))
    .catch((err) => {
      console.error(`[import ${kind}] failed:`, err);
      Object.assign(job, { status: "FAILED", error: err instanceof HttpError ? err.message : "The import stopped unexpectedly.", finishedAt: Date.now() });
    });
  return job;
}

export function getJob(id: string, owner: string): ImportJob {
  const job = jobs.get(id);
  if (!job || job.owner !== owner) throw new HttpError(404, "This import isn't running any more (the server may have restarted). Check the list, then import the file again — rows already imported are skipped.");
  return job;
}
