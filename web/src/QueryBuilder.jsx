import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "./api.js";
import { NO_VALUE_OPS, queryToSql } from "./queryToSql.js";

// The query is DATA (an AST). Every control below just edits this object;
// the SQL preview and the request to api.run_query are both derived from it.
const INITIAL_QUERY = {
  from: "todos",
  select: ["id", "title", "done", "created_at"],
  where: [],
  orderBy: { column: "created_at", dir: "desc" },
  limit: 20,
};

// Hand-written ASTs that skip the builder's dropdowns, like an attacker using
// curl would. The server's whitelist (or %L quoting) has to handle each one.
const ATTACKS = [
  {
    name: "Inject through a column name",
    query: { select: ["title; drop table app.todos"] },
  },
  {
    name: "Read password hashes",
    query: { from: "users", select: ["email", "password_hash"] },
  },
  {
    name: "Inject through the operator",
    query: { where: [{ column: "done", op: "= true or 1=1 --", value: "x" }] },
  },
  {
    name: "Inject through a value",
    query: { where: [{ column: "title", op: "=", value: "x'; delete from app.todos; --" }] },
  },
  {
    name: "Inject through the sort direction",
    query: { orderBy: { column: "id", dir: "desc; drop table app.todos" } },
  },
  {
    name: "Ask for a million rows",
    query: { limit: 1000000 },
  },
];

export default function QueryBuilder({ token, onUnauthorized }) {
  const [schema, setSchema] = useState(null);
  const [query, setQuery] = useState(INITIAL_QUERY);
  const [result, setResult] = useState(null); // { sql, rows, columns } | { error }
  const [running, setRunning] = useState(false);
  const latest = useRef(0); // ignore responses that arrive after a newer request

  const run = useCallback(
    async (q) => {
      const id = ++latest.current;
      setRunning(true);
      try {
        const res = await rpc("run_query", q, token);
        // jsonb sorts object keys, so remember the SELECT order for the table header.
        const columns = q.select?.length ? q.select : schema.columns.map((c) => c.name);
        if (id === latest.current) setResult({ ...res, columns });
      } catch (err) {
        if (err.status === 401) return onUnauthorized();
        if (id === latest.current) setResult({ error: err.message });
      } finally {
        if (id === latest.current) setRunning(false);
      }
    },
    [token, onUnauthorized, schema],
  );

  // The whitelist lives in the database (api.query_schema). The dropdowns come
  // from it, so they always offer exactly what api.run_query will accept.
  useEffect(() => {
    rpc("query_schema", {}, token)
      .then(setSchema)
      .catch((err) => (err.status === 401 ? onUnauthorized() : setResult({ error: err.message })));
  }, [token, onUnauthorized]);

  const incomplete = query.where.some((f) => !NO_VALUE_OPS.includes(f.op) && f.value === "");

  // Live results: re-run shortly after every edit, once the query is complete.
  useEffect(() => {
    if (!schema || incomplete) return;
    const timer = setTimeout(() => run(query), 300);
    return () => clearTimeout(timer);
  }, [schema, query, incomplete, run]);

  if (!schema) return <p className="muted">{result?.error ?? "Loading…"}</p>;

  const set = (patch) => setQuery((q) => ({ ...q, ...patch }));

  return (
    <div className="qb">
      <div className="qb-top">
        <Builder schema={schema} query={query} set={set} />
        <div className="qb-code">
          <section>
            <h2>SQL preview <span className="muted">(built in your browser, never executed)</span></h2>
            <pre className="sql">{queryToSql(query, schema)}</pre>
          </section>
          <section>
            <h2>What gets sent: <code>POST /api/rpc/run_query</code></h2>
            <pre>{JSON.stringify(query, null, 2)}</pre>
          </section>
        </div>
      </div>

      <section>
        <div className="section-head">
          <h2>
            Results {result?.rows && <span className="muted">· {result.rows.length} rows</span>}
            {running && <span className="muted"> · running…</span>}
          </h2>
          <button onClick={() => run(query)} disabled={incomplete}>Run</button>
        </div>
        {incomplete && <p className="muted">Fill in every filter value to run the query.</p>}
        {result?.error && <p className="error">{result.error}</p>}
        {result?.sql && (
          <p className="qb-server-sql">
            <span className="muted">Postgres executed (rebuilt from the JSON by <code>api.run_query</code>, then RLS added your <code>user_id</code>):</span>
            <code>{result.sql}</code>
          </p>
        )}
        {result?.rows && <ResultsTable rows={result.rows} columns={result.columns} />}
      </section>

      <Attacks token={token} onUnauthorized={onUnauthorized} />
    </div>
  );
}

function Builder({ schema, query, set }) {
  const columns = schema.columns;
  const byName = Object.fromEntries(columns.map((c) => [c.name, c]));
  const defaultValue = (col) => (col.type === "boolean" ? "false" : "");

  function toggleColumn(name) {
    const picked = query.select.includes(name) ? query.select.filter((c) => c !== name) : [...query.select, name];
    // Keep the schema's column order, so the SELECT list doesn't depend on click order.
    set({ select: columns.map((c) => c.name).filter((c) => picked.includes(c)) });
  }

  function updateFilter(i, patch) {
    set({ where: query.where.map((f, j) => (j === i ? toFilter({ ...f, ...patch }) : f)) });
  }

  // Normalizes a filter after an edit: a new column may not support the old
  // operator, and IS NULL takes no value.
  function toFilter({ column, op, value }) {
    const col = byName[column];
    if (!col.ops.includes(op)) op = col.ops[0];
    if (NO_VALUE_OPS.includes(op)) return { column, op };
    return { column, op, value: value ?? defaultValue(col) };
  }

  function addFilter() {
    const col = columns.find((c) => c.name === "done") ?? columns[0];
    set({ where: [...query.where, { column: col.name, op: col.ops[0], value: defaultValue(col) }] });
  }

  return (
    <div className="qb-builder">
      <section>
        <h3>From</h3>
        <select value={query.from} disabled>
          <option value={schema.table}>app.{schema.table}</option>
        </select>
      </section>

      <section>
        <h3>Select <span className="muted">(none = all)</span></h3>
        <div className="qb-columns">
          {columns.map((c) => (
            <label key={c.name} className={query.select.includes(c.name) ? "chip active" : "chip"}>
              <input type="checkbox" checked={query.select.includes(c.name)} onChange={() => toggleColumn(c.name)} />
              {c.name}
            </label>
          ))}
        </div>
      </section>

      <section>
        <h3>Where <span className="muted">(all must match)</span></h3>
        {query.where.map((f, i) => (
          <div key={i} className="qb-filter">
            <select
              value={f.column}
              onChange={(e) => updateFilter(i, { column: e.target.value, value: defaultValue(byName[e.target.value]) })}
            >
              {columns.map((c) => <option key={c.name}>{c.name}</option>)}
            </select>
            <select value={f.op} onChange={(e) => updateFilter(i, { op: e.target.value })}>
              {byName[f.column].ops.map((op) => <option key={op}>{op}</option>)}
            </select>
            {!NO_VALUE_OPS.includes(f.op) && (
              <ValueInput type={byName[f.column].type} op={f.op} value={f.value} onChange={(value) => updateFilter(i, { value })} />
            )}
            <button className="link" title="Remove filter" onClick={() => set({ where: query.where.filter((_, j) => j !== i) })}>✕</button>
          </div>
        ))}
        <button className="link" onClick={addFilter}>+ Add filter</button>
      </section>

      <section className="qb-inline">
        <div>
          <h3>Order by</h3>
          <select
            value={query.orderBy?.column ?? ""}
            onChange={(e) => set({ orderBy: e.target.value ? { column: e.target.value, dir: query.orderBy?.dir ?? "asc" } : null })}
          >
            <option value="">(none)</option>
            {columns.map((c) => <option key={c.name}>{c.name}</option>)}
          </select>
          {query.orderBy && (
            <select value={query.orderBy.dir} onChange={(e) => set({ orderBy: { ...query.orderBy, dir: e.target.value } })}>
              <option value="asc">ascending</option>
              <option value="desc">descending</option>
            </select>
          )}
        </div>
        <div>
          <h3>Limit</h3>
          <input
            type="number" min="1" max={schema.maxLimit} value={query.limit}
            onChange={(e) => set({ limit: e.target.value === "" ? null : Number(e.target.value) })}
          />
        </div>
      </section>
    </div>
  );
}

// Values are always strings in the AST; Postgres casts them to the column type.
function ValueInput({ type, op, value, onChange }) {
  if (type === "boolean") {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option>false</option>
        <option>true</option>
      </select>
    );
  }
  if (type === "bigint") return <input type="number" value={value} onChange={(e) => onChange(e.target.value)} />;
  if (type === "timestamptz") return <input type="date" value={value} onChange={(e) => onChange(e.target.value)} />;
  return (
    <input
      value={value}
      placeholder={op.includes("ilike") ? "%buy%  (% = anything)" : "exact text"}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function ResultsTable({ rows, columns }) {
  if (rows.length === 0) return <p className="muted">No rows match.</p>;
  return (
    <div className="qb-results">
      <table className="table">
        <thead>
          <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.id ?? i}>
              {columns.map((c) => <td key={c}>{formatCell(row[c])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(value) {
  if (value === null) return <span className="muted">null</span>;
  if (typeof value === "boolean") return <code>{String(value)}</code>;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(value).toLocaleString();
  return String(value);
}

// Sends each hostile AST straight to the server and shows what happened.
function Attacks({ token, onUnauthorized }) {
  const [outcomes, setOutcomes] = useState({});

  async function attack(a) {
    try {
      const res = await rpc("run_query", a.query, token);
      setOutcomes((o) => ({ ...o, [a.name]: { ok: true, text: `Ran safely, ${res.rows.length} rows: ${res.sql}` } }));
    } catch (err) {
      if (err.status === 401) return onUnauthorized();
      setOutcomes((o) => ({ ...o, [a.name]: { ok: false, text: `Rejected (${err.status}): ${err.message}` } }));
    }
  }

  return (
    <section>
      <div className="section-head">
        <h2>Try to break it</h2>
        <button className="link" onClick={() => ATTACKS.forEach(attack)}>Run all</button>
      </div>
      <p className="muted">
        These skip the dropdowns and send hand-written JSON, like an attacker with curl would.
      </p>
      <table className="table qb-attacks">
        <thead>
          <tr><th>Attack</th><th>JSON sent</th><th>What the database did</th></tr>
        </thead>
        <tbody>
          {ATTACKS.map((a) => (
            <tr key={a.name}>
              <td><button className="link" onClick={() => attack(a)}>{a.name}</button></td>
              <td><code>{JSON.stringify(a.query)}</code></td>
              <td className={outcomes[a.name] ? (outcomes[a.name].ok ? "" : "error-text") : "muted"}>
                {outcomes[a.name]?.text ?? "not run yet"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
