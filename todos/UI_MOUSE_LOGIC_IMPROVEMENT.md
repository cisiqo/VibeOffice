# UI: mouse, selection, drag and focus logic in Quire, Ledger and Lectern

Status: planned 2026-10-12, not started (the Format Painter part is done, see What was done). Read docs/suite.md
(Shared code, Brushes) first. An audit of all three apps with real mouse and keyboard input (CDP, paced like a hand)
confirmed 45 defects; most come from the same few missing mechanisms (Root causes). Six phases, in order: 0 test
tools, 1 data loss, 2 one shared drag lifecycle, 3 one focus rule, 4 one owner per piece of state in each app,
5 the rest. Mark each task when it is done and verified (its regression test fails on the previous commit).

## Tasks

Phase 0: test tools
- [ ] `tests/lib/input.mjs`: a tab on an app with real input (click, drag, double-click, right-click, keys, Esc, a lost
      release, window blur, tab switch), the brush cursor and console checks; `tests/painter.test.mjs` moves onto it
- [ ] The previous-code check as a script: serve `public/` with the fix's files at `HEAD` on another port and run a test
      there with soft assertions (`BASE=http://127.0.0.1:8761`); docs/testing.md

Phase 1: data loss and wrong edits (small separate fixes, each with its test)
- [ ] Q1 Quire: Find Next takes the keyboard from the Find box, the next Enter replaces the found text
- [ ] Q2 Quire: Enter or Tab on a selected floating shape deletes it
- [ ] Q3 Quire: dragging inside a template placeholder moves the placeholder's text
- [ ] S3 Ledger: typing after going from the formula bar back into the cell is undone keystroke by keystroke
- [ ] S7 Ledger: dragging a cell by its border onto data replaces it without asking
- [ ] P1 Lectern: after a thumbnail click, a click on a shape and Delete delete the slide (arrows change slides)
- [ ] P2 Lectern: formatting a selected range of table cells formats the whole table

Phase 2: one drag lifecycle, `ui.drag` in common/ui.js (Design)
- [ ] `ui.drag` with `tests/drag.test.mjs` (every app: threshold, Esc, right button, lost release, blur, tab switch)
- [ ] Quire on it: rulers, table borders, drawing tool, shape move, resize, rotate, inline picture resize, splitter
      (Q13, Q14, Q17c)
- [ ] Ledger on it: the grid's drags (cells, headers, fill, move, resize, page breaks, paint, point), shapes, sheet
      tabs (S12, S14c, S14d)
- [ ] Lectern on it: move, handles, marquee, drawing tools, scribble, freeform and curve, text and cell selection,
      thumbnail reorder (P5, P14, P10)

Phase 3: one focus rule, the keyboard back to the document (Design)
- [ ] ui.js dialogs hand the keyboard back through `ui.hooks.refocus()` (Q6 first half, P7)
- [ ] ui.js menus don't take focus; a command chosen from a menu hands it back (Q6 second half)
- [ ] Chrome without a control of its own keeps the focus where it is (S11)
- [ ] Each app's `refocus` puts the model selection back into the page (Quire, Ledger, Lectern)
- [ ] `tests/focus.test.mjs`: dialogs (OK, Cancel, Esc) from a menu, a toolbar and the context menu; menu commands;
      chrome backgrounds; in every app and in Classic and Paper 2016

Phase 4: one owner per piece of state
- [ ] Quire object selection: one way in and out of it (Q15, Q10)
- [ ] Quire model selection at gesture ends (Q9, Q11)
- [ ] Quire header and footer editing (Q7, Q8)
- [ ] Lectern: one end-the-interaction path; the Slides pane and the slide own their focus (P3, P4)
- [ ] Lectern selection on press, shift-click, the edit ring, the scroll bar, double-click (P6, P11, P12, P13)
- [ ] Lectern table cells (P8, P9)
- [ ] Ledger cell editor: one way to leave an edit; point mode as Excel (S1, S5, S6, S10, S14b)
- [ ] Ledger selection extent (S2); shape text then a cell (S4)
- [ ] No re-render under the pointer on press (S8; P4 above)

Phase 5: the rest
- [ ] Quire text drag and drop (Q4, Q5); the Drag-and-drop text editing option; dragging inline pictures (Q17a, Q17b)
- [ ] Quire selection bar (Q12); a drag from a table out to text (Q16)
- [ ] Ledger auto-scroll (S9, S13); holding the button on a hyperlink (S14a)
- [ ] Lectern: check the two open questions against PowerPoint (Audit, Lectern, Open)
- [ ] docs: docs/suite.md (Drags, Focus), docs/quire.md, docs/ledger.md, docs/lectern.md, docs/testing.md

## What was done

- 2026-10-12 (1035247), the Format Painter: `ui.brush` (common/ui.js) is the mode every painter and Quire's highlighter
  uses, and applies once when the mouse is let go; Quire's editor says when a gesture is over (`'sel-done'`) and ends
  an object selection one way (`E.clearObjSel`, which drawing.js follows); Lectern's painter keeps the text being
  edited. `tests/painter.test.mjs`, `tests/quire/mouse-selection.mjs`. This plan follows the same pattern.

## Decisions

Proposed, to settle with the user before Phase 2:
- A release we never saw (button let go in another tab or window) cancels the drag, as a lost mouse capture does in
  Windows and in LibreOffice (vcl ends tracking with Cancel); it doesn't commit at the last point.
- `ui.drag` and the focus rule live in common/ui.js, so no app's `index.html` changes (Ledger's is generated).
- The order of the phases is the one above (data loss first); the user has not confirmed it yet.

## Root causes

1. No shared drag lifecycle. Each drag adds its own window listeners; none has a movement threshold, and none ends
   on Esc, a second button, a lost release, `pointercancel`, window blur or a tool switch. (Phase 2)
2. No single way to hand the keyboard back to the document. Dialogs restore the element focused before them, which is
   `<body>` or an editor whose selection they moved; menus take the focus and keep it; chrome backgrounds drop it;
   a modeless dialog's command takes it from the dialog. (Phase 3)
3. Selections held twice and synced by hand: object against text selection (Quire's `E.sel` set to the anchor
   without the page, Lectern's text edit against `E.sel`, Ledger's shape against the cell), and the model selection
   against the page's (read before `selectionchange` has run). (Phase 4)
4. State set on one path and cleared only on the normal one: Ledger's selection extent and its cell editor (which
   input it reads, its sheet, its mode), Lectern's `focusArea`, `E.cellSel` and freeform points, Quire's
   header/footer mode, re-renders on press that take the element under the pointer. (Phase 4)

## Design

### `ui.drag(e, opts)`: one drag at a time (common/ui.js)

`ui.drag(e, { move(ev, d), up(ev, d), cancel(d), threshold = 4, capture })` starts on a primary-button press and
returns the drag `d` (`d.x0`, `d.y0`, `d.moved`, `d.data` for the app):
- One at a time (`ui.dragging()`); a new press while one is live cancels the old one first.
- `move` is called only after the pointer has gone `threshold` px from the press (Windows' drag rectangle is 4 px);
  `up` gets `d.moved`, so a click that never moved changes nothing (rulers, tab stops, rotate) or does its click.
- It ends with `up` on the release of the same pointer, with pointer capture on `capture` (default the press target).
- It ends with `cancel` (nothing commits; the app restores what it moved) on: Esc (capture-phase keydown, before the
  app's own Esc, which then doesn't run), a second button (its `contextmenu` is swallowed), a move that reports no
  button held (`ev.buttons === 0`), `lostpointercapture`, `pointercancel`, window blur, the page hidden, a tool or
  view switch (`ui.dragCancel()`).
- Text selection drags stay native (the browser's); apps keep their own "gesture over" signal (Quire `'sel-done'`).
- Auto-scroll stays with the app, but its timer re-reads the current frame on every tick (S9).
- Reference: LibreOffice's vcl tracking (`Window::StartTracking`, `Tracking(const TrackingEvent&)`,
  `EndTracking(TrackingEventFlags::Cancel)`; Esc and focus loss end tracking with Cancel in vcl/source/window) is
  this lifecycle; read it before writing, and note any difference here.

### The keyboard back to the document (common/ui.js)

When a piece of chrome is done, the keyboard goes back to the document through the app's `ui.hooks.refocus()`, which
puts the model selection back into the page (Quire `E.refocus`, Lectern the text being edited at `L.te.lastSel` or
the slide, Ledger the grid or the cell editor's input):
- A dialog closing (OK, Cancel, Esc): `refocus()`, unless the element focused before it is a chrome control that is
  still there (a pane's box), which gets the focus back (ui.js:358, :422 today restore it always).
- Menus: rows `preventDefault` on press, as toolbar buttons do, so the menu never takes the focus (ui.js:110, :128);
  a command chosen from a menu that opens no dialog ends with `refocus()`.
- Chrome without a control of its own (toolbar and ribbon backgrounds, grips, status bar, tab strips, the Name Box
  frame): one press listener in ui.js keeps the focus where it is.
- A modeless dialog (Find and Replace) keeps the focus while it is open: what it runs moves the selection without
  focusing the page (Quire `A.gotoPos(pos, { focus: false })`).
- Reference: vcl's `Window::GrabFocusToDocument()`, which toolbars and dialogs use to give the focus back.

### One owner per piece of state (each app)

Quire
- Object selection: `E.selectObject(os)` and `E.clearObjSel()` are the only writers of `E.objSel`. Selecting an object
  clears the page's text selection (no highlight left, Q15), and keys go through the object guard before anything
  else (Enter and Tab today run first, Q2). `DR.select` and `selectInlineObject` use it.
- The model selection at a gesture's end: code that runs right after a pointer event calls `E.syncSel()` first
  (context menu Q9, Ctrl+click Q11) or listens to `'sel-done'` instead of `'sel'` (templates Q3).
- Header and footer editing: the selection stays in the story being edited (Q7); opening and closing keep the view
  and the caret (Q8).

Lectern
- `E.endInteraction()`: cancels the live drag (`ui.dragCancel`), unfinished freeform points (`ff`), `E.cellSel` and its
  overlay; called by Esc, `E.setTool`, a slide change, a re-render and window blur.
- Focus: a press on the slide takes the focus for the slide (`focusArea = 'slide'`, P1); a re-render of the Slides
  pane keeps the focus on the same thumbnail (P4); a thumbnail click always ends text editing (P3).

Ledger
- The cell editor: one `leave(commit)` for every way out (Enter, Tab, Esc, a click on another cell, a right-click, the
  Name Box, a sheet tab, a toolbar command); the formula bar and the cell are two views of one edit, whichever has the
  focus (S3, S5, S6). Point mode as Excel: wherever a reference can go, in Enter and Edit mode, from the cell or the
  bar, Shift extends it (S1, S14b).
- The selection: `G.select`, `G.selectRange` and header clicks reset the extent Shift+Arrow grows from (S2).

## Audit (2026-10-12, on 1035247)

Each item: what the user does, what happens (against what Office does), the cause (lines as of 1035247; they drift).
Probes are in `tmp/audit-quire/`, `tmp/audit-ledger/`, `tmp/audit-lectern/` (`node <file>`; tmp is not kept: the
steps here are enough to rebuild them). Reproduced again by hand: Q1, Q2, S1, S2, P1, P2; the rest by the auditors.

### Quire

- Q1 Ctrl+F, type "beta", Enter (found), Enter again: the found "beta" becomes a paragraph break. Word finds the next.
  `find.js:350` calls `A.gotoPos` (`app.js:972-974`), which focuses the page. (p25-find-focus)
- Q2 Click a floating shape, press Enter or Tab: the shape is deleted; `objSel` still points at it, so letters typed
  next vanish. Word keeps it. Enter and Tab are handled at `editor.js:687/697`, before the object guard at `:746`;
  `DR.select` set `E.sel` to the anchor (`drawing.js:532`). (p06-shape-enter)
- Q3 In a document from a template, press inside a [Click here…] placeholder and drag: the placeholder's text moves
  ("Dear , thank you fo[Click here…]r…", undo "Move"). The `'sel'` listener (`templates.js:260-271`) selects the
  field while the button is down, so Chrome starts a text drag. (p22-macrobutton-drag)
- Q4 Drag selected text and drop it outside the document, then drop other text (e.g. from the font box): the old
  selection moves. `dragData` (`editor.js:805-807`) is never cleared; there is no `dragend`. (p13-dnd-stale)
- Q5 Drag a word forward within its paragraph: the caret lands the word's length too far right. `editor.js:836-837`
  returns the end from before the source is deleted. (p23-dnd-same-para)
- Q6 Ctrl+D, then Esc or OK: the selection goes to the end of the document and typing goes there (`ui.js:422` focuses
  the page without the selection). A menu-bar command chosen with the mouse (View ▸ Ruler, or a dialog from a menu,
  closed) leaves the focus on `<body>`: the menu (`ui.js:110`, tabindex -1) takes it because its rows don't
  `preventDefault` (`:128`). (p11-dialog-menu-focus, p30-menu-focus)
- Q7 Editing the header, click the dimmed body: the caret goes into the body; Enter, Delete and Backspace edit it while
  letters vanish. `E.onSelectionChange` (`editor.js:~95-112`) takes body positions while `LY.hfEdit` is set.
  (p17-hf-body-keys)
- Q8 Opening the header on page 2 scrolls to page 1 and puts the caret at the header's start (`app.js:940`); closing
  it (Esc, double-click) puts the caret at the document's start (`app.js:966`); double-clicking the top margin when
  the header is empty does nothing (its box is 0 high, `editor.js:938`). (p15-hf, p16-hf-click-body, p33-hf-close)
- Q9 Caret outside a table, right-click a cell: no table items; a second right-click has them. `contextmenu` comes
  before `selectionchange`; `A.contextMenu` (`app.js:1002-1004`) doesn't `E.syncSel()`. (p08-ctxmenu-caret)
- Q10 Right-click a selected inline picture: the handles go while it stays selected. Right-click an unselected one:
  it isn't selected, so no picture items. `hideHandles()` runs before the button check (`editor.js:855-856`).
  (p07-picture-rclick)
- Q11 Ctrl+click a sentence: the sentence at the old caret is selected. The `setTimeout(0)` (`editor.js:889`) reads
  `E.sel` before it is updated. (p02-ctrlclick)
- Q12 Selection bar (left margin): a drag down selects only the first line; Shift+click doesn't extend (`selectLine`
  resets, `editor.js:901/908`); a triple-click selects the paragraph, not the document (`:881`). (p01-selbar,
  p21-clicks)
- Q13 A click without movement on the left-indent marker moves it 25 → 27 pt, on a tab stop 100 → 103.5 pt, each an
  undo step that marks the document changed; a click on the rotate handle adds a "Rotate" step. No movement check
  (`rulers.js:220-224`, `drawing.js:664`). (p09-ruler-rotate-click)
- Q14 Esc during a drag doesn't cancel: drawing a shape still inserts it despite "Press Esc to cancel"
  (`drawtool.js:58/96`); a shape move still moves (`drawing.js:578`); an inline picture resize still resizes
  (`editor.js:983`). (p20-draw-esc, p19-shape-drag-esc, p24-picture-resize)
- Q15 Select text, then click a floating shape: the text stays highlighted; Ctrl+B records "Bold" on the hidden
  anchor. `DR.select` sets `E.sel` without the page (`drawing.js:525-532`). (p27-shape-text-sel)
- Q16 Drag from a table cell down into the text below: 3 of 4 cells are highlighted, and Delete leaves an empty table
  shell where Word removes the rows. The `markCells` else branch in editor.js. (p35-table-out-delete)
- Q17 (a) Tools ▸ Options ▸ Drag-and-drop text editing does nothing (`opts.dragDrop` is never read,
  p14-dragdrop-option); (b) inline pictures can't be dragged to another place (p31-picture-drag); (c) a right-click
  during a shape move opens the menu and the move still happens on release (p19).

Working as Word does: drag-select out of the window and back, auto-scroll, the page gap; toolbar buttons, the font
boxes and palettes keep the selection; window blur; table border resize and table drag-select. Chrome on Linux
selects a double-clicked word without its space (Word includes it): not ours.

### Ledger

- S1 F2 or a double-click, type `=1+`, click C3: "The formula you typed contains an error" (also typing in the formula
  bar). Excel inserts C3. Edit mode never goes to point mode (`editor.js:19`, `:128`, `:199`); only point mode
  inserts references (`grid.js:444`). (p01-edit-mode-point, p01b-formula-bar-point)
- S2 A1, Shift+Down twice, Down, Shift+Right: A2:B3 (Excel A2:B2). Drag B2:D5, click F10, Shift+Down: D6:F10. Click
  column H, Shift+Right: E1:H5. `s.extent` (`grid.js:245`) is never cleared by `G.select`, `G.selectRange` or header
  clicks; `G.move` (`grid.js:302`) and PageDown start from it. (p24-stale-extent)
- S3 Double-click A5, click the formula bar, click back into the cell and type: each keystroke is undone. Only the bar
  sets `surface` (`editor.js:24`; not reset at `:32`), so `E.onInput` (`editor.js:197`) copies the bar over the
  cell. (p02-surfaces)
- S4 Edit a shape's text, then click a cell: the shape is selected again and typing goes into it. The blur runs
  `finish()` (`drawing.js:329`), whose `replace()` reselects the shape (`drawing.js:217`) after `grid.js:438`
  deselected it. (p12-shape-text-then-cell)
- S5 Typing in A1, right-click C5: the selection moves to C5 with no menu, and Enter writes A1 and goes to C6
  (`grid.js:426` acts before the edit is committed). Typing in A2, type C5 in the Name Box: C5 is selected while
  typing still goes to A2 (`app.js:664` only selects the box's text). The font boxes commit first through
  `ui.hooks.commitEdit` (`common/ui.js:287`). (p25-rightclick-while-editing, p04-namebox-while-editing)
- S6 Type `=`, click Sheet2, click B2, Enter: Ledger stays on Sheet2 and moves its selection; Excel goes back to
  Sheet1 and moves to A2. `end()` (`editor.js:328`) doesn't go back to `E.sheet`; `moveAfter` (`editor.js:353`).
  (p03-sheet-point)
- S7 Drag a cell by its border onto a cell with data: replaced without asking (Excel asks). The comment at
  `clipboard.js:411` says it asks; nothing does. (p08-drag-ops a)
- S8 Double-click a sheet tab (active or not): Rename never opens. Each press re-renders the tabs (`app.js:317` →
  `renderTabs`, `app.js:306`), so neither click nor dblclick reaches them. (p10-sheet-tabs, p10b-tab-dblclick-events)
- S9 Drag column headers past the edge: it scrolls 20 columns but stays C:T. The frame is captured once
  (`grid.js:526`) and the timer (`grid.js:512`) hit-tests it again (`grid.js:531-532`). (p06-autoscroll)
- S10 Alt+Down on a cell, or a validation list: arrows move the cell, Enter moves down, Esc doesn't close it, the
  list stays. `E.listKey` (`editor.js:569`) is never called; its outside-click listener (`:565-566`) is never
  removed. (p22-picklist-keys)
- S11 Click a toolbar or ribbon background, a grip, the Name Box frame, the empty tab strip or the status bar (16 of
  16 areas, in every look): the focus goes to `<body>`; arrows, Delete and F2 do nothing until a cell is clicked
  (only letters recover, `app.js:774`). (p20-focus-sweep, p05b-blank-chrome, p27-chrome-buttons)
- S12 A drag whose release was lost (moves reporting no button): the selection or the fill outline follows the bare
  pointer, the fill outline stays after the next click, and a shape's move outline follows and is dropped by the next
  click ("Move Object"). Drags end only on pointerup and pointercancel (`grid.js:499-501`, `drawing.js:279`).
  (p15-lost-release, p15b-lost-release-fill, p15c-lost-release-shape)
- S13 Frozen panes: a drag inside the frozen rows or column scrolls the other pane by itself (row 32 back to 18 in
  0.8 s); `grid.js:509-510` treats the frozen area as above or left of it. (p14-frozen)
- S14 (a) Holding the button on a hyperlink still follows it on release; Excel selects the cell (`grid.js:690`,
  p16-link-hold). (b) Shift+click in point mode replaces the reference (`=D5`, not `=B2:D5`; only Ctrl is passed,
  `grid.js:447`, p17-point-shift-click). (c) Esc during a fill-handle drag doesn't cancel it (p08-drag-ops b).
  (d) A right-click during a left drag opens the context menu (`onContext`, `grid.js:793`, p08-drag-ops c).

Working as Excel does: dialogs and the focus after them, ribbon tabs, buttons and boxes, column and row resize and
AutoFit, several ranges, a release outside the window, shapes (move, resize, Esc). Not confirmed: the comment pop-up
staying after the pointer leaves the grid (`grid.js:1040` listens for `pointerleave` on `document`); native scroll
bars (headless Chrome's don't behave like real ones).

### Lectern

- P1 Click a thumbnail, click a shape on the slide, press Delete: the whole slide is deleted; arrows change slides
  instead of nudging. PowerPoint moves the keyboard to the slide. `onDown` calls `preventDefault` (`editor.js:400`),
  so the focus stays in the Slides pane; `E.refocus` returns early while `focusArea === 'slides'` (`editor.js:56`);
  `app.js:1799` sends the keys to the slides. (p01-thumb-focus-delete)
- P2 Drag-select 2×2 cells of a 3×3 table, click Bold or Center: all 9 cells change. `F.run` and `F.para` call
  `TE.detach()` (`textedit.js:813`, `:829`), which sets `E.cellSel = null` (`textedit.js:387`) before `forEachTx`
  reads it (`textedit.js:802`). (p13-table-range-format)
- P3 Editing text, click the current slide's thumbnail: editing stays (its ring); Delete and typing do nothing,
  Ctrl+B formats the hidden selection and pulls the focus back, the next Delete deletes text. `panes.js:95` calls
  `goto` (which ends editing) only when the slide changes; `app.js:1771` handles text keys before the pane.
  (p05-edit-then-elsewhere)
- P4 In the Slides pane, Delete a slide or drag one to another place: the focus goes to `<body>` and `focusArea` to
  null, so a second Delete does nothing. `L.clear(LP.body)` (`panes.js:50`) removes the focused thumbnail; its blur
  clears `focusArea` (`panes.js:26`). (p16-thumb-delete-twice, p15-thumb-reorder-focus)
- P5 Esc during a move, a resize, drawing a rectangle or reordering slides: it still commits on release (Esc only
  deselects); during a scribble it throws (`TypeError`, `editor.js:846`, `E.tool` null). A right-click during a move
  deselects and opens the slide's menu, and the move commits. The private `drag` (`editor.js:352`, `730-732`) has no
  cancel; the Esc handler (`app.js:1790`) doesn't know it. (p02-escape-during-drag, p14-thumb-drag, p17-misc)
- P6 Shift+click or Ctrl+click a text box: the selection is dropped and the box is edited. `startMove`'s up
  (`editor.js:492-494`) starts editing text boxes with Shift or Ctrl held; `TE.begin` resets `E.sel`
  (`textedit.js:327`). (p11-shift-click-textboxes)
- P7 Format ▸ Font… from a menu or the context menu, then Cancel or Esc: the focus is on `<body>` while the ring still
  shows; typing is lost. Hyperlink from the toolbar, Cancel: the caret goes to the text's start. `ui.js:358`, `:422`
  restore the element focused before, never `ui.hooks.refocus()`. (p07-dialog-cancel)
- P8 Drag across the cells of a table that isn't being edited: the table moves (PowerPoint selects the cells).
  `startCellSelect` runs only while the table is edited (`editor.js:381`). (p04-table-drag a)
- P9 Select a range of cells, click one cell: the range's highlight stays, formatting then hits the one cell.
  `editor.js:727` clears `E.cellSel` without redrawing the overlay. (p04-table-drag b)
- P10 Start a Freeform, switch to Rectangle: the freeform's ghost line stays, and the next Freeform carries the old
  points. `E.setTool` (`editor.js:759`) doesn't drop `ff`. (p03-freeform-switch-tool)
- P11 Editing text, click the hatched edit ring: editing restarts with the caret at the end (PowerPoint 2003 selects
  the box as an object, and Delete removes it). `editor.js:528` sends it to `startMove`, whose up starts editing.
  (p12-ring-scrollbar a)
- P12 Zoomed in, press the scroll bar: editing ends and everything is deselected; `editor.js:392-398` takes a press on
  the scroller for a press on the slide's background. (p12-ring-scrollbar b, c)
- P13 Double-click a word in an unselected AutoShape: a caret, not the word. The second press starts editing without
  word selection, then `onDbl` skips because editing is on (`editor.js:746`). (p08-dblclick-word)
- P14 Start a move, switch tabs and let go there, come back: the shape follows the pointer with no button held.
  `editor.js:730` calls `drag.move` without looking at `e.buttons`; nothing ends it on blur or a lost capture.
  (p19-drag-tab-switch)

Working as PowerPoint does: text drag-select out of the box and the window and back, margin drags, Shift+click in
text, the marquee (also released outside the window), Bold, the size, font and zoom boxes and their lists, menus
dismissed, the notes pane, window blur while editing, groups (drill-in, Esc). Open: a thumbnail dragged and let go over
the slide still reorders; typing over a cell range goes into the anchor cell and the highlight stays. Not testable:
Ctrl+T never reaches the page in Chrome (the Font dialog is reached from menus).

## Working rules

- Real input only: CDP `Input` events paced like a hand (40-60 ms between moves, ~300 ms after a release); synthetic
  DOM events hide exactly these bugs. Assert what the user sees (the cursor, the text, the formatting, where typing
  goes), so a test also runs against the previous code.
- A fix's regression test fails on the previous commit (serve the fix's files at `HEAD` on another port); say how
  many checks fail there in the commit message.
- Behave as Office does; when unsure, read how LibreOffice does it (vcl tracking and focus, sw edtwin, sc gridwin,
  sd fu*.cxx) and write down where we follow it and where Office differs.
- A change in common/ (`ui.drag`, the focus rule) is checked in all three apps and in the Classic and Paper 2016
  looks (`node --test tests/ribbon.test.mjs tests/looks.test.mjs`), with screenshots of what it touches.
- Each phase ends with the full set: `node --test tests/painter.test.mjs tests/drag.test.mjs tests/focus.test.mjs`,
  `node tests/quire/mouse-selection.mjs`, the apps' unit tests, and every app loading without console errors.
- Several sessions work in this repository: commit only these files and hunks; leave findings for other plans in
  their To do.
