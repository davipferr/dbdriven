import { useCallback, useState } from "react";
import { rpc } from "./api.js";
import { race as runLanes, Tile, Timeline } from "./labShared.jsx";

// The five ways to move money (db/init/08_bank_transfer.sql).
// Every strategy has retry: true: a real client retries deadlocks (40P01) and
// serialization failures (40001), and here the gateway does it for us.
const STRATEGIES = {
  naive: {
    label: "Naive",
    fn: "lab_transfer_naive",
    isolation: "read committed",
    note: "Read both balances, think, write what you read ± the amount. Opposite transfers overwrite each other: the balances stop matching the transfers, and with 3+ accounts money appears or vanishes.",
    sql: `select balance into v_from_balance from app.lab_accounts where id = v_from;
select balance into v_to_balance   from app.lab_accounts where id = v_to;
perform pg_sleep(delay);
if v_from_balance < v_amount then return 'insufficient_funds'; end if;
update app.lab_accounts                     -- both rows, one statement
set balance = case id when v_from then v_from_balance - v_amount
                      else v_to_balance + v_amount end
where id in (v_from, v_to);`,
  },
  for_update: {
    label: "FOR UPDATE (from, then to)",
    fn: "lab_transfer_for_update",
    isolation: "read committed",
    note: "Lock the payer, think, lock the payee. Balances are always right, but Alice→Bob holds Alice and waits for Bob while Bob→Alice holds Bob and waits for Alice: a deadlock. Postgres kills one, the gateway retries it.",
    sql: `select balance into v_from_balance from app.lab_accounts
where id = v_from for update;               -- lock #1: FROM
perform pg_sleep(delay);                    -- holding #1
select balance into v_to_balance from app.lab_accounts
where id = v_to for update;                 -- lock #2: TO  <- deadlocks here
update ... balance = v_from_balance - v_amount where id = v_from;
update ... balance = v_to_balance + v_amount where id = v_to;`,
  },
  atomic: {
    label: "Atomic UPDATEs",
    fn: "lab_transfer_atomic",
    isolation: "read committed",
    note: "The flash-sale fix: no reads, just relative UPDATEs. No lost updates, but each UPDATE locks its row until COMMIT, and a transfer runs two of them in opposite orders: still deadlocks.",
    sql: `update app.lab_accounts set balance = balance - v_amount
where id = v_from and balance >= v_amount;  -- debit  = lock #1
perform pg_sleep(delay);                    -- e.g. a fraud check, holding #1
update app.lab_accounts set balance = balance + v_amount
where id = v_to;                            -- credit = lock #2  <- deadlocks here`,
  },
  ordered: {
    label: "Lock in id order",
    fn: "lab_transfer_ordered",
    isolation: "read committed",
    note: "The same two locks, but always the LOWER id first, whichever way the money goes. Opposite transfers now wait in one queue instead of forming a cycle: no deadlocks, ever.",
    sql: `perform 1 from app.lab_accounts
where id = least(v_from, v_to) for update;     -- lock #1: lower id
perform pg_sleep(delay);
perform 1 from app.lab_accounts
where id = greatest(v_from, v_to) for update;  -- lock #2: higher id
-- both locked: read, check, update freely
update ... balance = balance - v_amount where id = v_from;
update ... balance = balance + v_amount where id = v_to;`,
  },
  serializable: {
    label: "SERIALIZABLE + retry",
    fn: "lab_transfer_naive",
    isolation: "serializable",
    note: "The NAIVE function, unchanged, at SERIALIZABLE isolation. Postgres aborts whichever transfer would break a one-at-a-time order (40001), and the gateway retries it.",
    sql: `begin isolation level serializable;   -- the only change
select api.lab_transfer_naive(...);
-- ERROR 40001: could not serialize access due to concurrent update
-- -> the gateway runs the whole transaction again`,
  },
};

export default function BankTransfer({ token, onUnauthorized }) {
  const [strategy, setStrategy] = useState("naive");
  const [accounts, setAccounts] = useState(3);
  const [balance, setBalance] = useState(100);
  const [transfers, setTransfers] = useState(10);
  const [amount, setAmount] = useState(30);
  const [delay, setDelay] = useState(100);
  const [running, setRunning] = useState(false);
  const [race, setRace] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState(null);

  const runRace = useCallback(
    async (key) => {
      const s = STRATEGIES[key];
      const opened = await rpc("lab_bank_reset", { accounts: Number(accounts), balance: Number(balance) }, token);
      const n = Math.min(Math.max(Number(transfers), 1), 20);
      // Transfer i goes from account i to the next one, round the circle:
      // 2 accounts: Alice→Bob, Bob→Alice, ...  3: Alice→Bob, Bob→Carol, Carol→Alice, ...
      const lanes = Array.from({ length: n }, (_, i) => {
        const from = opened[i % opened.length];
        const to = opened[(i + 1) % opened.length];
        return {
          id: i + 1,
          label: `#${i + 1} ${from.name} → ${to.name}`,
          call: {
            fn: s.fn,
            isolation: s.isolation,
            retry: true,
            args: { from: from.id, to: to.id, amount: Number(amount), delay_ms: Number(delay), transfer: i + 1, strategy: key },
          },
        };
      });
      const result = await runLanes(lanes, token);
      const state = await rpc("lab_bank_state", {}, token);
      return { key, delay: Number(delay), amount: Number(amount), ...result, state };
    },
    [token, accounts, balance, transfers, amount, delay],
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
        <h2>Bank transfer <span className="muted">({transfers} transfers of {amount} between {accounts} accounts, all at the same moment)</span></h2>
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
            Accounts
            <input type="number" min="2" max="4" value={accounts} onChange={(e) => setAccounts(e.target.value)} />
          </label>
          <label>
            Balance
            <input type="number" min="0" max="100000" value={balance} onChange={(e) => setBalance(e.target.value)} />
          </label>
          <label>
            Transfers
            <input type="number" min="1" max="20" value={transfers} onChange={(e) => setTransfers(e.target.value)} />
          </label>
          <label>
            Amount
            <input type="number" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} />
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
            Transfer <i>i</i> pays the next account round the circle: with 2 accounts that's Alice → Bob and
            Bob → Alice over and over; with 3 it's Alice → Bob → Carol → Alice. Raise the amount to see
            "insufficient funds".
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
          wideLabels
          legend={["transferred", "insufficient_funds", "deadlock", "conflict", "error"]}
          detail={(row) => row.final.seen_balance != null && <span className="muted"> · saw {row.final.seen_balance}</span>}
        />
      )}
      {history.length > 0 && <History history={history} onClear={() => setHistory([])} />}
    </>
  );
}

// The two checks a bank cares about: money is never made or lost, and every
// balance is exactly what its recorded transfers say it should be.
function check(state) {
  const before = state.accounts.reduce((sum, a) => sum + a.initial, 0);
  const after = state.accounts.reduce((sum, a) => sum + a.balance, 0);
  const wrong = state.accounts.filter((a) => a.balance !== a.expected);
  return { before, after, wrong, ok: before === after && wrong.length === 0 };
}

function Verdict({ race }) {
  const { state } = race;
  const { before, after, wrong, ok } = check(state);
  const diff = after - before;

  return (
    <div className="lab-verdict">
      <h3>{STRATEGIES[race.key].label} <span className="muted">· result</span></h3>
      <div className="tiles">
        <Tile label="Money before" value={before} />
        <Tile label="Money after" value={after} bad={diff !== 0} />
        <Tile label="Transfers recorded" value={state.transfers} />
        <Tile label="Deadlocks" value={race.deadlocks} />
        <Tile label="Took" value={`${race.durationMs} ms`} />
      </div>

      <table className="table lab-accounts">
        <thead>
          <tr>
            <th>Account</th>
            <th>Started with</th>
            <th>Balance now</th>
            <th>Should be <span className="muted">(from its transfers)</span></th>
          </tr>
        </thead>
        <tbody>
          {state.accounts.map((a) => (
            <tr key={a.id} className={a.balance !== a.expected ? "wrong" : ""}>
              <td>{a.name}</td>
              <td>{a.initial}</td>
              <td>{a.balance}</td>
              <td>{a.expected}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className={ok ? "verdict good" : "verdict bad"}>
        {ok ? (
          <>✓ Correct: every balance matches its transfers, and the total is still {before}.</>
        ) : (
          <>
            ✗ {diff !== 0 && <>{Math.abs(diff)} {diff > 0 ? "appeared out of nowhere" : "vanished"}: the total went from {before} to {after}. </>}
            {wrong.length > 0 && (
              <>
                {wrong.map((a) => `${a.name} has ${a.balance} but should have ${a.expected}`).join("; ")}: transfers
                overwrote each other (lost updates).
              </>
            )}
          </>
        )}
        {race.deadlocks > 0 && (
          <>
            {" "}{race.deadlocks} deadlock{race.deadlocks === 1 ? "" : "s"}: each time, Postgres waited{" "}
            <code>deadlock_timeout</code> ({state.deadlock_timeout}), killed one transaction of the cycle, and the
            gateway retried it.
          </>
        )}
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
              <th>Accounts</th>
              <th>Transfers</th>
              <th>Think</th>
              <th>Money before → after</th>
              <th>Deadlocks</th>
              <th>Retries</th>
              <th>Took</th>
              <th>Correct?</th>
            </tr>
          </thead>
          <tbody>
            {history.map((r, i) => {
              const { before, after, ok } = check(r.state);
              return (
                <tr key={i}>
                  <td>{STRATEGIES[r.key].label}</td>
                  <td>{r.state.accounts.length}</td>
                  <td>{r.rows.length}</td>
                  <td>{r.delay} ms</td>
                  <td>{before} → {after}</td>
                  <td>{r.deadlocks}</td>
                  <td>{r.retries}</td>
                  <td>{r.durationMs} ms</td>
                  <td className={ok ? "outcome-text-transferred" : "outcome-text-error"}>{ok ? "✓ yes" : "✗ no"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
