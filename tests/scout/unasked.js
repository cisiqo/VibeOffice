// Before the page's own scripts (tools/shot.mjs --pre), after clean.js: a person's browser (not automated).
Object.defineProperty(Navigator.prototype, 'webdriver', { configurable: true, get: () => false });
