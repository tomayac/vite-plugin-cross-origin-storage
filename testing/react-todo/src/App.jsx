import { useState } from 'react';

export default function App() {
  const [items, setItems] = useState([
    { id: 1, text: 'Visit react-hello-world to seed COS', done: true },
    { id: 2, text: 'Open this app on a different port', done: true },
    { id: 3, text: 'Check DevTools console for "found in COS"', done: false },
  ]);
  const [draft, setDraft] = useState('');

  function toggle(id) {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, done: !item.done } : item))
    );
  }

  function add(e) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setItems((prev) => [...prev, { id: Date.now(), text, done: false }]);
    setDraft('');
  }

  function remove(id) {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }

  const remaining = items.filter((i) => !i.done).length;

  return (
    <div>
      <h1>COS Todo App</h1>
      <p>
        {remaining} of {items.length} remaining
      </p>
      <form onSubmit={add}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="New todo…"
        />
        <button type="submit">Add</button>
      </form>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <label>
              <input
                type="checkbox"
                checked={item.done}
                onChange={() => toggle(item.id)}
              />
              <span style={{ textDecoration: item.done ? 'line-through' : 'none' }}>
                {item.text}
              </span>
            </label>
            <button onClick={() => remove(item.id)}>×</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
