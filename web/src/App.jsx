import { useCallback, useEffect, useState } from "react";
import { rpc, subscribe } from "./api.js";
import Jobs from "./Jobs.jsx";
import QueryBuilder from "./QueryBuilder.jsx";

const TOKEN_KEY = "dbdriven.token";

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState(null);
  const [tab, setTab] = useState("todos");

  function handleAuth({ token, user }) {
    localStorage.setItem(TOKEN_KEY, token);
    setToken(token);
    setUser(user);
  }

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setUser(null);
  }, []);

  // On page load, ask the DB who the stored token belongs to (and whether it's still valid).
  useEffect(() => {
    if (token && !user) rpc("me", {}, token).then(setUser).catch(logout);
  }, [token, user, logout]);

  if (!token) return <AuthForm onAuth={handleAuth} />;
  if (!user) return <main className="card">Loading…</main>;

  return (
    <main className={tab === "todos" ? "card" : "card wide"}>
      <header>
        <nav className="tabs">
          <button className={tab === "todos" ? "active" : ""} onClick={() => setTab("todos")}>Todos</button>
          <button className={tab === "jobs" ? "active" : ""} onClick={() => setTab("jobs")}>Jobs</button>
          <button className={tab === "query" ? "active" : ""} onClick={() => setTab("query")}>Query</button>
        </nav>
        <span>
          <span className="muted">{user.email}</span>
          <button className="link" onClick={logout}>Log out</button>
        </span>
      </header>
      {tab === "todos" && <Todos token={token} onUnauthorized={logout} />}
      {tab === "jobs" && <Jobs token={token} onUnauthorized={logout} />}
      {tab === "query" && <QueryBuilder token={token} onUnauthorized={logout} />}
    </main>
  );
}

function AuthForm({ onAuth }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    try {
      onAuth(await rpc(mode, { email, password })); // api.login or api.signup
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <main className="card">
      <h1>{mode === "login" ? "Log in" : "Sign up"}</h1>
      <form onSubmit={submit} className="stack">
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input type="password" placeholder="Password (8+ chars)" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <button type="submit">{mode === "login" ? "Log in" : "Create account"}</button>
      </form>
      {error && <p className="error">{error}</p>}
      <button className="link" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
        {mode === "login" ? "No account? Sign up" : "Have an account? Log in"}
      </button>
    </main>
  );
}

function Todos({ token, onUnauthorized }) {
  const [todos, setTodos] = useState([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState(null);

  // Wraps every DB call: shows the database's error message, logs out on 401.
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
    const list = await call("list_todos");
    if (list) setTodos(list);
  }, [call]);

  useEffect(() => {
    reload();
    // Open this app in two tabs: changes in one show up in the other.
    return subscribe(token, "todo", reload);
  }, [token, reload]);

  async function add(e) {
    e.preventDefault();
    if (await call("add_todo", { title })) setTitle("");
    // No local state update needed: the NOTIFY trigger -> SSE -> reload() handles it.
  }

  return (
    <>
      <form onSubmit={add} className="row">
        <input placeholder="What needs doing?" value={title} onChange={(e) => setTitle(e.target.value)} />
        <button type="submit">Add</button>
      </form>
      {error && <p className="error">{error}</p>}
      <ul className="todos">
        {todos.map((t) => (
          <li key={t.id} className={t.done ? "done" : ""}>
            <label>
              <input type="checkbox" checked={t.done} onChange={() => call("set_todo_done", { id: t.id, done: !t.done })} />
              {t.title}
            </label>
            <TodoTags todo={t} call={call} />
            <button className="link" onClick={() => call("delete_todo", { id: t.id })}>✕</button>
          </li>
        ))}
      </ul>
      {todos.length === 0 && <p className="muted">Nothing yet. Add your first todo.</p>}
    </>
  );
}

// Tag chips + an inline "+ tag" input. No local state for the tags themselves:
// the todo_tags NOTIFY trigger -> SSE -> reload() brings the new list.
function TodoTags({ todo, call }) {
  const [adding, setAdding] = useState(false);
  const [tag, setTag] = useState("");

  async function submit(e) {
    e.preventDefault();
    if (await call("tag_todo", { id: todo.id, tag })) {
      setTag("");
      setAdding(false);
    }
  }

  return (
    <span className="tags">
      {todo.tags.map((name) => (
        <span key={name} className="tag">
          #{name}
          <button className="link" title={`Remove #${name}`} onClick={() => call("untag_todo", { id: todo.id, tag: name })}>×</button>
        </span>
      ))}
      {adding ? (
        <form onSubmit={submit}>
          <input
            autoFocus
            placeholder="tag"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setAdding(false)}
            onBlur={() => !tag && setAdding(false)}
          />
        </form>
      ) : (
        <button className="link add-tag" onClick={() => setAdding(true)}>+ tag</button>
      )}
    </span>
  );
}
