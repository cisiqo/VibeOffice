// Before the page's own scripts (tools/shot.mjs --pre, after unasked.js): he has greeted the user today already.
{ const d = new Date(); localStorage.setItem('scout.lastGreetedDay', d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')); }
