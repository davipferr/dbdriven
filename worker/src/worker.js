// =============================================================================
// A queue worker. Run as many copies as you like (docker compose runs 2); the
// database makes sure they never get the same job (see db/init/05_jobs.sql).
//
// The loop:
//   1. claim up to <free slots> jobs   -> worker.claim_jobs  (FOR UPDATE SKIP LOCKED)
//   2. run each one's handler, CONCURRENCY at a time, outside any transaction
//   3. report the outcome              -> worker.complete_job / worker.fail_job
//   4. meanwhile, every 5s             -> worker.heartbeat   (extends our leases)
//
// It wakes up on NOTIFY jobs_available (new job), when a slot frees up, and
// every POLL_MS as a fallback (delayed jobs and retries don't send a NOTIFY when
// their run_at arrives).
// =============================================================================
import os from "node:os";
import pg from "pg";
import { handlers, PermanentError } from "./handlers.js";

const CONCURRENCY = Number(process.env.CONCURRENCY ?? 3);
const QUEUES = (process.env.QUEUES ?? "default").split(",");
const POLL_MS = 1000;
const HEARTBEAT_MS = 5000; // must stay well below the 15s lease in private.job_lease()
const SHUTDOWN_GRACE_MS = 8000;
const WORKER_ID = `${os.hostname()}:${process.pid}`;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: CONCURRENCY + 2 });
const running = new Set(); // promises of jobs in progress
let stopping = false;

const log = (...args) => console.log(`[${WORKER_ID}]`, ...args);

// ---------- Claiming ----------

// Several things trigger a claim at once (NOTIFY, poll, a job finishing), so make
// sure only one claim query runs at a time and coalesce the extra triggers.
let claiming = false;
let claimAgain = false;

async function fillSlots() {
  if (claiming) {
    claimAgain = true;
    return;
  }
  claiming = true;
  try {
    do {
      claimAgain = false;
      const free = CONCURRENCY - running.size;
      if (stopping || free <= 0) break;

      const { rows } = await pool.query("select worker.claim_jobs($1, $2, $3) as jobs", [
        WORKER_ID,
        QUEUES,
        free,
      ]);
      for (const job of rows[0].jobs) start(job);
      // Got a full batch? There may be more waiting.
      if (rows[0].jobs.length === free) claimAgain = true;
    } while (claimAgain);
  } catch (err) {
    log("claim failed:", err.message);
  } finally {
    claiming = false;
  }
}

// ---------- Running ----------

function start(job) {
  const promise = run(job).finally(() => {
    running.delete(promise);
    fillSlots(); // a slot just opened
  });
  running.add(promise);
}

async function run(job) {
  const label = `[job ${job.id} ${job.kind} attempt ${job.attempt}/${job.max_attempts}]`;
  const handler = handlers[job.kind];
  let acknowledged;

  try {
    if (!handler) throw new PermanentError(`No handler for job kind "${job.kind}"`);
    const result = await handler(job);
    const { rows } = await pool.query("select worker.complete_job($1, $2, $3) as ok", [
      WORKER_ID,
      job.id,
      JSON.stringify(result ?? null),
    ]);
    acknowledged = rows[0].ok;
    log(label, "succeeded");
  } catch (err) {
    const retryable = !(err instanceof PermanentError);
    try {
      const { rows } = await pool.query("select worker.fail_job($1, $2, $3, $4) as ok", [
        WORKER_ID,
        job.id,
        err.message,
        retryable,
      ]);
      acknowledged = rows[0].ok;
      log(label, "failed:", err.message, retryable ? "" : "(permanent)");
    } catch (reportErr) {
      // Couldn't even reach the DB. Do nothing: the lease will expire and the
      // job will be retried. That's the safety net.
      log(label, "could not report failure:", reportErr.message);
      return;
    }
  }

  if (acknowledged === false) {
    // We took too long (lease expired) and the job was handed to someone else.
    // The DB rejected our late report. This is exactly why handlers must be idempotent.
    log(label, "result discarded: we no longer hold this job's lease");
  }
}

// ---------- Heartbeat ----------

async function heartbeat() {
  try {
    await pool.query("select worker.heartbeat($1, $2, $3)", [WORKER_ID, QUEUES, CONCURRENCY]);
  } catch (err) {
    log("heartbeat failed:", err.message);
  }
}

// ---------- Wake-ups ----------

async function listenForNewJobs() {
  // LISTEN needs a dedicated connection that stays open (not a pooled one).
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("listen jobs_available");
  client.on("notification", (msg) => {
    if (QUEUES.includes(msg.payload)) fillSlots();
  });
  client.on("error", (err) => {
    log("LISTEN connection lost:", err.message);
    process.exit(1); // Docker restarts us; in-flight jobs come back via lease expiry
  });
  return client;
}

// ---------- Graceful shutdown ----------
// `docker compose stop` sends SIGTERM: stop claiming, let running jobs finish
// for a few seconds, then hand back whatever is still running.

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal}: finishing ${running.size} running job(s)...`);
  clearInterval(pollTimer);
  clearInterval(heartbeatTimer);

  const timeout = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS));
  await Promise.race([Promise.allSettled(running), timeout]);

  try {
    const { rows } = await pool.query("select worker.unregister($1) as released", [WORKER_ID]);
    if (rows[0].released) log(`handed ${rows[0].released} unfinished job(s) back to the queue`);
  } catch (err) {
    log("unregister failed:", err.message);
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ---------- Go ----------

await heartbeat(); // register before claiming anything
await listenForNewJobs();
const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
const pollTimer = setInterval(fillSlots, POLL_MS);
log(`started: queues=${QUEUES.join(",")} concurrency=${CONCURRENCY}`);
fillSlots();
