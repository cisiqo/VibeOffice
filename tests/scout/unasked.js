// Before the page's own scripts (tools/shot.mjs --pre): a person's browser (not automated) where the user has
// neither shown nor hidden the assistant, and he has not greeted anyone today. The suite's settings are kept in
// sessionStorage and put back by the test's last step.
const SCOUT_KEYS = ['vibeoffice.assistant', 'scout.lastGreetedDay', 'scout.lastHiddenDay'];
Object.defineProperty(Navigator.prototype, 'webdriver', { configurable: true, get: () => false });
if (sessionStorage.getItem('scout.test.kept') == null) sessionStorage.setItem('scout.test.kept', JSON.stringify(SCOUT_KEYS.map((k) => localStorage.getItem(k))));
for (const k of SCOUT_KEYS) localStorage.removeItem(k);
