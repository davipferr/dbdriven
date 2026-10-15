// =============================================================================
// The "backend": a deliberately dumb gateway between HTTP and PostgreSQL.
//
// It knows NOTHING about users, todos, passwords or tokens. It only:
//   1. turns  POST /api/rpc/<fn>  into  select api.<fn>(<body>)
//   2. hands the Authorization token to the database for that one transaction
//   3. turns Postgres error codes into HTTP status codes
//   4. relays LISTEN/NOTIFY messages to browsers over Server-Sent Events
//   5. runs a batch of calls in parallel, each in its own transaction (the
//      Concurrency Lab needs that; a browser only opens ~6 requests at once)
// All of the actual logic lives in ../../db/init/*.sql
// (Background jobs are run by a separate process: ../../worker)
// =============================================================================
import express from "express";
import pg from "pg";

// max 25: enough connections for a 20-buyer race to really run in parallel
// (pg's default of 10 would quietly queue half of them).
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 25 });
const app = express();
app.use(express.json());

// Function names go straight into SQL, so allow only plain identifiers.
// (The database's GRANTs are the real guard: app_api can only execute api.* functions.)
const FUNCTION_NAME = /^[a-z_][a-z0-9_]*$/;

// Isolation has to be chosen at BEGIN, before any query, so it can't be set
// from inside the function. The client asks for it; the default is READ COMMITTED.
const ISOLATION = {
  "read committed": "read committed",
  "repeatable read": "repeatable read",
  serializable: "serializable",
};

async function callRpc(fn, args, token, isolation, attempt = 1) {
  const client = await pool.connect();
  try {
    await client.query(`begin isolation level ${ISOLATION[isolation] ?? "read committed"}`);
    // `true` = transaction-local, so the token can't leak into the next request
    // that reuses this pooled connection. request.attempt says which retry this is.
    await client.query("select set_config('request.jwt', $1, true), set_config('request.attempt', $2, true)", [
      token ?? "",
      String(attempt),
    ]);
    const { rows } = await client.query(`select api."${fn}"($1::jsonb) as result`, [
      JSON.stringify(args ?? {}),
    ]);
    await client.query("commit");
    return rows[0].result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Postgres SQLSTATE codes -> HTTP. https://www.postgresql.org/docs/16/errcodes-appendix.html
function httpStatusFor(code = "") {
  if (code === "28000") return 401; // invalid_authorization_specification
  if (code === "42501") return 403; // insufficient_privilege
  if (code === "42883" || code === "P0002") return 404; // undefined_function / no_data_found
  if (code === "23505") return 409; // unique_violation
  if (code === "40001" || code === "40P01") return 409; // serialization_failure / deadlock: retry
  if (code.startsWith("22") || code.startsWith("23") || code === "P0001") return 400; // bad data / rule broken
  return 500;
}

function sendDbError(res, err) {
  const status = httpStatusFor(err.code);
  if (status === 500) console.error(err);
  res.status(status).json({
    error: status === 500 ? "Internal server error" : err.message,
    code: err.code,
  });
}

function bearerToken(req) {
  return req.get("authorization")?.replace(/^Bearer\s+/i, "");
}

// ---------- 1. RPC: the only data endpoint ----------

app.post("/api/rpc/:fn", async (req, res) => {
  const { fn } = req.params;
  if (!FUNCTION_NAME.test(fn)) {
    return res.status(404).json({ error: "Unknown function" });
  }
  try {
    res.json(await callRpc(fn, req.body, bearerToken(req)));
  } catch (err) {
    sendDbError(res, err);
  }
});

// ---------- 1b. Batch: many RPCs at the same moment, one transaction each ----------
// Body: { calls: [{ fn, args, isolation?, retry? }] }. Answers with one entry per
// call, in order. `tries` has server timestamps so the browser can draw a timeline.
//
// retry: true re-runs the call when Postgres says the transaction itself is
// the problem, not the data: 40001 (serialization_failure) and 40P01
// (deadlock_detected). That's always safe here because the failed attempt was
// rolled back completely, so the retry starts from scratch.
//
// Before retrying, wait a RANDOM bit that grows with each attempt ("backoff
// with jitter"). Retrying instantly sends the victim straight back into the
// same lock queue, in the same order, and it deadlocks again: a retry storm.

const RETRYABLE = new Set(["40001", "40P01"]);
const MAX_ATTEMPTS = 25;
const backoff = (attempt) => new Promise((r) => setTimeout(r, Math.random() * 50 * Math.min(attempt, 6)));

async function callWithRetries({ fn, args, isolation, retry }, token) {
  const tries = [];
  for (let attempt = 1; ; attempt++) {
    const startedAt = Date.now();
    try {
      const result = await callRpc(fn, args, token, isolation, attempt);
      tries.push({ ok: true, startedAt, finishedAt: Date.now() });
      return { ok: true, result, tries };
    } catch (err) {
      const status = httpStatusFor(err.code);
      if (status === 500) console.error(err);
      const error = status === 500 ? "Internal server error" : err.message;
      tries.push({ ok: false, code: err.code, error, startedAt, finishedAt: Date.now() });
      if (!retry || !RETRYABLE.has(err.code) || attempt >= MAX_ATTEMPTS) {
        return { ok: false, status, error, code: err.code, tries };
      }
      await backoff(attempt);
    }
  }
}

app.post("/api/rpc-batch", async (req, res) => {
  const calls = req.body?.calls;
  if (!Array.isArray(calls) || calls.length === 0 || calls.length > 50) {
    return res.status(400).json({ error: "calls must be an array of 1-50 items" });
  }
  if (!calls.every((c) => FUNCTION_NAME.test(c?.fn ?? ""))) {
    return res.status(404).json({ error: "Unknown function" });
  }
  const token = bearerToken(req);
  const results = await Promise.all(calls.map((call) => callWithRetries(call, token)));
  const unauthorized = results.find((r) => r.status === 401);
  if (unauthorized) return res.status(401).json({ error: unauthorized.error });
  res.json(results);
});

// ---------- 2. Realtime: LISTEN/NOTIFY -> Server-Sent Events ----------

const subscribers = new Set(); // { userId, res }

// EventSource can't send headers, so the token comes as a query parameter.
// Fine for learning; in production prefer a short-lived ticket or cookies.
app.get("/api/events", async (req, res) => {
  let me;
  try {
    me = await callRpc("me", {}, req.query.token); // the DB decides who this is
  } catch (err) {
    return sendDbError(res, err);
  }

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.write(": connected\n\n");

  const subscriber = { userId: me.id, res };
  subscribers.add(subscriber);
  const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);

  req.on("close", () => {
    clearInterval(keepAlive);
    subscribers.delete(subscriber);
  });
});

// Postgres channel -> SSE event name sent to the browser.
const CHANNELS = {
  todo_changes: "todo", // built by app.todos_notify() in 03_rules.sql
  job_changes: "job", //   built by app.jobs_notify()  in 05_jobs.sql
};

async function listenForChanges() {
  // LISTEN needs one dedicated connection that stays open (not a pooled one).
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  for (const channel of Object.keys(CHANNELS)) await client.query(`listen ${channel}`);

  client.on("notification", (msg) => {
    const change = JSON.parse(msg.payload);
    for (const sub of subscribers) {
      if (sub.userId === change.user_id) {
        sub.res.write(`event: ${CHANNELS[msg.channel]}\ndata: ${msg.payload}\n\n`);
      }
    }
  });

  // Keep it simple: if the listener dies, crash and let Docker restart us.
  client.on("error", (err) => {
    console.error("LISTEN connection lost:", err);
    process.exit(1);
  });
}

const port = Number(process.env.PORT ?? 4000);
await listenForChanges();
app.listen(port, () => console.log(`api listening on :${port}`));
