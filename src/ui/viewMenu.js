// View menu in the viewport (top, left of the panel): the Camera view (the shot camera), the free Perspective view, and the built-in views.
// A built-in view puts the free camera at that place and leaves the Camera view, so your camera keys stay as they are.
import { state, VIEWS } from '../state.js';

export function buildViewMenu(app) {
  const wrap = document.createElement('label'); wrap.className = 'pyb-view';
  const cap = document.createElement('span'); cap.textContent = 'View';
  const sel = document.createElement('select'); sel.setAttribute('aria-label', 'Viewport view');
  const add = (parent, value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; parent.append(o); };
  add(sel, 'shot', 'Camera (shot camera, key 2)');
  add(sel, 'free', 'Perspective (free, key 1)');
  const g = document.createElement('optgroup'); g.label = 'Built-in views';
  for (const name of Object.keys(VIEWS)) add(g, 'v:' + name, name);
  sel.append(g);
  wrap.append(cap, sel); document.body.append(wrap);

  let builtin = null;   // the built-in view the free camera was last put on, until you move it
  const sync = () => { sel.value = state.camera.view === 'shot' ? 'shot' : builtin ? 'v:' + builtin : 'free'; };
  const choose = (v) => {
    if (v === 'shot') { builtin = null; app.camAnim.setView('shot'); }
    else if (v === 'free') { builtin = null; app.camAnim.setView('free'); }
    else { const name = v.replace(/^v:/, ''); app.camAnim.setView('free'); app.rig.apply(VIEWS[name]); builtin = name; }
    sync();
  };
  sel.addEventListener('change', () => { choose(sel.value); sel.blur(); });
  app.viewMenu = { sync, choose, chooseBuiltin: (name) => choose('v:' + name), moved: () => { if (builtin) { builtin = null; sync(); } }, options: () => [...sel.options].map((o) => o.value) };
  return app.viewMenu;
}
