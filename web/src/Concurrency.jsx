import { useCallback, useState } from "react";
import { rpc, rpcBatch } from "./api.js";

// The five ways to sell the last items (db/init/07_concurrency.sql).
// `sql` is the heart of each function, trimmed for reading.
const STRATEGIES = {
  naive: {
    label: "Naive",
    fn: "lab_buy_naive",
    isolation: "read committed",
    note: "Read, think, write what you read minus one. Everyone reads the same stock, so everyone \"wins\".",
    sql: `select stock into v_stock from app.lab_products where id = v_id;
perform pg_sleep(delay);            -- everyone is here at once
if v_stock <= 0 then return 'sold_out'; end if;
update app.lab_products set stock = v_stock - 1 where id = v_id;
insert into app.lab_orders ...;`,
  },
  for_update: {
    label: "SELECT … FOR UPDATE",
    fn: "lab_buy_for_update",
    isolation: "read committed",
    note: "The same code plus FOR UPDATE. The first reader locks the row; the others queue behind it. Correct, but buyers go one at a time.",
    sql: `select stock into v_stock from app.lab_products where id = v_id
  for update;                       -- others wait HERE until we commit
perform pg_sleep(delay);            -- ...while we hold the lock
if v_stock <= 0 then return 'sold_out'; end if;
update app.lab_products set stock = v_stock - 1 where id = v_id;
insert into app.lab_orders ...;`,
  },
  atomic: {
    label: "Atomic UPDATE",
    fn: "lab_buy_atomic",
    isolation: "read committed",
    note: "No read-then-write gap at all: one UPDATE checks and decrements. A second buyer waits for the row lock, then re-checks stock > 0 on the committed row.",
    sql: `perform pg_sleep(delay);            -- think in parallel, nothing read yet
update app.lab_products set stock = stock - 1
where id = v_id and stock > 0;      -- check + write in ONE statement
if not found then return 'sold_out'; end if;
insert into app.lab_orders ...;`,
  },
  optimistic: {
    label: "Optimistic (version)",
    fn: "lab_buy_optimistic",
    isolation: "read committed",
    retry: true,
    note: "Think without holding locks; write only if the version is unchanged. 0 rows updated means someone beat you: the function raises 40001 and this page retries in a new transaction.",
    sql: `select stock, version into v_stock, v_version from app.lab_products where id = v_id;
perform pg_sleep(delay);            -- no locks held while thinking
if v_stock <= 0 then return 'sold_out'; end if;
update app.lab_products set stock = v_stock - 1, version = v_version + 1
where id = v_id and version = v_version;   -- 0 rows if someone beat us
if not found then raise exception '...' using errcode = '40001'; end if;
-- -> client retries the whole transaction`,
  },
  serializable: {
    label: "SERIALIZABLE + retry",
    fn: "lab_buy_naive",
    isolation: "serializable",
    retry: true,
    note: "The NAIVE function, unchanged, at SERIALIZABLE isolation. Postgres aborts the losers with 40001, and this page (the client) retries them in a new transaction.",
    sql: `begin isolation level serializable;   -- the only change
select api.lab_buy_naive(...);
-- ERROR 40001: could not serialize access due to concurrent update
-- -> client runs the whole transaction again`,
  },
};

const RETRYABLE = new Set(["40001", "40P01"]); // serialization_failure, deadlock_detected
const MAX_WAVES = 25;

export default function Concurrency({ token, onUnauthorized }) {
  const [strategy, setStrategy] = useState("naive");
  const [stock, setStock] = useState(3);
  const [buyers, setBuyers] = useState(10);
  const [delay, setDelay] = useState(100);
  const [running, setRunning] = useState(false);
  const [race, setRace] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState(null);

  const runRace = useCallback(
    async (key) => {
      const s = STRATEGIES[key];
      const product = await rpc("lab_reset", { stock: Number(stock) }, token);
      const n = Math.min(Math.max(Number(buyers), 1), 20);
      const rows = Array.from({ length: n }, (_, i) => ({ buyer: i + 1, tries: [], final: null }));

      // Wave 1: everybody at once. Next waves: only the ones Postgres aborted.
      let pending = rows;
      for (let wave = 1; pending.length && wave <= MAX_WAVES; wave++) {
        const results = await rpcBatch(
          pending.map((r) => ({
            fn: s.fn,
            isolation: s.isolation,
            args: { product_id: product.id, buyer: r.buyer, delay_ms: Number(delay), strategy: key, attempt: wave },
          })),
          token,
        );
        const next = [];
        results.forEach((res, i) => {
          const row = pending[i];
          const time = { startedAt: res.startedAt, finishedAt: res.finishedAt };
          if (res.ok) {
            row.tries.push({ ...time, outcome: res.result.status });
            row.final = { ...res.result, attempts: row.tries.length };
          } else if (s.retry && RETRYABLE.has(res.code)) {
            row.tries.push({ ...time, outcome: "retry", error: res.error });
            next.push(row);
          } else {
            row.tries.push({ ...time, outcome: "error", error: res.error });
            row.final = { status: "error", error: res.error, attempts: row.tries.length };
          }
        });
        pending = next;
      }
      for (const row of pending) row.final = { status: "error", error: `Still failing after ${MAX_WAVES} tries` };

      const state = await rpc("lab_state", {}, token);
      const tries = rows.flatMap((r) => r.tries);
      const t0 = Math.min(...tries.map((t) => t.startedAt));
      const t1 = Math.max(...tries.map((t) => t.finishedAt));
      return {
        key,
        delay: Number(delay),
        rows,
        t0,
        durationMs: t1 - t0,
        initial: state.product.initial_stock,
        finalStock: state.product.stock,
        orders: state.orders.length,
        retries: rows.reduce((sum, r) => sum + Math.max((r.final?.attempts ?? 1) - 1, 0), 0),
      };
    },
    [token, stock, buyers, delay],
  );

  async function run(keys) {
    setError(null);
    setRunning(true);
    try {
      for (const key of keys) {
        setStrategy(key); // keep the SQL panel in step with the race being shown
        const result = await runRace(key);
        setRace(result);
        setHistory((h) => [result, ...h].slice(0, 20));
      }
    } catch (err) {
      if (err.status === 401) onUnauthorized();
      else setError(err.message);
    } finally {
      setRunning(false);
    }
  }

  const s = STRATEGIES[strategy];

  return (
    <div className="lab">
      <section>
        <h2>Flash sale <span className="muted">({buyers} buyers, {stock} pairs of sneakers left, everyone clicks Buy at the same moment)</span></h2>
        <form
          className="lab-controls"
          onSubmit={(e) => {
            e.preventDefault();
            run([strategy]);
          }}
        >
          <label>
            Strategy
            <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
              {Object.entries(STRATEGIES).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </label>
          <label>
            Stock
            <input type="number" min="1" max="100" value={stock} onChange={(e) => setStock(e.target.value)} />
          </label>
          <label>
            Buyers
            <input type="number" min="1" max="20" value={buyers} onChange={(e) => setBuyers(e.target.value)} />
          </label>
          <label>
            Think time (ms)
            <input type="number" min="0" max="2000" step="50" value={delay} onChange={(e) => setDelay(e.target.value)} />
          </label>
          <button type="submit" disabled={running}>{running ? "Racing…" : "Run race"}</button>
          <button type="button" className="secondary" disabled={running} onClick={() => run(Object.keys(STRATEGIES))}>
            Run all 5
          </button>
          <p className="muted hint">
            Think time is a <code>pg_sleep</code> between reading the stock and writing it: a stand-in for a payment
            call or a slow server. Set it to 0 and the naive race may still go wrong, just less reliably.
          </p>
        </form>
      </section>

      <div className="lab-top">
        <section>
          <h3>{s.label} <span className="muted">· {s.isolation}</span></h3>
          <p className="hint">{s.note}</p>
          <pre className="sql">{s.sql}</pre>
        </section>
        <section>{race ? <Verdict race={race} /> : <p className="muted">Run a race to see what ends up in the database.</p>}</section>
      </div>

      {error && <p className="error">{error}</p>}

      {race && <Timeline race={race} />}
      {history.length > 0 && <History history={history} onClear={() => setHistory([])} />}
    </div>
  );
}

// Compares what the buyers were told with what the table says.
function Verdict({ race }) {
  const { initial, orders, finalStock } = race;
  const expectedStock = initial - orders; // what the stock should be after `orders` sales
  const lost = finalStock - expectedStock; // decrements that overwrote each other
  const oversold = orders - initial;
  const ok = oversold <= 0 && lost === 0;

  return (
    <div className="lab-verdict">
      <h3>{STRATEGIES[race.key].label} <span className="muted">· result</span></h3>
      <div className="tiles">
        <Tile label="Starting stock" value={initial} />
        <Tile label="Orders created" value={orders} bad={oversold > 0} />
        <Tile label="Stock column now" value={finalStock} bad={lost !== 0} />
        <Tile label="Took" value={`${race.durationMs} ms`} />
      </div>
      <p className={ok ? "verdict good" : "verdict bad"}>
        {ok ? (
          <>✓ Correct: {orders} orders for {initial} items, and the stock says {finalStock}.</>
        ) : (
          <>
            ✗ {oversold > 0 ? <>Oversold: {orders} orders for {initial} items. </> : null}
            {lost !== 0 && (
              <>
                The stock column says {finalStock}, but after {orders} sales it should be {expectedStock}:{" "}
                {lost} decrement{lost === 1 ? " was" : "s were"} overwritten (lost updates).
              </>
            )}
          </>
        )}
        {race.retries > 0 && <> {race.retries} retr{race.retries === 1 ? "y" : "ies"} were needed.</>}
      </p>
    </div>
  );
}

function Tile({ label, value, bad }) {
  return (
    <div className={bad ? "tile bad" : "tile"}>
      <span className="tile-value">{value}</span>
      <span className="tile-label">{label}</span>
    </div>
  );
}

const OUTCOME_LABEL = { bought: "bought", sold_out: "sold out", retry: "conflict (40001)", error: "error" };

// One row per buyer, one bar per transaction, on a shared time axis.
// Parallel bars = buyers ran at the same time; a staircase = they queued.
function Timeline({ race }) {
  const span = Math.max(race.durationMs, 1);
  return (
    <section>
      <div className="section-head">
        <h2>Timeline <span className="muted">(each bar is one transaction, 0 → {race.durationMs} ms)</span></h2>
        <div className="legend">
          {["bought", "sold_out", "retry", "error"].map((o) => (
            <span key={o}><span className={`swatch outcome-${o}`} /> {OUTCOME_LABEL[o]}</span>
          ))}
        </div>
      </div>
      <div className="lab-timeline">
        {race.rows.map((row) => (
          <div key={row.buyer} className="lab-lane">
            <span className="lab-buyer">Buyer {row.buyer}</span>
            <div className="lab-track">
              {row.tries.map((t, i) => (
                <span
                  key={i}
                  className={`lab-bar outcome-${t.outcome}`}
                  style={{
                    left: `${((t.startedAt - race.t0) / span) * 100}%`,
                    width: `max(3px, ${((t.finishedAt - t.startedAt) / span) * 100}%)`,
                  }}
                  title={`${OUTCOME_LABEL[t.outcome]} · ${t.startedAt - race.t0}–${t.finishedAt - race.t0} ms${t.error ? ` · ${t.error}` : ""}`}
                />
              ))}
            </div>
            <span className={`lab-outcome outcome-text-${row.final?.status}`}>
              {OUTCOME_LABEL[row.final?.status] ?? "?"}
              {row.final?.seen_stock != null && <span className="muted"> · saw {row.final.seen_stock}</span>}
              {row.final?.attempts > 1 && <span className="muted"> · ×{row.final.attempts}</span>}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function History({ history, onClear }) {
  return (
    <section>
      <div className="section-head">
        <h2>Runs <span className="muted">(newest first)</span></h2>
        <button className="link" onClick={onClear}>Clear</button>
      </div>
      <div className="qb-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Strategy</th>
              <th>Stock</th>
              <th>Buyers</th>
              <th>Think</th>
              <th>Orders</th>
              <th>Stock after</th>
              <th>Retries</th>
              <th>Took</th>
              <th>Correct?</th>
            </tr>
          </thead>
          <tbody>
            {history.map((r, i) => {
              const ok = r.orders <= r.initial && r.finalStock === r.initial - r.orders;
              return (
                <tr key={i}>
                  <td>{STRATEGIES[r.key].label}</td>
                  <td>{r.initial}</td>
                  <td>{r.rows.length}</td>
                  <td>{r.delay} ms</td>
                  <td>{r.orders}</td>
                  <td>{r.finalStock}</td>
                  <td>{r.retries}</td>
                  <td>{r.durationMs} ms</td>
                  <td className={ok ? "outcome-text-bought" : "outcome-text-error"}>{ok ? "✓ yes" : "✗ no"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
