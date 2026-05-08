import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <div>
      <h1>Hello from React via COS!</h1>
      <p>
        React and ReactDOM are managed by the Cross-Origin Storage plugin —
        they are bundled separately, hashed, and served from COS when available.
      </p>
      <button onClick={() => setCount((c) => c + 1)}>
        Clicked {count} {count === 1 ? 'time' : 'times'}
      </button>
    </div>
  );
}
