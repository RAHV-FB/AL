import './ui/styles.css';
import { App } from './ui/app';

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');
(window as unknown as { app: App }).app = new App(root);
