import { START_VALUE } from './constants.js';

export function setupCounter(element) {
  let counter = START_VALUE;
  const setCounter = (count) => {
    counter = count;
    element.innerHTML = `count is ${counter}`;
  };
  element.addEventListener('click', () => setCounter(counter + 1));
  setCounter(START_VALUE);
}
