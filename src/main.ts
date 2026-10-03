import './style.css';
import { renderShell } from './app-shell.ts';
import { refreshIcons } from './icons.ts';
import { SOURCE_URL } from './site.ts';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = renderShell(SOURCE_URL);

function showRoute() {
  const route = location.hash.slice(1);
  const about = route === 'about';
  document.querySelector<HTMLElement>('#tools-view')!.hidden = about;
  document.querySelector<HTMLElement>('#about-view')!.hidden = !about;
  document.querySelector('#tools-nav')!.classList.toggle('active', !about);
  document.querySelector('#about-nav')!.classList.toggle('active', about);
  const explore = route === 'explore';
  const compact = document.querySelector('#explore-workspace')!.classList.contains('is-compact');
  document.querySelector('#main')!.classList.toggle('exploring', explore && !about && compact);
  for (const name of ['download', 'explore']) {
    const selected = (name === 'explore') === explore;
    const button = document.querySelector<HTMLButtonElement>(`#${name}-tab`)!;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    document.querySelector<HTMLElement>(`#${name}-panel`)!.hidden = !selected;
  }
}
for (const name of ['download', 'explore']) {
  document.querySelector(`#${name}-tab`)!.addEventListener('click', () => {
    location.hash = name;
  });
  document.querySelector(`#${name}-tab`)!.addEventListener('keydown', (e) => {
    const event = e as KeyboardEvent;
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? 'download'
          : event.key === 'End'
            ? 'explore'
            : name === 'download'
              ? 'explore'
              : 'download';
      location.hash = next;
      document.querySelector<HTMLButtonElement>(`#${next}-tab`)!.focus();
    }
  });
}
window.addEventListener('hashchange', showRoute);
showRoute();
refreshIcons();

void import('./ui').then(({ initializeTools }) => initializeTools());
