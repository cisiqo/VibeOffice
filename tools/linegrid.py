"""Line heights on a document line grid, as Word draws them (issue 11; Quire's R.gridLine in public/quire/js/render.js).

  python3 tools/linegrid.py make [tmp/linegrid/linegrid.docx]   a document with one paragraph per case: English text in
      Times New Roman at sizes either side of the grid pitch, each at several line spacings, on a 15.6pt grid and an
      18pt grid, and Chinese text (SimSun, with a few English words, as in issue 11's file) on the 15.6pt grid
  python3 tools/linegrid.py read linegrid.pdf [OUT.json]          after Word has saved it as PDF: the distance between
      the lines of each case, in points, and the line each page starts with (tests/from-issues/11/word.json, from
      Word for Mac; the document is tests/from-issues/11/linegrid.docx; checked by the tests there)

Each paragraph starts with its case, [pitch/size/multiple] or [pitch/size/multiple/zh], so the reader finds it in the PDF (pdftotext -bbox-layout).
"""
import json, os, re, subprocess, sys, zipfile
from xml.sax.saxutils import escape

BLOCKS = [(15.6, 'en', [10.5, 12, 13.5, 14, 16, 22, 28], [0.8, 1, 1.15, 1.5, 1.7, 2, 2.5, 3]),
          (15.6, 'zh', [10.5, 12, 14, 16, 22], [1, 1.5, 1.7, 2, 2.5]),
          (18, 'en', [10.5, 14, 22], [1, 1.5, 2])]
TEXT = {'en': 'The lines of this paragraph show how far apart the grid puts them. ',
        'zh': '这一段的各行用来测量网格把行放得多远，其中也有 Times New Roman 的英文。'}
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'


def cases():
    for pitch, script, sizes, mults in BLOCKS:
        for sz in sizes:
            for m in mults:
                yield pitch, sz, m, script


def label(pitch, sz, m, script='en'):
    return f'[{pitch:g}/{sz:g}/{m:g}' + ('' if script == 'en' else '/' + script) + ']'


def make(out):
    paras, sections = [], list(dict.fromkeys(b[0] for b in BLOCKS))
    for i, pitch in enumerate(sections):
        for p, sz, m, script in cases():
            if p != pitch:
                continue
            text = TEXT[script]
            words = text * max(2, round((3400 if script == 'en' else 1500) / sz / len(text)))
            paras.append(f'<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="{round(m * 240)}" w:lineRule="auto"/></w:pPr>'
                         f'<w:r><w:rPr><w:sz w:val="{round(sz * 2)}"/><w:szCs w:val="{round(sz * 2)}"/></w:rPr><w:t xml:space="preserve">{escape(label(p, sz, m, script))} {escape(words)}</w:t></w:r></w:p>')
        grid = f'<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/><w:cols w:space="425"/><w:docGrid w:type="lines" w:linePitch="{round(pitch * 20)}"/>'
        if i < len(sections) - 1:
            paras.append(f'<w:p><w:pPr><w:sectPr><w:type w:val="nextPage"/>{grid}</w:sectPr></w:pPr></w:p>')
        else:
            last = f'<w:sectPr>{grid}</w:sectPr>'
    document = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="{W}" xmlns:r="{REL}"><w:body>{"".join(paras)}{last}</w:body></w:document>'
    # the compatibility settings of a Word document written in China (issue 11's file), where line grids are usual
    settings = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:settings xmlns:w="{W}"><w:defaultTabStop w:val="420"/>'
                '<w:drawingGridVerticalSpacing w:val="156"/><w:displayHorizontalDrawingGridEvery w:val="0"/><w:characterSpacingControl w:val="compressPunctuation"/>'
                '<w:compat><w:spaceForUL/><w:balanceSingleByteDoubleByteWidth/><w:doNotLeaveBackslashAlone/><w:ulTrailSpace/><w:doNotExpandShiftReturn/>'
                '<w:adjustLineHeightInTable/><w:useFELayout/><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>')
    styles = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="{W}"><w:docDefaults><w:rPrDefault><w:rPr>'
              '<w:rFonts w:ascii="Times New Roman" w:eastAsia="SimSun" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:kern w:val="2"/><w:sz w:val="21"/>'
              '<w:lang w:val="en-US" w:eastAsia="zh-CN" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults>'
              '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:widowControl w:val="0"/><w:jc w:val="both"/></w:pPr></w:style></w:styles>')
    parts = {
        '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
            '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>',
        '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f'<Relationship Id="rId1" Type="{REL}/officeDocument" Target="word/document.xml"/></Relationships>',
        'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f'<Relationship Id="rId1" Type="{REL}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="{REL}/settings" Target="settings.xml"/></Relationships>',
        'word/document.xml': document, 'word/styles.xml': styles, 'word/settings.xml': settings,
    }
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, data in parts.items():
            z.writestr(name, data)
    print(f'saved {out}: {sum(1 for _ in cases())} cases. Open it in Word, save it as PDF, then: python3 tools/linegrid.py read <the PDF>')


def read(pdf, out=None):
    """the lines of each case (the text lines after its label, up to the next label), on the same page: their spacing;
    and the line each page starts with"""
    html = subprocess.run(['pdftotext', '-bbox-layout', pdf, '-'], capture_output=True, text=True, check=True).stdout
    found, current = {}, None
    for page, body in enumerate(re.findall(r'<page\b.*?</page>', html, re.S)):
        for line in re.findall(r'<line xMin="[\d.]+" yMin="([\d.]+)" xMax="[\d.]+" yMax="([\d.]+)">(.*?)</line>', body, re.S):
            boxes = re.findall(r'yMin="([\d.]+)" xMax="[\d.]+" yMax="[\d.]+">([^<]*)</word>', line[2])
            words = [w for _, w in boxes]
            m = re.match(r'\[[\d.]+/[\d.]+/[\d.]+(/zh)?\]', words[0]) if words else None
            if m:
                current = m.group(0)
                found[current] = []
            # the top of the Chinese words where the line has any: English words beside them reach higher
            top = next((float(y) for y, w in boxes if re.search('[\u3000-\u9fff]', w)), float(line[0]))
            if current and not (found[current] and found[current][-1][0] == page and abs(found[current][-1][1] - top) < 1):   # a line split in two
                found[current].append((page, top))
    result = {}
    for key, lines in found.items():
        gaps = [b[1] - a[1] for a, b in zip(lines, lines[1:]) if a[0] == b[0]]
        if gaps:
            result[key] = round(sum(gaps) / len(gaps), 2)
            if max(gaps) - min(gaps) > 0.3:
                print(f'{key}: uneven gaps {[round(g, 2) for g in gaps]}', file=sys.stderr)
    missing = [label(*c) for c in cases() if label(*c) not in result]
    if missing:
        print(f'not measured: {missing}', file=sys.stderr)
    starts = {}
    for key, lines in found.items():
        for i, (page, _) in enumerate(lines):
            starts.setdefault(page, f'{key} line {i + 1}')
    text = json.dumps({'lines': result, 'pages': [starts[p] for p in sorted(starts)]}, indent=1, ensure_ascii=False) + '\n'
    if out:
        open(out, 'w').write(text)
        print(f'saved {out}: {len(result)} cases, {len(starts)} pages')
    else:
        print(text, end='')


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'make':
        make(sys.argv[2] if len(sys.argv) > 2 else 'tmp/linegrid/linegrid.docx')
    elif len(sys.argv) > 2 and sys.argv[1] == 'read':
        read(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
    else:
        sys.exit(__doc__)
