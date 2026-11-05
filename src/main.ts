import './ui/styles.css';
import { App } from './ui/app';

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');
try {
  (window as unknown as { app: App }).app = new App(root);
} catch (err) {
  console.error(err);
  const box = document.createElement('div');
  box.className = 'boot-error';
  const card = document.createElement('div');
  const h1 = document.createElement('h1');
  h1.textContent = 'Artificial Life failed to start';
  const pre = document.createElement('pre');
  pre.textContent = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
  card.append(h1, pre);
  box.append(card);
  root.replaceChildren(box);
}
