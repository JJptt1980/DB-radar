import { render } from 'preact';
import { registerSW } from 'virtual:pwa-register';
import { App } from './ui/App';
import './ui/theme.css';

render(<App />, document.getElementById('app')!);

registerSW({ immediate: true });
