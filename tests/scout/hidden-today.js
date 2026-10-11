// Before the page's own scripts (tools/shot.mjs --pre, after unasked.js): the user hid the assistant today.
{ const d = new Date(); localStorage.setItem('scout.lastHiddenDay', d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')); }
