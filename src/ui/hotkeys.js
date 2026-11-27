// Keyboard shortcuts. Free-fly mode owns W A S D Q E Shift, so none of those are used here.
const LIST = [['Space', 'Play / pause'], ['F', 'Fire the shot again'], ['Left / Right', 'Step 1 frame back / forward (Shift: 10 frames)'], ['Up / Down', 'Go to the previous / next camera key'], ['Home / End', 'Go to the start / end'], ['L', 'Loop on / off'],
  ['Ctrl/Cmd + Z', 'Undo'], ['Ctrl/Cmd + Shift + Z or Ctrl + Y', 'Redo'], ['B', 'Store look in slot B'], ['X', 'Flip between look A and B'], ['T', 'Layer timeline'], ['V', 'Title / action safe lines'], ['K or I', 'Set a camera key on this frame, from the view you see'], ['C', 'Switch Perspective (free) and Camera (shot) view'], ['1 / 2', 'Perspective view / Camera view (also the View menu in the viewport)'], ['Delete', 'Delete the selected camera key'], ['Esc', 'Deselect the key'], ['G', 'Preset gallery'], ['H', 'Hide / show the dial deck'], ['?', 'This list']];

export function buildHotkeys(app) {
  const help = document.createElement('div'); help.className = 'pyb-help';
  help.innerHTML = '<b>Keyboard shortcuts</b><br>' + LIST.map(([k, d]) => `<kbd>${k}</kbd> ${d}`).join('<br>');
  document.body.append(help);
  const typing = (t) => t && (/^(input|textarea|select)$/i.test(t.tagName) && t.type !== 'range' && t.type !== 'checkbox' || t.isContentEditable);
  addEventListener('keydown', (e) => {
    if (typing(e.target) || e.altKey) return;
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    if (k === ' ' && e.target.tagName === 'BUTTON') return;   // a focused button handles Space itself
    if (app.galleryOpen?.()) { if (k === 'Escape') app.closeGallery(); return; }
    if (mod) {
      if (k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? app.history.redo() : app.history.undo(); }
      else if (k.toLowerCase() === 'y') { e.preventDefault(); app.history.redo(); }
      return;
    }
    const dial = e.target.closest?.('.pyb-dial');
    if (app.exporting && !['?', 'Escape'].includes(k)) { if (k === ' ' || /^[fFlLbBxXtTgGhHvVkKcCiI12]$/.test(k) || k.startsWith('Arrow') || mod) app.notify('An export is running. Wait for it or cancel it.'); return; }
    let used = true;
    switch (k) {
      case ' ': app.togglePlay(); break;
      case 'f': case 'F': app.fire(); break;
      case 'ArrowLeft': if (dial) used = false; else app.stepFrames(e.shiftKey ? -10 : -1); break;
      case 'ArrowRight': if (dial) used = false; else app.stepFrames(e.shiftKey ? 10 : 1); break;
      case 'ArrowUp': app.camAnim?.gotoKey(-1); break;
      case 'ArrowDown': app.camAnim?.gotoKey(1); break;
      case 'Home': app.goStart(); break;
      case 'End': app.goEnd(); break;
      case 'Delete': case 'Backspace': used = !!app.camAnim?.deleteSelected(); break;
      case '1': app.camAnim?.setView('free'); break;
      case '2': app.camAnim?.setView('shot'); break;
      case 'l': case 'L': app.toggleLoop(); break;
      case 'b': case 'B': app.history.storeB(); break;
      case 'x': case 'X': app.history.flip(); break;
      case 't': case 'T': app.toggleTimeline(); break;
      case 'g': case 'G': app.openGallery(); break;
      case 'k': case 'K': case 'i': case 'I': app.camAnim?.keyCamera(); break;
      case 'c': case 'C': app.camAnim?.toggleView(); break;
      case 'v': case 'V': { const el = app.state.elements; el.safe = !el.safe; app.updateGui?.(); break; }
      case 'h': case 'H': document.querySelector('.pyb-deck-head button')?.click(); break;
      case '?': help.classList.toggle('open'); break;
      case 'Escape': help.classList.remove('open'); app.camAnim?.clearSelection(); used = false; break;
      default: used = false;
    }
    if (used) e.preventDefault();
  });
}
