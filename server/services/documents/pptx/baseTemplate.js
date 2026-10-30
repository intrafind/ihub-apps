// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import JSZip from 'jszip';
import { xmlEscape } from '../ooxml/opcPackage.js';
import { EMU_PER_INCH, GROUP_PROPS, luminance, PML_NAMESPACES, XML_HEAD } from './pptxXml.js';

/**
 * iHub's built-in presentation template, made from a brand: a slide master
 * with six layouts (title, section, title and content, two contents, title
 * only, blank), a theme with the brand's colours and fonts, and the logo.
 *
 * Presentations are always built by filling a template (`buildPptx.js`):
 * an admin's PowerPoint template when the document template has one,
 * otherwise this one. So both look like real PowerPoint files — editable
 * placeholders, layouts the user can switch, a theme for new slides.
 */

const SLIDE_SIZES = Object.freeze({
  '16:9': { cx: 12192000, cy: 6858000 },
  '4:3': { cx: 9144000, cy: 6858000 }
});

const DEFAULT_COLORS = Object.freeze({
  primary: '1E3A8A',
  accent: '0F766E',
  text: '1F2937',
  palette: ['F59E0B', '10B981', '8B5CF6', 'EF4444']
});

const NOTES_SIZE = { cx: 6858000, cy: 9144000 };

const TYPES = {
  presentation:
    'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  master: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
  layout: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
  theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
  notesMaster: 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml',
  presProps: 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml',
  viewProps: 'application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml',
  tableStyles: 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml',
  core: 'application/vnd.openxmlformats-package.core-properties+xml',
  app: 'application/vnd.openxmlformats-officedocument.extended-properties+xml'
};

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function hex(value, fallback) {
  const clean = String(value || '').replace('#', '');
  if (/^[0-9a-f]{3}$/i.test(clean)) return [...clean.toUpperCase()].map(d => d + d).join('');
  return /^[0-9a-f]{6}$/i.test(clean) ? clean.toUpperCase() : fallback;
}

function rels(list) {
  return `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list
    .map(
      ([id, type, target]) =>
        `<Relationship Id="${id}" Type="${REL}/${type}" Target="${xmlEscape(target)}"/>`
    )
    .join('')}</Relationships>`;
}

function xfrm({ x, y, cx, cy }) {
  return `<a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(cx)}" cy="${Math.round(cy)}"/></a:xfrm>`;
}

/**
 * The theme: brand colours and fonts, Office's plain format scheme.
 */
export function themeXml({ name, colors, majorFont, minorFont }) {
  const clr = (tag, value) => `<a:${tag}><a:srgbClr val="${value}"/></a:${tag}>`;
  const font = typeface =>
    `<a:latin typeface="${xmlEscape(typeface)}"/><a:ea typeface=""/><a:cs typeface=""/>`;
  const line = w =>
    `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
  return `${XML_HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${xmlEscape(name)}"><a:themeElements><a:clrScheme name="${xmlEscape(name)}">${clr('dk1', colors.text)}${clr('lt1', 'FFFFFF')}${clr('dk2', colors.dark2)}${clr('lt2', 'F3F4F6')}${clr('accent1', colors.primary)}${clr('accent2', colors.accent)}${colors.palette
    .map((value, i) => clr(`accent${i + 3}`, value))
    .join(
      ''
    )}${clr('hlink', colors.primary)}${clr('folHlink', '6B7280')}</a:clrScheme><a:fontScheme name="${xmlEscape(name)}"><a:majorFont>${font(majorFont)}</a:majorFont><a:minorFont>${font(minorFont)}</a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="80000"/></a:schemeClr></a:solidFill></a:fillStyleLst><a:lnStyleLst>${line(6350)}${line(12700)}${line(19050)}</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="90000"/></a:schemeClr></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

function placeholder({ id, name, ph, rect, anchor, body = '', lstStyle = '' }) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr><p:spPr>${rect ? `${xfrm(rect)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` : ''}</p:spPr><p:txBody><a:bodyPr${anchor ? ` vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="${anchor}"` : ''}>${anchor ? '<a:normAutofit/>' : ''}</a:bodyPr><a:lstStyle>${lstStyle}</a:lstStyle>${body || '<a:p><a:endParaRPr lang="en-US"/></a:p>'}</p:txBody></p:sp>`;
}

function rectShape(id, name, rect, fill) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr userDrawn="1"/></p:nvSpPr><p:spPr>${xfrm(rect)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="${fill}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`;
}

function logoShape(id, rect) {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Logo" descr="Logo"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr userDrawn="1"/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdLogo"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(rect)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

function bodyLevels() {
  const level = (n, marL, indent, sz, char) =>
    `<a:lvl${n}pPr marL="${marL}" indent="${indent}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="100000"/></a:lnSpc><a:spcBef><a:spcPts val="${n === 1 ? 1000 : 500}"/></a:spcBef><a:buClr><a:schemeClr val="accent1"/></a:buClr><a:buFont typeface="Arial" panose="020B0604020202020204" pitchFamily="34" charset="0"/><a:buChar char="${char}"/><a:defRPr sz="${sz}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${n}pPr>`;
  const levels = [
    [285750, -285750, 2400, '•'],
    [685800, -285750, 2000, '–'],
    [1085850, -228600, 1800, '•'],
    [1485900, -228600, 1600, '–'],
    [1885950, -228600, 1600, '•'],
    [2286000, -228600, 1600, '–'],
    [2686050, -228600, 1600, '•'],
    [3086100, -228600, 1600, '–'],
    [3486150, -228600, 1600, '•']
  ];
  return levels.map(([marL, indent, sz, char], i) => level(i + 1, marL, indent, sz, char)).join('');
}

/**
 * Geometry of the built-in master, in EMU.
 */
function geometry(size, logo) {
  const { cx: W, cy: H } = size;
  const margin = 0.5 * EMU_PER_INCH;
  const logoHeight = 0.42 * EMU_PER_INCH;
  const logoWidth = logo ? Math.min(logoHeight / logo.ratio, 2.2 * EMU_PER_INCH) : 0;
  const titleTop = 0.32 * EMU_PER_INCH;
  const titleHeight = 0.9 * EMU_PER_INCH;
  const bodyTop = titleTop + titleHeight + 0.18 * EMU_PER_INCH;
  const footerHeight = 0.32 * EMU_PER_INCH;
  const footerTop = H - footerHeight - 0.18 * EMU_PER_INCH;
  return {
    W,
    H,
    margin,
    logo: logo
      ? {
          x: W - margin - logoWidth,
          y: titleTop + (titleHeight - logoHeight) / 2,
          cx: logoWidth,
          cy: logoHeight
        }
      : null,
    title: {
      x: margin,
      y: titleTop,
      cx: W - 2 * margin - (logo ? logoWidth + 0.25 * EMU_PER_INCH : 0),
      cy: titleHeight
    },
    body: {
      x: margin,
      y: bodyTop,
      cx: W - 2 * margin,
      cy: footerTop - bodyTop - 0.1 * EMU_PER_INCH
    },
    footer: { x: margin, y: footerTop, cx: W * 0.55, cy: footerHeight },
    slideNumber: {
      x: W - margin - 1.2 * EMU_PER_INCH,
      y: footerTop,
      cx: 1.2 * EMU_PER_INCH,
      cy: footerHeight
    }
  };
}

function masterXml(g, layoutCount) {
  const shapes = [
    rectShape(10, 'Accent bar', { x: 0, y: 0, cx: g.W, cy: 0.07 * EMU_PER_INCH }, 'accent1'),
    placeholder({
      id: 2,
      name: 'Title Placeholder 1',
      ph: 'type="title"',
      rect: g.title,
      anchor: 'b',
      body: '<a:p><a:r><a:rPr lang="en-US"/><a:t>Title</a:t></a:r></a:p>'
    }),
    placeholder({
      id: 3,
      name: 'Text Placeholder 2',
      ph: 'type="body" idx="1"',
      rect: g.body,
      anchor: 't',
      body: [0, 1, 2]
        .map(
          lvl =>
            `<a:p><a:pPr lvl="${lvl}"/><a:r><a:rPr lang="en-US"/><a:t>Level ${lvl + 1}</a:t></a:r></a:p>`
        )
        .join('')
    }),
    placeholder({
      id: 4,
      name: 'Footer Placeholder 3',
      ph: 'type="ftr" sz="quarter" idx="3"',
      rect: g.footer,
      anchor: 'ctr',
      lstStyle:
        '<a:lvl1pPr algn="l"><a:defRPr sz="1000"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="50000"/><a:lumOff val="50000"/></a:schemeClr></a:solidFill></a:defRPr></a:lvl1pPr>'
    }),
    placeholder({
      id: 5,
      name: 'Slide Number Placeholder 4',
      ph: 'type="sldNum" sz="quarter" idx="4"',
      rect: g.slideNumber,
      anchor: 'ctr',
      lstStyle:
        '<a:lvl1pPr algn="r"><a:defRPr sz="1000"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="50000"/><a:lumOff val="50000"/></a:schemeClr></a:solidFill></a:defRPr></a:lvl1pPr>',
      body: '<a:p><a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US"/><a:t>‹#›</a:t></a:fld><a:endParaRPr lang="en-US"/></a:p>'
    })
  ];
  if (g.logo) shapes.push(logoShape(11, g.logo));
  const layoutIds = Array.from(
    { length: layoutCount },
    (_, i) => `<p:sldLayoutId id="${2147483649 + i}" r:id="rId${i + 1}"/>`
  ).join('');
  return `${XML_HEAD}<p:sldMaster ${PML_NAMESPACES}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP_PROPS}${shapes.join('')}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst>${layoutIds}</p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="3200" b="1" kern="1200"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle>${bodyLevels()}</p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;
}

const FOOTER_PLACEHOLDERS =
  '<p:sp><p:nvSpPr><p:cNvPr id="20" name="Footer Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="ftr" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>' +
  '<p:sp><p:nvSpPr><p:cNvPr id="21" name="Slide Number Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldNum" sz="quarter" idx="4"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US"/><a:t>‹#›</a:t></a:fld><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>';

function layoutXml({ type, name, shapes, background, hideMaster }) {
  const bg = background
    ? `<p:bg><p:bgPr><a:solidFill><a:schemeClr val="${background}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
    : '';
  return `${XML_HEAD}<p:sldLayout ${PML_NAMESPACES} type="${type}" preserve="1"${hideMaster ? ' showMasterSp="0"' : ''}><p:cSld name="${xmlEscape(name)}">${bg}<p:spTree>${GROUP_PROPS}${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

function layouts(g, logo, primary) {
  const inch = EMU_PER_INCH;
  const onPrimary = luminance(primary) > 0.55 ? 'tx1' : 'bg1';
  const titleRun = (sz, color) =>
    `<a:lvl1pPr><a:defRPr sz="${sz}">${color ? `<a:solidFill><a:schemeClr val="${color}"/></a:solidFill>` : ''}</a:defRPr></a:lvl1pPr>`;
  const plain = (sz, color) =>
    `<a:lvl1pPr marL="0" indent="0"><a:buNone/><a:defRPr sz="${sz}">${color ? `<a:solidFill><a:schemeClr val="${color}"/></a:solidFill>` : ''}</a:defRPr></a:lvl1pPr>`;
  const titleSlide = [
    rectShape(10, 'Accent band', { x: 0, y: 0, cx: 0.28 * inch, cy: g.H }, 'accent1'),
    placeholder({
      id: 2,
      name: 'Title 1',
      ph: 'type="ctrTitle"',
      rect: { x: 1.0 * inch, y: g.H * 0.3, cx: g.W - 2 * inch, cy: 1.6 * inch },
      anchor: 'b',
      lstStyle: titleRun(4400)
    }),
    placeholder({
      id: 3,
      name: 'Subtitle 2',
      ph: 'type="subTitle" idx="1"',
      rect: { x: 1.0 * inch, y: g.H * 0.3 + 1.75 * inch, cx: g.W - 2 * inch, cy: 1.1 * inch },
      anchor: 't',
      lstStyle: `<a:lvl1pPr marL="0" indent="0" algn="l"><a:buNone/><a:defRPr sz="2000"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="65000"/><a:lumOff val="35000"/></a:schemeClr></a:solidFill></a:defRPr></a:lvl1pPr>`
    })
  ];
  if (logo) {
    const height = 0.6 * inch;
    const width = Math.min(height / logo.ratio, 3 * inch);
    titleSlide.push(
      logoShape(11, {
        x: g.W - g.margin - width,
        y: g.H - g.margin - height,
        cx: width,
        cy: height
      })
    );
  }
  const section = [
    placeholder({
      id: 2,
      name: 'Title 1',
      ph: 'type="title"',
      rect: { x: 1.0 * inch, y: g.H * 0.36, cx: g.W - 2 * inch, cy: 1.3 * inch },
      anchor: 'b',
      lstStyle: titleRun(4000, onPrimary)
    }),
    placeholder({
      id: 3,
      name: 'Text Placeholder 2',
      ph: 'type="body" idx="1"',
      rect: { x: 1.0 * inch, y: g.H * 0.36 + 1.4 * inch, cx: g.W - 2 * inch, cy: 1.0 * inch },
      anchor: 't',
      lstStyle: plain(2000, onPrimary)
    })
  ];
  const half = (g.body.cx - 0.4 * inch) / 2;
  return [
    { type: 'title', name: 'Title Slide', shapes: titleSlide, hideMaster: true },
    {
      type: 'secHead',
      name: 'Section Header',
      shapes: section,
      background: 'accent1',
      hideMaster: true
    },
    {
      type: 'obj',
      name: 'Title and Content',
      shapes: [
        placeholder({ id: 2, name: 'Title 1', ph: 'type="title"' }),
        placeholder({ id: 3, name: 'Content Placeholder 2', ph: 'idx="1"' }),
        FOOTER_PLACEHOLDERS
      ]
    },
    {
      type: 'twoObj',
      name: 'Two Content',
      shapes: [
        placeholder({ id: 2, name: 'Title 1', ph: 'type="title"' }),
        placeholder({
          id: 3,
          name: 'Content Placeholder 2',
          ph: 'sz="half" idx="1"',
          rect: { ...g.body, cx: half }
        }),
        placeholder({
          id: 4,
          name: 'Content Placeholder 3',
          ph: 'sz="half" idx="2"',
          rect: { ...g.body, x: g.body.x + half + 0.4 * inch, cx: half }
        }),
        FOOTER_PLACEHOLDERS
      ]
    },
    {
      type: 'titleOnly',
      name: 'Title Only',
      shapes: [placeholder({ id: 2, name: 'Title 1', ph: 'type="title"' }), FOOTER_PLACEHOLDERS]
    },
    { type: 'blank', name: 'Blank', shapes: [FOOTER_PLACEHOLDERS] }
  ];
}

function notesMasterXml() {
  return `${XML_HEAD}<p:notesMaster ${PML_NAMESPACES}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP_PROPS}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm({ x: 381000, y: 685800, cx: 6096000, cy: 3429000 })}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm({ x: 685800, y: 4400550, cx: 5486400, cy: 3600450 })}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Notes</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:notesStyle><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>`;
}

/**
 * Add a notes master (and its theme) to a package that has none, so slides
 * can carry speaker notes.
 *
 * @param {JSZip} zip
 * @param {Object} options
 * @param {string} options.themePath - Where to put the notes master's theme.
 * @returns {string} The notes master part path.
 */
export function addNotesMaster(zip, { themePath }) {
  const path = 'ppt/notesMasters/notesMaster1.xml';
  zip.file(path, notesMasterXml());
  zip.file(
    'ppt/notesMasters/_rels/notesMaster1.xml.rels',
    rels([['rId1', 'theme', `../theme/${themePath.split('/').pop()}`]])
  );
  zip.file(
    themePath,
    themeXml({
      name: 'Notes',
      colors: {
        text: '000000',
        dark2: '1F2937',
        primary: DEFAULT_COLORS.primary,
        accent: DEFAULT_COLORS.accent,
        palette: DEFAULT_COLORS.palette
      },
      majorFont: 'Calibri',
      minorFont: 'Calibri'
    })
  );
  return path;
}

export const NOTES_MASTER_TYPE = TYPES.notesMaster;
export const THEME_TYPE = TYPES.theme;

/**
 * Build the built-in template.
 *
 * @param {Object} [brand]
 * @param {string} [brand.primaryColor]
 * @param {string} [brand.accentColor]
 * @param {string} [brand.textColor]
 * @param {string} [brand.headingFont] - Office font name.
 * @param {string} [brand.bodyFont] - Office font name.
 * @param {{ data: Uint8Array, extension: string, width: number, height: number }} [brand.logo]
 * @param {'16:9'|'4:3'} [brand.aspectRatio]
 * @returns {Promise<Buffer>} A `.pptx` package without slides.
 */
export async function buildBaseTemplate(brand = {}) {
  const size = SLIDE_SIZES[brand.aspectRatio] || SLIDE_SIZES['16:9'];
  const primary = hex(brand.primaryColor, DEFAULT_COLORS.primary);
  const colors = {
    primary,
    accent: hex(brand.accentColor, DEFAULT_COLORS.accent),
    text: hex(brand.textColor, DEFAULT_COLORS.text),
    dark2: hex(brand.textColor, DEFAULT_COLORS.text),
    palette: DEFAULT_COLORS.palette
  };
  const logo =
    brand.logo?.data && brand.logo.width > 0 && brand.logo.height > 0
      ? { ...brand.logo, ratio: brand.logo.height / brand.logo.width }
      : null;
  const g = geometry(size, logo);
  const layoutList = layouts(g, logo, primary);
  const zip = new JSZip();
  const logoTarget = logo ? `../media/logo.${logo.extension === 'png' ? 'png' : 'jpeg'}` : null;
  if (logo) zip.file(`ppt/media/logo.${logo.extension === 'png' ? 'png' : 'jpeg'}`, logo.data);

  zip.file(
    'ppt/theme/theme1.xml',
    themeXml({
      name: 'iHub',
      colors,
      majorFont: brand.headingFont || 'Calibri',
      minorFont: brand.bodyFont || 'Calibri'
    })
  );
  zip.file('ppt/slideMasters/slideMaster1.xml', masterXml(g, layoutList.length));
  zip.file(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    rels([
      ...layoutList.map((_, i) => [
        `rId${i + 1}`,
        'slideLayout',
        `../slideLayouts/slideLayout${i + 1}.xml`
      ]),
      [`rId${layoutList.length + 1}`, 'theme', '../theme/theme1.xml'],
      ...(logoTarget ? [['rIdLogo', 'image', logoTarget]] : [])
    ])
  );
  layoutList.forEach((layout, i) => {
    zip.file(`ppt/slideLayouts/slideLayout${i + 1}.xml`, layoutXml(layout));
    zip.file(
      `ppt/slideLayouts/_rels/slideLayout${i + 1}.xml.rels`,
      rels([
        ['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml'],
        ...(logoTarget && layout.type === 'title' ? [['rIdLogo', 'image', logoTarget]] : [])
      ])
    );
  });
  addNotesMaster(zip, { themePath: 'ppt/theme/theme2.xml' });

  zip.file(
    'ppt/presentation.xml',
    `${XML_HEAD}<p:presentation ${PML_NAMESPACES} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst><p:sldSz cx="${size.cx}" cy="${size.cy}"/><p:notesSz cx="${NOTES_SIZE.cx}" cy="${NOTES_SIZE.cy}"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:defaultTextStyle></p:presentation>`
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    rels([
      ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
      ['rId2', 'notesMaster', 'notesMasters/notesMaster1.xml'],
      ['rId3', 'theme', 'theme/theme1.xml'],
      ['rId4', 'presProps', 'presProps.xml'],
      ['rId5', 'viewProps', 'viewProps.xml'],
      ['rId6', 'tableStyles', 'tableStyles.xml']
    ])
  );
  zip.file('ppt/presProps.xml', `${XML_HEAD}<p:presentationPr ${PML_NAMESPACES}/>`);
  zip.file(
    'ppt/viewProps.xml',
    `${XML_HEAD}<p:viewPr ${PML_NAMESPACES}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`
  );
  zip.file(
    'ppt/tableStyles.xml',
    `${XML_HEAD}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`
  );
  zip.file(
    'docProps/app.xml',
    `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>iHub Apps</Application></Properties>`
  );
  zip.file(
    '_rels/.rels',
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`
  );
  zip.file(
    'docProps/core.xml',
    `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>iHub Apps</dc:creator></cp:coreProperties>`
  );
  const overrides = [
    ['/ppt/presentation.xml', TYPES.presentation],
    ['/ppt/slideMasters/slideMaster1.xml', TYPES.master],
    ...layoutList.map((_, i) => [`/ppt/slideLayouts/slideLayout${i + 1}.xml`, TYPES.layout]),
    ['/ppt/theme/theme1.xml', TYPES.theme],
    ['/ppt/theme/theme2.xml', TYPES.theme],
    ['/ppt/notesMasters/notesMaster1.xml', TYPES.notesMaster],
    ['/ppt/presProps.xml', TYPES.presProps],
    ['/ppt/viewProps.xml', TYPES.viewProps],
    ['/ppt/tableStyles.xml', TYPES.tableStyles],
    ['/docProps/core.xml', TYPES.core],
    ['/docProps/app.xml', TYPES.app]
  ];
  zip.file(
    '[Content_Types].xml',
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>${overrides
      .map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`)
      .join('')}</Types>`
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
