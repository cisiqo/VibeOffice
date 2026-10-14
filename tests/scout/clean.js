// Before the page's own scripts (tools/shot.mjs --pre): no assistant settings, whatever an earlier run left (a run cut
// short never puts them back). The suite's settings are kept in sessionStorage and put back by the test's last step.
const SCOUT_KEYS = ['vibeoffice.assistant', 'scout.lastGreetedDay', 'scout.lastHiddenDay'];
if (sessionStorage.getItem('scout.test.kept') == null) sessionStorage.setItem('scout.test.kept', JSON.stringify(SCOUT_KEYS.map((k) => localStorage.getItem(k))));
for (const k of SCOUT_KEYS) localStorage.removeItem(k);
