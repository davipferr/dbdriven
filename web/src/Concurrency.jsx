import { useCallback, useState } from "react";
import { rpc } from "./api.js";
import BankTransfer from "./BankTransfer.jsx";
import { race as runLanes, Tile, Timeline } from "./labShared.jsx";

// Two scenarios, kept mounted so each keeps its own run history.
export default function Concurrency(props) {
  const [scenario, setScenario] = useState("flash");
  return (
    <div className="lab">
      <div className="filters">
        <button className={scenario === "flash" ? "chip active" : "chip"} onClick={() => setScenario("flash")}>
          Flash sale <span className="chip-note">· 1 row</span>
        </button>
        <button className={scenario === "bank" ? "chip active" : "chip"} onClick={() => setScenario("bank")}>
          Bank transfer <span className="chip-note">· 2 rows, deadlocks</span>
        </button>
      </div>
      <div className="lab" hidden={scenario !== "flash"}><FlashSale {...props} /></div>
      <div className="lab" hidden={scenario !== "bank"}><BankTransfer {...props} /></div>
    </div>
  );
}

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
    note: "Think without holding locks; write only if the version is unchanged. 0 rows updated means someone beat you: the function raises 40001 and the gateway retries in a new transaction.",
    sql: `select stock, version into v_stock, v_version from app.lab_products where id = v_id;
perform pg_sleep(delay);            -- no locks held while thinking
if v_stock <= 0 then return 'sold_out'; end if;
update app.lab_products set stock = v_stock - 1, version = v_version + 1
where id = v_id and version = v_version;   -- 0 rows if someone beat us
if not found then raise exception '...' using errcode = '40001'; end if;
-- -> the gateway retries the whole transaction`,
  },
  serializable: {
    label: "SERIALIZABLE + retry",
    fn: "lab_buy_naive",
    isolation: "serializable",
    retry: true,
    note: "The NAIVE function, unchanged, at SERIALIZABLE isolation. Postgres aborts the losers with 40001, and the gateway retries them in a new transaction.",
    sql: `begin isolation level serializable;   -- the only change
select api.lab_buy_naive(...);
-- ERROR 40001: could not serialize access due to concurrent update
-- -> the gateway runs the whole transaction again`,
  },
};

function FlashSale({ token, onUnauthorized }) {
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
      const lanes = Array.from({ length: n }, (_, i) => ({
        id: i + 1,
        label: `Buyer ${i + 1}`,
        call: {
          fn: s.fn,
          isolation: s.isolation,
          retry: s.retry, // the gateway re-runs it on 40001 / 40P01
          args: { product_id: product.id, buyer: i + 1, delay_ms: Number(delay), strategy: key },
        },
      }));
      const result = await runLanes(lanes, token);

      const state = await rpc("lab_state", {}, token);
      return {
        key,
        delay: Number(delay),
        ...result,
        initial: state.product.initial_stock,
        finalStock: state.product.stock,
        orders: state.orders.length,
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
    <>
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

      {race && (
        <Timeline
          race={race}
          legend={["bought", "sold_out", "conflict", "error"]}
          detail={(row) => row.final.seen_stock != null && <span className="muted"> · saw {row.final.seen_stock}</span>}
        />
      )}
      {history.length > 0 && <History history={history} onClear={() => setHistory([])} />}
    </>
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
