import { useCallback, useEffect, useRef, useState } from "react";
import { rpc, subscribe } from "./api.js";

// Job kinds the worker knows (worker/src/handlers.js), with a sample payload.
const KINDS = {
  send_email: { payload: { to: "someone@example.com" }, hint: "~1s, fails 15% of the time" },
  resize_image: { payload: { width: 1200 }, hint: "1-3s, always works" },
  flaky: { payload: {}, hint: "fails 70% of the time: watch the backoff" },
  always_fails: { payload: {}, hint: "uses up every attempt, ends in failed" },
  slow: { payload: { seconds: 30 }, hint: "outlives the 15s lease thanks to heartbeats" },
  crash: { payload: {}, hint: "kills the worker; the lease expires and it runs again" },
  needs_email: { payload: {}, hint: "permanent error: no retries" },
  no_such_kind: { payload: {}, hint: "no handler: permanent error" },
};

const FILTERS = ["all", "queued", "running", "succeeded", "failed", "cancelled"];

export default function Jobs({ token, onUnauthorized }) {
  const [stats, setStats] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [filter, setFilter] = useState("all");
  const [openId, setOpenId] = useState(null);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());
  const skew = useRef(0); // server clock minus browser clock

  const call = useCallback(
    async (fn, args) => {
      setError(null);
      try {
        return await rpc(fn, args, token);
      } catch (err) {
        if (err.status === 401) onUnauthorized();
        else setError(err.message);
      }
    },
    [token, onUnauthorized],
  );

  const reload = useCallback(async () => {
    const [s, list] = await Promise.all([
      call("job_stats"),
      call("list_jobs", filter === "all" ? { limit: 100 } : { status: filter, limit: 100 }),
    ]);
    if (s) {
      skew.current = new Date(s.server_time).getTime() - Date.now();
      setStats(s);
    }
    if (list) setJobs(list);
  }, [call, filter]);

  // Realtime: every job change NOTIFYs. A burst of 500 jobs means 1000+ events,
  // so reload at most every 300ms instead of once per event.
  useEffect(() => {
    let timer = null;
    const throttled = () => {
      timer ??= setTimeout(() => {
        timer = null;
        reload();
      }, 300);
    };
    reload();
    const unsubscribe = subscribe(token, "job", throttled);
    // Some changes don't NOTIFY (heartbeats, a delayed job's run_at arriving), so also poll.
    const poll = setInterval(reload, 2000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      unsubscribe();
      clearInterval(poll);
      clearInterval(tick);
      clearTimeout(timer);
    };
  }, [token, reload]);

  const serverNow = now + skew.current;

  return (
    <div className="jobs">
      <EnqueueForm call={call} onDone={reload} />
      {error && <p className="error">{error}</p>}

      {stats && (
        <>
          <StatTiles counts={stats.counts} filter={filter} onFilter={setFilter} />
          <div className="panels">
            <section>
              <h2>Finished attempts per minute</h2>
              <ThroughputChart data={stats.throughput} />
            </section>
            <section>
              <h2>Workers</h2>
              <Workers workers={stats.workers} serverNow={serverNow} />
            </section>
          </div>
        </>
      )}

      <section>
        <div className="section-head">
          <h2>Jobs</h2>
          <div className="filters">
            {FILTERS.map((f) => (
              <button key={f} className={f === filter ? "chip active" : "chip"} onClick={() => setFilter(f)}>
                {f}
              </button>
            ))}
            <button className="link" onClick={async () => (await call("purge_jobs")) && reload()}>
              Purge finished
            </button>
          </div>
        </div>
        <JobsTable
          jobs={jobs}
          serverNow={serverNow}
          openId={openId}
          onToggle={(id) => setOpenId(openId === id ? null : id)}
          call={call}
          onChange={reload}
        />
      </section>
    </div>
  );
}

function EnqueueForm({ call, onDone }) {
  const [kind, setKind] = useState("send_email");
  const [payload, setPayload] = useState(JSON.stringify(KINDS.send_email.payload));
  const [count, setCount] = useState(10);
  const [priority, setPriority] = useState(0);
  const [maxAttempts, setMaxAttempts] = useState(5);
  const [delay, setDelay] = useState(0);
  const [payloadError, setPayloadError] = useState(null);

  function pickKind(k) {
    setKind(k);
    setPayload(JSON.stringify(KINDS[k].payload));
  }

  async function submit(e) {
    e.preventDefault();
    let parsed;
    try {
      parsed = JSON.parse(payload || "{}");
      setPayloadError(null);
    } catch {
      return setPayloadError("Payload must be valid JSON");
    }
    const ok = await call("enqueue_job", {
      kind,
      payload: parsed,
      count: Number(count),
      priority: Number(priority),
      max_attempts: Number(maxAttempts),
      delay_seconds: Number(delay),
    });
    if (ok) onDone();
  }

  return (
    <form onSubmit={submit} className="enqueue">
      <label>
        Kind
        <select value={kind} onChange={(e) => pickKind(e.target.value)}>
          {Object.keys(KINDS).map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </label>
      <label className="grow">
        Payload (JSON)
        <input value={payload} onChange={(e) => setPayload(e.target.value)} />
      </label>
      <label>
        Count
        <input type="number" min="1" max="500" value={count} onChange={(e) => setCount(e.target.value)} />
      </label>
      <label>
        Priority
        <input type="number" min="-10" max="10" value={priority} onChange={(e) => setPriority(e.target.value)} />
      </label>
      <label>
        Attempts
        <input type="number" min="1" max="20" value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} />
      </label>
      <label>
        Delay (s)
        <input type="number" min="0" value={delay} onChange={(e) => setDelay(e.target.value)} />
      </label>
      <button type="submit">Enqueue</button>
      <p className="muted hint">
        <code>{kind}</code>: {KINDS[kind].hint}
        {payloadError && <span className="error"> · {payloadError}</span>}
      </p>
    </form>
  );
}

const TILES = [
  { key: "ready", label: "Ready", filter: "queued" },
  { key: "scheduled", label: "Scheduled (retry/delay)", filter: "queued" },
  { key: "running", label: "Running", filter: "running" },
  { key: "succeeded", label: "Succeeded", filter: "succeeded" },
  { key: "failed", label: "Failed", filter: "failed" },
  { key: "cancelled", label: "Cancelled", filter: "cancelled" },
];

function StatTiles({ counts, filter, onFilter }) {
  return (
    <div className="tiles">
      {TILES.map((t) => (
        <button
          key={t.key}
          className={`tile status-${t.key} ${filter === t.filter ? "active" : ""}`}
          onClick={() => onFilter(filter === t.filter ? "all" : t.filter)}
        >
          <span className="tile-value">{counts[t.key]}</span>
          <span className="tile-label">
            <i className="dot" /> {t.label}
          </span>
        </button>
      ))}
    </div>
  );
}

// Stacked bars: succeeded (bottom) + failed/lost (top) per minute, last 15 minutes.
function ThroughputChart({ data }) {
  const [hover, setHover] = useState(null);
  const W = 360;
  const H = 120;
  const PAD_TOP = 8;
  const PAD_BOTTOM = 18;
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const max = Math.max(1, ...data.map((d) => d.succeeded + d.failed));
  const slot = W / data.length;
  const barW = slot - 4;
  const y = (v) => (v / max) * plotH;
  const baseline = H - PAD_BOTTOM;
  const total = data.reduce((sum, d) => sum + d.succeeded + d.failed, 0);

  // A bar segment with a rounded top only (flat on the bottom).
  const bar = (x, top, height, round) => {
    if (height <= 0) return null;
    const r = Math.min(round ? 3 : 0, height, barW / 2);
    return `M${x},${top + height} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${top + height} Z`;
  };

  return (
    <div className="chart">
      <div className="legend">
        <span><i className="swatch good" /> succeeded</span>
        <span><i className="swatch critical" /> failed / lost</span>
        <span className="muted">{total} in 15 min</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Finished attempts per minute, last 15 minutes">
        <line x1="0" x2={W} y1={baseline} y2={baseline} className="axis" />
        <line x1="0" x2={W} y1={PAD_TOP} y2={PAD_TOP} className="grid" />
        <text x="2" y={PAD_TOP - 1} className="tick">{max}</text>
        <text x="2" y={H - 4} className="tick">−14m</text>
        <text x={W - 2} y={H - 4} className="tick" textAnchor="end">now</text>
        {data.map((d, i) => {
          const x = i * slot + 2;
          const hOk = y(d.succeeded);
          const hFail = y(d.failed);
          const gap = hOk > 0 && hFail > 0 ? 2 : 0; // surface gap between stacked segments
          return (
            <g key={d.minute}>
              <path d={bar(x, baseline - hOk, hOk, hFail === 0)} className="fill-good" />
              <path d={bar(x, baseline - hOk - gap - hFail, hFail, true)} className="fill-critical" />
              {/* hit target: the whole column, bigger than the bar */}
              <rect
                x={i * slot} y="0" width={slot} height={H} fill="transparent"
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
              />
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className="tooltip" style={{ left: `${((hover + 0.5) / data.length) * 100}%` }}>
          <strong>{new Date(data[hover].minute).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</strong>
          <span><i className="swatch good" /> {data[hover].succeeded} succeeded</span>
          <span><i className="swatch critical" /> {data[hover].failed} failed</span>
        </div>
      )}
    </div>
  );
}

function Workers({ workers, serverNow }) {
  if (workers.length === 0) {
    return <p className="muted">No workers. Start some: <code>docker compose up worker</code></p>;
  }
  return (
    <table className="table">
      <thead>
        <tr><th>Worker</th><th>Busy</th><th>Done</th><th>Failed</th><th>Seen</th></tr>
      </thead>
      <tbody>
        {workers.map((w) => (
          <tr key={w.id} className={w.online ? "" : "offline"}>
            <td>
              <i className={`dot ${w.online ? "online" : ""}`} /> <code>{w.id}</code>
              {!w.online && <span className="muted"> offline</span>}
            </td>
            <td>{w.running}/{w.concurrency}</td>
            <td>{w.processed}</td>
            <td>{w.failed}</td>
            <td className="muted">{ago(w.last_seen_at, serverNow)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function JobsTable({ jobs, serverNow, openId, onToggle, call, onChange }) {
  if (jobs.length === 0) return <p className="muted">No jobs here. Enqueue some above.</p>;
  return (
    <table className="table jobs-table">
      <thead>
        <tr><th>#</th><th>Kind</th><th>Status</th><th>Attempts</th><th>When</th><th>Worker / error</th><th /></tr>
      </thead>
      <tbody>
        {jobs.map((j) => {
          const status = displayStatus(j, serverNow);
          return [
            <tr key={j.id} className="clickable" onClick={() => onToggle(j.id)}>
              <td className="muted">{j.id}</td>
              <td>
                <code>{j.kind}</code>
                {j.priority !== 0 && <span className="muted"> p{j.priority}</span>}
              </td>
              <td><span className={`badge status-${status}`}><i className="dot" /> {status}</span></td>
              <td>{j.attempts}/{j.max_attempts}</td>
              <td className="muted">{whenText(j, status, serverNow)}</td>
              <td className="ellipsis">
                {j.status === "running" && <code>{j.locked_by}</code>}
                {!["running", "succeeded"].includes(j.status) && <span className="error-text">{j.last_error}</span>}
              </td>
              <td className="actions" onClick={(e) => e.stopPropagation()}>
                {["failed", "cancelled"].includes(j.status) || status === "scheduled" ? (
                  <button className="link" onClick={async () => (await call("retry_job", { id: j.id })) && onChange()}>
                    {status === "scheduled" ? "Run now" : "Retry"}
                  </button>
                ) : null}
                {j.status === "queued" && (
                  <button className="link" onClick={async () => (await call("cancel_job", { id: j.id })) && onChange()}>
                    Cancel
                  </button>
                )}
              </td>
            </tr>,
            openId === j.id && (
              <tr key={`${j.id}-detail`} className="detail-row">
                <td colSpan="7"><JobDetail id={j.id} version={j.updated_at} call={call} /></td>
              </tr>
            ),
          ];
        })}
      </tbody>
    </table>
  );
}

// The attempt history (app.job_runs). Refetches when the job's updated_at changes.
function JobDetail({ id, version, call }) {
  const [job, setJob] = useState(null);
  useEffect(() => {
    call("get_job", { id }).then((j) => j && setJob(j));
  }, [id, version, call]);

  if (!job) return <p className="muted">Loading…</p>;
  return (
    <div className="detail">
      <div>
        <h3>Payload</h3>
        <pre>{JSON.stringify(job.payload, null, 2)}</pre>
        {job.result && (
          <>
            <h3>Result</h3>
            <pre>{JSON.stringify(job.result, null, 2)}</pre>
          </>
        )}
      </div>
      <div>
        <h3>Attempts</h3>
        {job.runs.length === 0 && <p className="muted">Not picked up yet.</p>}
        <ol className="runs">
          {job.runs.map((r) => (
            <li key={r.attempt}>
              <span className={`badge status-${r.outcome}`}><i className="dot" /> {r.outcome}</span>{" "}
              <code>{r.worker_id}</code>{" "}
              <span className="muted">
                {new Date(r.started_at).toLocaleTimeString()}
                {r.finished_at && ` · ${((new Date(r.finished_at) - new Date(r.started_at)) / 1000).toFixed(1)}s`}
              </span>
              {r.error && <div className="error-text">{r.error}</div>}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

// "queued" with a future run_at is waiting out a delay or a retry backoff.
function displayStatus(job, serverNow) {
  if (job.status === "queued" && new Date(job.run_at).getTime() > serverNow) return "scheduled";
  if (job.status === "queued") return "ready";
  return job.status;
}

function whenText(job, status, serverNow) {
  if (status === "scheduled") return `runs in ${seconds(new Date(job.run_at).getTime() - serverNow)}`;
  if (status === "ready") return `waiting ${ago(job.run_at, serverNow, "")}`;
  if (status === "running") return `lease ends in ${seconds(new Date(job.lease_expires_at).getTime() - serverNow)}`;
  return `${ago(job.finished_at ?? job.updated_at, serverNow)}`;
}

function ago(iso, serverNow, suffix = " ago") {
  return `${seconds(serverNow - new Date(iso).getTime())}${suffix}`;
}

function seconds(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h`;
}
