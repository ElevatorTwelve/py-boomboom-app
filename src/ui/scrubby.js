// Drag a number's name to change the number (like an animation program): drag right or up to raise it, left or down to lower it.
// Shift = fine, Ctrl or Cmd = coarse. A click without movement does nothing. Works for every number row of the panel, also rows built later.
const MOVE_MIN = 3;   // px before a press counts as a drag

export function enableScrubbing(gui) {
  const numberRow = (el) => gui.controllersRecursive().find((c) => c.$input && c.domElement.contains(el) && typeof c.getValue() === 'number');
  let drag = null;
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const name = e.target.closest?.('.lil-controller.lil-number .lil-name'); if (!name) return;
    const c = numberRow(name); if (!c) return;
    const min = Number.isFinite(c._min) ? c._min : -Infinity, max = Number.isFinite(c._max) ? c._max : Infinity, step = c._step || 0.01;
    drag = { c, x0: e.clientX, y0: e.clientY, v0: c.getValue(), min, max, step, moved: false, last: null };
    e.preventDefault();
  }, true);
  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0, px = dx - dy;
    if (!drag.moved) { if (Math.hypot(dx, dy) < MOVE_MIN) return; drag.moved = true; document.body.classList.add('pyb-scrubbing'); }
    const range = drag.max - drag.min, v0 = drag.v0;
    let rate = Math.min(Number.isFinite(range) ? range / 300 : Infinity, Math.max(drag.step * 2, Math.abs(v0) * 0.01));
    if (!Number.isFinite(rate)) rate = Math.max(drag.step * 2, Math.abs(v0) * 0.01);
    rate *= e.shiftKey ? 0.1 : (e.ctrlKey || e.metaKey) ? 5 : 1;
    const v = v0 + px * rate;
    drag.c.setValue(v); drag.last = true;
  }, true);
  const end = () => {
    if (!drag) return;
    const d = drag; drag = null; document.body.classList.remove('pyb-scrubbing');
    if (d.moved) d.c._callOnFinishChange?.();
  };
  document.addEventListener('pointerup', end, true); document.addEventListener('pointercancel', end, true);
}
