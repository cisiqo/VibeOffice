// Every piece of editable text on the page maps to a place in the document and back (the class of fault behind the
// diagram labels that took no caret: text shown and editable that the document's index didn't know). Page-side
// sweeps per app, run with t.evaluate(SWEEP.quire); each returns { nodes, kinds, findings: [{ kind, what, text }] }.
//
// Quire, for every text node the user can edit (inside the editable page, shown):
// - orphan: it is in no paragraph fragment (.p[data-pid]), so a click there maps nowhere;
// - unindexed: its fragment's paragraph is not in the document's index (D.byId), so it maps nowhere;
// - unmapped: a point in its middle maps to no position (LY.domToPos);
// - roundtrip: that position maps back (LY.posToDom) to another point, which maps to another position;
// - text: a run's text on screen differs from the model's text at its offsets.
// `kinds` counts the nodes by where they are (body, cell, text box, group, header, footnote, …).

export const SWEEP = {
  quire: `(() => {
    const D = L.D, LY = L.layout, d = D.doc, out = [], kinds = {};
    const where = (e) => e.closest('.shp.sgrp') ? 'group' : e.closest('.tbx') ? 'textbox' : e.closest('.pg-hdr') ? 'header' : e.closest('.pg-ftr') ? 'footer'
      : e.closest('.fn-area, .notes, [data-note]') ? 'note' : e.closest('td') ? 'cell' : e.closest('.cmt, .balloon') ? 'comment' : 'body';
    const say = (kind, e, text, what) => { if (out.length < 60) out.push({ kind, where: where(e), what, text: String(text).slice(0, 40) }); };
    const walker = document.createTreeWalker(LY.root, NodeFilter.SHOW_TEXT);
    let n, nodes = 0;
    while ((n = walker.nextNode())) {
      const e = n.parentElement;
      if (!e || !e.isContentEditable || !n.data.replace(/[\\u200b\\ufeff]/g, '').trim()) continue;
      if (!e.getClientRects().length) continue;
      nodes++;
      const k = where(e); kinds[k] = (kinds[k] || 0) + 1;
      const frag = e.closest('.p[data-pid]');
      if (!frag) { say('orphan', e, n.data, e.className); continue; }
      const p = D.byId(d, +frag.dataset.pid);
      if (!p) { say('unindexed', e, n.data, 'pid ' + frag.dataset.pid); continue; }
      const mid = Math.floor(n.length / 2);
      const pos = LY.domToPos(n, mid);
      if (!pos) { say('unmapped', e, n.data, 'pid ' + frag.dataset.pid); continue; }
      const back = LY.posToDom(pos);
      const again = back && LY.domToPos(back.node, back.offset);
      if (!again || again.p !== pos.p || again.o !== pos.o) say('roundtrip', e, n.data, JSON.stringify([pos.o, again && again.o, again && again.p === pos.p]));
      if (e.dataset.o != null && e.dataset.n != null && e.contentEditable !== 'false') {
        const model = D.ptext(p).slice(+e.dataset.o, +e.dataset.o + +e.dataset.n), shown = e.textContent;
        const norm = (s) => s.replace(/[\\u00a0\\u202f]/g, ' ').replace(/[\\u200b\\ufeff\\u00ad]/g, '');
        if (norm(model) !== norm(shown)) say('text', e, shown, 'model ' + JSON.stringify(model.slice(0, 40)));
      }
    }
    return { nodes, kinds, findings: out };
  })()`,
  /* Lectern, on each slide (up to 12), for every shape with text (text boxes, AutoShapes, placeholders, each table cell,
     each shape of a group or diagram): its text is edited (TE.begin) and every text node of the editing root is
     checked as in Quire: noedit (the edit doesn't start), unmapped, roundtrip, text (the character at the point
     differs from the model's); orphan: text on the slide in no shape's text (charts and WordArt, drawn, excepted). */
  lectern: `(async () => {
    const E = L.ed, TE = L.te, T = L.txt, out = [], kinds = {};
    let nodes = 0;
    const say = (kind, where, text, what) => { if (out.length < 60) out.push({ kind, where, what, text: String(text).slice(0, 40) }); };
    const tick = () => new Promise((r) => setTimeout(r, 0));
    for (let si = 0; si < Math.min(12, L.pres.slides.length); si++) {
      E.goto(si); await tick();
      const list = [];
      const rec = (shapes, parent) => { for (const sh of shapes || []) { if (sh.type === 'group') { rec(sh.kids || sh.shapes, sh); continue; }
        const where = parent ? (parent.sa ? 'diagram' : 'group') : sh.type === 'table' ? 'cell' : sh.ph ? 'placeholder' : sh.type === 'text' ? 'textbox' : 'shape';
        if (sh.type === 'table') sh.tbl.rows.forEach((row, r) => row.cells.forEach((c, ci) => {
          /* a cell covered by a merge isn't shown (PowerPoint hides its text too) */
          if (c.tx && T.plain(c.tx).trim() && E.elOf(sh.id) && E.elOf(sh.id).querySelector('td[data-r="' + r + '"][data-c="' + ci + '"]')) list.push({ id: sh.id, cell: [r, ci], where }); }));
        else if (sh.tx && T.plain(sh.tx).trim() && (sh.type === 'text' || sh.type === 'shape')) list.push({ id: sh.id, where }); } };
      rec(E.slide().shapes, null);
      for (const it of list) {
        try { TE.begin(it.id, it.cell ? { cell: it.cell } : {}); } catch (e) { say('noedit', it.where, it.id, String(e)); continue; }
        await tick();
        if (!TE.state) { say('noedit', it.where, it.id, ''); continue; }
        const root = TE.state.root, tx = TE.target().tx;
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n;
        while ((n = w.nextNode())) {
          if (!n.data.replace(/[\u200b\ufeff]/g, '').trim() || !n.parentElement.getClientRects().length) continue;
          nodes++; kinds[it.where] = (kinds[it.where] || 0) + 1;
          const mid = Math.floor(n.length / 2), s = getSelection(); s.removeAllRanges(); const r = document.createRange(); r.setStart(n, mid); r.collapse(true); s.addRange(r);
          const a = TE.getSel(root);
          if (!a) { say('unmapped', it.where, n.data, it.id); continue; }
          TE.setSel({ p0: a.p0, o0: a.o0, p1: a.p0, o1: a.o0 }, root);
          const b = TE.getSel(root);
          if (!b || b.p0 !== a.p0 || b.o0 !== a.o0) say('roundtrip', it.where, n.data, JSON.stringify([a, b]));
          const para = tx.ps[a.p0], ch = para ? T.paraText(para)[a.o0] : undefined, want = n.data[mid];
          if (want && want.trim() && ch !== want && !(ch === ' ' && /\\s/.test(want))) say('text', it.where, n.data, 'model ' + JSON.stringify(para ? T.paraText(para).slice(Math.max(0, a.o0 - 5), a.o0 + 5) : null) + ' at ' + a.p0 + ':' + a.o0);
        }
        TE.end(); await tick();
      }
      const w = document.createTreeWalker(E.host, NodeFilter.SHOW_TEXT); let n;
      while ((n = w.nextNode())) { const e = n.parentElement; if (!n.data.trim() || !e.getClientRects().length || e.closest('svg, .txi, .ed-overlay')) continue; say('orphan', 'slide', n.data, e.className || e.tagName); }
    }
    E.goto(0);
    return { nodes, kinds, findings: out };
  })()`,
};
