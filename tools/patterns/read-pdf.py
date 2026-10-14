"""Read pattern tiles from an Office PDF: PowerPoint's of tmp/patterns/patterns.pptx (tools/patterns/deck.mjs, the 54
DrawingML presets) or, with --cells, Excel's of tmp/patterns/cellpatterns.xlsx (tools/patterns/sheet.mjs, the 17
SpreadsheetML cell patterns). Each fill is a PDF tiling pattern painting an image of 8×8 blocks (64×64 pixels from
PowerPoint, 8×8 from Excel); the patterns are used in the order the shapes or rows were placed. Prints {name: 8 rows,
high bit left} as JSON, the form of common/geometry.js's PATTERNS and tests/patterns.powerpoint.json, and of Ledger's
cell patterns and tests/patterns.excel.json:
  python3 tools/patterns/read-pdf.py patterns.pdf > tests/patterns.powerpoint.json
  python3 tools/patterns/read-pdf.py --cells cellpatterns.pdf > tests/patterns.excel.json"""
import json, re, sys, zlib

NAMES = ['pct5', 'pct10', 'pct20', 'pct25', 'pct30', 'pct40', 'pct50', 'pct60', 'pct70', 'pct75', 'pct80', 'pct90', 'horz', 'vert', 'ltHorz', 'ltVert',
  'dkHorz', 'dkVert', 'narHorz', 'narVert', 'dashHorz', 'dashVert', 'cross', 'dnDiag', 'upDiag', 'ltDnDiag', 'ltUpDiag', 'dkDnDiag', 'dkUpDiag', 'wdDnDiag',
  'wdUpDiag', 'dashDnDiag', 'dashUpDiag', 'diagCross', 'smCheck', 'lgCheck', 'smGrid', 'lgGrid', 'dotGrid', 'smConfetti', 'lgConfetti', 'horzBrick',
  'diagBrick', 'solidDmnd', 'openDmnd', 'dotDmnd', 'plaid', 'sphere', 'weave', 'divot', 'shingle', 'wave', 'trellis', 'zigZag']
CELLS = ['darkGray', 'mediumGray', 'lightGray', 'gray125', 'gray0625', 'darkHorizontal', 'darkVertical', 'darkDown', 'darkUp', 'darkGrid',
  'darkTrellis', 'lightHorizontal', 'lightVertical', 'lightDown', 'lightUp', 'lightGrid', 'lightTrellis']
if '--cells' in sys.argv: NAMES = CELLS

data = open([a for a in sys.argv[1:] if not a.startswith('--')][0], 'rb').read()
objs = {}   # number: (dictionary, decoded stream or None)
for m in re.finditer(rb'(\d+) 0 obj\s*(.*?)endobj', data, re.S):
    body, stream = m.group(2), None
    k = body.find(b'stream')
    if k >= 0:
        head, raw = body[:k], body[k + 6:].lstrip(b'\r\n')
        n = re.search(rb'/Length (\d+)', head)
        raw = raw[:int(n.group(1))] if n else raw[:raw.rfind(b'endstream')]
        stream = zlib.decompress(raw) if b'FlateDecode' in head else raw
        body = head
    objs[int(m.group(1))] = (body, stream)
ref = lambda dic, key: int(re.search(rb'/' + key + rb'\s+(\d+)\s+0\s+R', dic).group(1))
def resources(dic):
    """a /Resources dictionary: the object it refers to, or the dictionary itself where it is written inline"""
    m = re.search(rb'/Resources\s+(\d+)\s+0\s+R', dic)
    return objs[int(m.group(1))][0] if m else dic

kids = re.search(rb'/Type\s*/Pages.*?/Kids\s*\[([^\]]*)\]', b''.join(d for d, _ in objs.values()), re.S)
pages = [int(n) for n in re.findall(rb'(\d+)\s+0\s+R', kids.group(1))] if kids else \
    [n for n, (d, _) in objs.items() if re.search(rb'/Type\s*/Page\b', d)]
tiles = {}
for page in pages:
    dic = objs[page][0]
    res = resources(dic)
    named = {int(a): int(b) for a, b in re.findall(rb'/P(\d+)\s+(\d+)\s+0\s+R', res)}
    used = []
    for p in re.findall(r'/P(\d+) scn', objs[ref(dic, b'Contents')][1].decode('latin1')):
        if int(p) not in used: used.append(int(p))
    for p in used:
        pattern = objs[named[p]][0]
        image = int(re.search(rb'/Im(?:age)?\d+\s+(\d+)\s+0\s+R', resources(pattern)).group(1))
        head, px = objs[image]
        w, h = (int(re.search(rb'/' + k + rb' (\d+)', head).group(1)) for k in (b'Width', b'Height'))
        comps, cell = len(px) // (w * h), w // 8
        lum = lambda x, y: sum(px[(y * w + x) * comps:(y * w + x + 1) * comps]) / comps
        rows = []
        for by in range(8):
            row = 0
            for bx in range(8):
                block = [lum(bx * cell + i, by * cell + j) for i in range(cell) for j in range(cell)]
                if max(block) - min(block) > 8: sys.exit(f'{NAMES[len(tiles)]}: bit {bx},{by} is not one colour')
                row = row << 1 | (sum(block) / len(block) < 128)
            rows.append(row)
        tiles[NAMES[len(tiles)]] = rows
if len(tiles) != len(NAMES): sys.exit(f'{len(tiles)} patterns found, not {len(NAMES)}')
print(json.dumps(tiles, indent=0).replace('\n', '').replace('],', '],\n').replace('{', '{\n').replace('}', '\n}'))
