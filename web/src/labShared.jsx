// Pieces shared by the Concurrency Lab scenarios (Concurrency.jsx, BankTransfer.jsx).
import { rpcBatch } from "./api.js";

// How a transaction ended. Business outcomes come from the function's `status`;
// the rest are SQLSTATEs the gateway saw.
export const OUTCOMES = {
  bought: "bought",
  transferred: "transferred",
  sold_out: "sold out",
  insufficient_funds: "insufficient funds",
  conflict: "conflict (40001)",
  deadlock: "deadlock (40P01)",
  error: "error",
};

function failedOutcome(code) {
  if (code === "40P01") return "deadlock";
  if (code === "40001") return "conflict";
  return "error";
}

// Fires every lane's call at the same moment (one transaction each, via the
// gateway's /api/rpc-batch) and turns the answers into timeline rows.
// lanes: [{ id, label, call: { fn, args, isolation?, retry? } }]
export async function race(lanes, token) {
  const results = await rpcBatch(
    lanes.map((l) => l.call),
    token,
  );
  const rows = lanes.map((lane, i) => {
    const res = results[i];
    const tries = res.tries.map((t) => ({
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      error: t.error,
      outcome: t.ok ? res.result.status : failedOutcome(t.code),
    }));
    const final = res.ok
      ? { ...res.result, attempts: tries.length }
      : { status: "error", error: res.error, attempts: tries.length };
    return { ...lane, tries, final };
  });

  const tries = rows.flatMap((r) => r.tries);
  const t0 = Math.min(...tries.map((t) => t.startedAt));
  const t1 = Math.max(...tries.map((t) => t.finishedAt));
  return {
    rows,
    t0,
    durationMs: t1 - t0,
    retries: tries.length - rows.length,
    deadlocks: tries.filter((t) => t.outcome === "deadlock").length,
  };
}

export function Tile({ label, value, bad }) {
  return (
    <div className={bad ? "tile bad" : "tile"}>
      <span className="tile-value">{value}</span>
      <span className="tile-label">{label}</span>
    </div>
  );
}

// One row per lane, one bar per transaction, on a shared time axis.
// Parallel bars = they ran at the same time; a staircase = they queued.
// legend: outcome keys to explain; detail(row): extra text after the outcome.
export function Timeline({ race, legend, detail, wideLabels }) {
  const span = Math.max(race.durationMs, 1);
  return (
    <section>
      <div className="section-head">
        <h2>Timeline <span className="muted">(each bar is one transaction, 0 → {race.durationMs} ms)</span></h2>
        <div className="legend">
          {legend.map((o) => (
            <span key={o}><span className={`swatch outcome-${o}`} /> {OUTCOMES[o]}</span>
          ))}
        </div>
      </div>
      <div className={wideLabels ? "lab-timeline wide-labels" : "lab-timeline"}>
        {race.rows.map((row) => (
          <div key={row.id} className="lab-lane">
            <span className="lab-buyer">{row.label}</span>
            <div className="lab-track">
              {row.tries.map((t, i) => (
                <span
                  key={i}
                  className={`lab-bar outcome-${t.outcome}`}
                  style={{
                    left: `${((t.startedAt - race.t0) / span) * 100}%`,
                    width: `max(3px, ${((t.finishedAt - t.startedAt) / span) * 100}%)`,
                  }}
                  title={`${OUTCOMES[t.outcome] ?? t.outcome} · ${t.startedAt - race.t0}–${t.finishedAt - race.t0} ms${t.error ? ` · ${t.error}` : ""}`}
                />
              ))}
            </div>
            <span className={`lab-outcome outcome-text-${row.final.status}`} title={row.final.error}>
              {OUTCOMES[row.final.status] ?? row.final.status}
              {detail?.(row)}
              {row.final.attempts > 1 && <span className="muted"> · ×{row.final.attempts}</span>}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
