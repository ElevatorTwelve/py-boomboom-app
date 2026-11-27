// One column at the bottom of the screen that holds the timeline, the dial deck and the bar, so they never overlap.
export function dock() {
  let d = document.querySelector('.pyb-dock');
  if (!d) { d = document.createElement('div'); d.className = 'pyb-dock'; document.body.append(d); }
  return d;
}
