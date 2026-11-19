import { render } from 'preact';
import { registerSW } from 'virtual:pwa-register';
import { App } from './ui/App';
import { init } from './ui/store';
import { installAudioUnlock } from './ui/radarSound';
import './ui/theme.css';

render(<App />, document.getElementById('app')!);

registerSW({ immediate: true });
void init();
installAudioUnlock();
