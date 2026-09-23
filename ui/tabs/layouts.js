// ui/tabs/layouts.js
// The Layouts tab: every layout of every reached file as FileMaker folds it, and -- for
// the selected one -- fm's parts and objects drawn as a wireframe at fm's own layout
// coordinates. A pure renderer: no document, every fm key read through access.js, every
// string escaped.
//
// Coordinates: a top-level object's `bounds` are layout coordinates, but a *nested*
// object's are relative to its container. Measured on the ooe fixture: of 52 nested
// objects, 36 report bounds that fall outside their parent's box, and every container
// whose own origin is not 0,0 (popover, portal, tabControl, slideControl, buttonBar,
// group) has children starting near 0,0. So the walk carries an origin and adds it.
import { badge, count, esc, kv, link, matches, rereadObjectButton, section, table } from '../dom.js';
import { get, path } from '../access.js';
import { catalogActions, detailOf, listOf, selectionKey, selectionWithTail, totalsLine } from './common.js';

const layoutsOf = (file) => listOf(file, 'layout');
const entryOf = (file, id) => detailOf(file, 'layout', id);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const boundsOf = (obj) => {
  const b = get(obj, 'bounds');
  return { left: num(get(b, 'left')), top: num(get(b, 'top')), width: num(get(b, 'width')), height: num(get(b, 'height')) };
};

/** fm nests children under `objects` today; `panels` and `segments` are in the contract
 *  for tab/slide controls and button bars, so the walk descends all three. `fn` is called
 *  with the object, its depth, and the absolute origin its own bounds are relative to. */
const CHILD_KEYS = ['objects', 'panels', 'segments'];

export function walkObjects(objects, fn, depth = 0, origin = { left: 0, top: 0 }) {
  for (const obj of objects ?? []) {
    if (obj === null || typeof obj !== 'object') continue;
    fn(obj, depth, origin);
    const b = boundsOf(obj);
    const inner = { left: origin.left + b.left, top: origin.top + b.top };
    for (const key of CHILD_KEYS) {
      const kids = get(obj, key);
      if (Array.isArray(kids)) walkObjects(kids, fn, depth + 1, inner);
    }
  }
}

/** The named counts are the ones the totals line and the layout table read; `byType`
 *  and `byControl` are the whole truth, so a type ooe does not carry still shows. */
export function objectCounts(detail) {
  const byType = {};
  const byControl = {};
  let total = 0;
  walkObjects(path(detail, 'contents.objects'), (obj) => {
    total += 1;
    const type = String(get(obj, 'type') ?? 'unknown');
    byType[type] = (byType[type] ?? 0) + 1;
    const control = get(obj, 'control');
    if (control) byControl[String(control)] = (byControl[String(control)] ?? 0) + 1;
  });
  const of = (type) => byType[type] ?? 0;
  return {
    total, byType, byControl,
    portals: of('portal'), webViewers: of('webViewer'), tabControls: of('tabControl'),
    slideControls: of('slideControl'), popovers: of('popover'), buttonBars: of('buttonBar'),
    charts: of('chart'),
  };
}

/** Every row walks every object of its layout, and the tab asks for the rows
 *  several times per render (the tree, the totals, the Themes tab). The answer
 *  is memoised per file on the identity of `catalogs.layout.detailById`, which
 *  is what a re-read replaces at either grain: a catalog re-read stages a whole
 *  new slot, and an object re-read replaces `detailById` (see ui/model.js). */
const layoutRowsCache = new WeakMap();

export function layoutRows(file) {
  const details = path(file, 'catalogs.layout.detailById');
  const hit = layoutRowsCache.get(file);
  if (hit && hit.details === details) return hit.rows;
  const rows = computeLayoutRows(file);
  if (file !== null && typeof file === 'object') layoutRowsCache.set(file, { details, rows });
  return rows;
}

/** fm's flattened list carries three types: `layout`, `folder` and `separator` (the
 *  divider FileMaker draws). Only a layout gets a row. */
function computeLayoutRows(file) {
  return layoutsOf(file).filter((item) => get(item, 'type') === 'layout').map((item) => {
    const id = get(item, 'id');
    const entry = entryOf(file, id);
    const detail = get(entry, 'result');
    const counts = objectCounts(detail);
    return {
      id, counts, target: file.target, key: selectionKey(file.target, id), file: file.name ?? file.target,
      name: String(get(detail, 'name') ?? get(item, 'name') ?? ''),
      folder: String(get(item, 'folder') ?? ''),
      hidden: get(item, 'hidden') === true,
      occurrence: String(path(item, 'tableOccurrence.name') ?? path(detail, 'tableOccurrence.name') ?? ''),
      theme: String(path(detail, 'theme.displayName') ?? ''),
      triggers: num(path(detail, 'scriptTriggerCount')),
      objects: counts.total, portals: counts.portals, webViewers: counts.webViewers,
      parts: (path(detail, 'parts') ?? []).length,
      error: get(entry, 'error') ?? null,
    };
  });
}

/** How tall the drawing has to be: the bottom of the last part, fm's own bodyHeight,
 *  and the bottom of the lowest object -- whichever of those is defined and largest. */
function totalHeight(detail) {
  const heights = (path(detail, 'parts') ?? []).map((p) => num(get(p, 'offset')) + num(get(p, 'height')));
  const bodyHeight = Number(path(detail, 'geometry.bodyHeight'));
  if (Number.isFinite(bodyHeight)) heights.push(bodyHeight);
  walkObjects(path(detail, 'contents.objects'), (obj, depth, origin) => {
    const b = boundsOf(obj);
    heights.push(origin.top + b.top + b.height);
  });
  return Math.max(0, ...heights);
}

/** The thing an object shows: a field name, a label's text, an object's own name, a
 *  popover's title, a portal's occurrence -- whichever fm gives it. */
const whatOf = (obj) => path(obj, 'field.name') ?? get(obj, 'text') ?? get(obj, 'name')
  ?? get(obj, 'title') ?? path(obj, 'tableOccurrence.name') ?? '';

/** The tooltip: type, control style when it has one, and what it shows. */
function objectTitle(obj) {
  return [get(obj, 'type'), get(obj, 'control'), whatOf(obj)]
    .filter((p) => p !== undefined && p !== null && p !== '').map((p) => esc(p)).join(' &middot; ');
}

function partSvg(part, width) {
  const [offset, height] = [num(get(part, 'offset')), num(get(part, 'height'))];
  const type = String(get(part, 'type') ?? 'part');
  return `<rect class="part ${esc(type)}" x="0" y="${offset}" width="${width}" height="${height}"/>`
    + `<text class="part-label" x="4" y="${offset + 12}">${esc(get(part, 'name') ?? type)}</text>`;
}

/** `key` is the layout's own `<target>|<id>`, the same string the Objects table
 *  rows carry, so a rect's `data-select` names exactly the row a click on the
 *  picture should select -- the shell's `[data-select]` delegation needs no
 *  SVG-specific handling. Omitted (no `key`) when the caller has none to give,
 *  the way the bare renderer is exercised in tests. */
function objectSvg(obj, origin, highlight, key) {
  const b = boundsOf(obj);
  const id = get(obj, 'id');
  const on = highlight !== null && highlight !== undefined && String(highlight) === String(id);
  const select = key ? ` data-select="${esc(key)}#${esc(id)}"` : '';
  return `<rect class="obj ${esc(get(obj, 'type') ?? 'unknown')}${on ? ' highlight' : ''}" data-object="${esc(id)}"${select}`
    + ` x="${origin.left + b.left}" y="${origin.top + b.top}" width="${b.width}" height="${b.height}">`
    + `<title>${objectTitle(obj)}</title></rect>`;
}

/** The layout as fm reports it: the part bands first, then every object over them, in
 *  fm's own order so a container is painted before what it holds. `opts.key`, when
 *  given, is the layout's own selection key, so every object rect becomes clickable. */
export function wireframeSvg(detail, opts = {}) {
  const width = num(path(detail, 'geometry.baseWidth'));
  const height = totalHeight(detail);
  const bands = (path(detail, 'parts') ?? []).map((p) => partSvg(p, width)).join('');
  let objects = '';
  walkObjects(path(detail, 'contents.objects'), (obj, depth, origin) => {
    objects += objectSvg(obj, origin, opts.highlight, opts.key);
  });
  return `<svg class="wireframe" viewBox="0 0 ${width} ${height}" role="img" preserveAspectRatio="xMinYMin meet">`
    + bands + objects + '</svg>';
}

/** `<target>|<layout id>`, optionally `#<object id>` to highlight one object.
 *  The object rides inside the tab's own part, because it is a coordinate within
 *  the layout rather than a second thing to select. */
export const selectionOf = (view) => selectionWithTail(view?.selection, 'object');

function totals(solution) {
  const rows = Object.values(solution.files).flatMap(layoutRows);
  const sum = (key) => rows.reduce((n, r) => n + r.counts[key], 0);
  const pairs = [
    ['Layouts', rows.length],
    ['Objects', sum('total')],
    ['Portals', sum('portals')],
    ['Web viewers', sum('webViewers')],
    ['Tab controls', sum('tabControls')],
    ['Slide controls', sum('slideControls')],
    ['Popovers', sum('popovers')],
    ['Button bars', sum('buttonBars')],
  ];
  return totalsLine(pairs);
}

/** A folder's own key is its full path, the same spelling a layout's `folder` carries,
 *  so a folder holding no layouts still shows. */
function folders(file) {
  const groups = new Map();
  const at = (folder) => {
    if (!groups.has(folder)) groups.set(folder, { folder, rows: [] });
    return groups.get(folder);
  };
  for (const item of layoutsOf(file)) {
    if (get(item, 'type') !== 'folder') continue;
    at([get(item, 'folder'), get(item, 'name')].filter(Boolean).join('/'));
  }
  for (const row of layoutRows(file)) at(row.folder).rows.push(row);
  return [...groups.values()];
}

function treeRow(row, selection, filter) {
  if (!matches(row.name, filter) && !matches(row.occurrence, filter)) return '';
  const cls = row.key === selection ? ' class="selected"' : '';
  const badges = [
    row.hidden ? badge('hidden', 'muted') : '',
    row.error ? badge('unread', 'warn') : '',
    row.portals ? badge(`${row.portals} portal`, 'info') : '',
  ].filter(Boolean).join(' ');
  return `<li data-select="${esc(row.key)}"${cls}>${link(`layouts/${row.key}`, row.name)}`
    + ` <span class="muted">${esc(row.occurrence)} &middot; ${esc(row.theme)}</span>`
    + ` ${count(row.objects)} obj &middot; ${count(row.triggers)} trig ${badges}</li>`;
}

function renderList(solution, view) {
  // The row is marked by the LAYOUT the selection names: a `#<object id>` tail
  // is a coordinate inside the open layout, not a different row, so the tree
  // must not lose its highlight the moment a link lands on an object (the same
  // bug fixed for the Scripts tree in commit a1adfc2).
  const sel = selectionOf(view);
  const open = sel ? selectionKey(sel.target, sel.id) : null;
  const body = Object.values(solution.files).map((file) => {
    const groups = folders(file).map((group) => {
      // A folder whose name matches shows all of its layouts; otherwise only the
      // matching ones, and a folder left with none drops out.
      const wanted = matches(group.folder, view.filter) ? '' : view.filter;
      const rows = group.rows.map((r) => treeRow(r, open, wanted)).filter(Boolean);
      if (!rows.length && view.filter) return '';
      return `<details open><summary>${esc(group.folder || '(root)')} ${count(rows.length)}</summary>`
        + (rows.length ? `<ul class="tree">${rows.join('')}</ul>` : '<p class="empty">No layouts</p>')
        + '</details>';
    }).filter(Boolean).join('');
    const title = view.multiFile ? `<h3>${esc(file.name ?? file.target)}</h3>` : '';
    return title + (groups || '<p class="empty">No layouts</p>');
  }).join('');
  return section('Layouts', totals(solution) + body, { actions: catalogActions(solution, 'layout', view, 'layouts') });
}

// Layout Setup, which fm 0.8.0 GA reports as named keys where 0.8.0-beta.0 and
// earlier gave a packed options word this tab could not decode. Grouped and labelled
// the way FileMaker's own Layout Setup dialog groups them, not the way fm spells the
// keys: a reader looking for "save record changes automatically" is looking for the
// checkbox they know.
//
// Each group is [heading, path, booleans, values]. `booleans` render as badges, only
// the ones that are ON, because twenty-four yes/no rows is a wall a reader does not
// read; the ones that are OFF ride in the title so they stay discoverable. `values`
// render as rows, because a grid colour or a row height is not a flag.
const LAYOUT_BOOLEANS = [
  ['quickFind', 'quick find'],
  ['saveRecordChangesAutomatically', 'save record changes automatically'],
  ['showCurrentRecordIndicator', 'current record indicator'],
  ['delineateCurrentRecordOnly', 'delineate current record only'],
  ['showFieldAlerts', 'field alerts'],
  ['showFieldFramesWhenActive', 'field frames when active'],
  ['textRuler', 'text ruler'],
  ['verticalPartLabels', 'vertical part labels'],
];
const TABLE_VIEW_BOOLEANS = [
  ['columnHeaders', 'column headers'], ['resizableColumns', 'resizable columns'],
  ['reorderableColumns', 'reorderable columns'], ['customColumnOrder', 'custom column order'],
  ['sortOnSelect', 'sort on select'], ['rowNumbers', 'row numbers'],
  ['horizontalGrid', 'horizontal grid'], ['verticalGrid', 'vertical grid'],
  ['alternatingRowColors', 'alternating row colours'], ['comfortableFormatting', 'comfortable formatting'],
  ['systemAppearance', 'system appearance'], ['includeHeader', 'include header'],
  ['includeFooter', 'include footer'], ['includeTopNav', 'include top nav'],
  ['includeBottomNav', 'include bottom nav'],
];

const yesNo = (v) => (v === true ? 'yes' : 'no');

/** One group: the badges for what is on, then a row per value fm reported. Returns ''
 *  when fm reported nothing in the group, so a layout that has no table view does not
 *  grow an empty "Table view" heading. */
function propertyGroup(heading, source, booleans, values) {
  if (source === undefined || source === null) return '';
  const present = booleans.filter(([key]) => get(source, key) !== undefined);
  const rows = values.filter(([, , read]) => read(source) !== undefined && read(source) !== null);
  if (!present.length && !rows.length) return '';
  const on = present.filter(([key]) => get(source, key) === true).map(([, label]) => badge(label, 'info'));
  const title = present.map(([key, label]) => `${label}: ${yesNo(get(source, key))}`).join(', ');
  const badgeLine = present.length
    ? `<p${title ? ` title="${esc(title)}"` : ''}>${on.length ? on.join(' ') : '<span class="muted">none set</span>'}</p>`
    : '';
  const kv = rows.length
    ? `<dl class="kv">${rows.map(([, label, read]) => `<dt>${esc(label)}</dt><dd>${read(source)}</dd>`).join('')}</dl>`
    : '';
  return `<h4>${esc(heading)}</h4>${badgeLine}${kv}`;
}

/** The Properties section, omitted entirely when fm reports none of Layout Setup --
 *  an empty section header is a promise of content the read cannot keep. */
function propertiesSection(detail) {
  const html = layoutProperties(detail);
  return html ? `<h3>Properties</h3>${html}` : '';
}

/** Layout Setup as fm now reports it. Pure: returns '' when there is nothing to say. */
export function layoutProperties(detail) {
  const grid = (tv) => {
    const style = get(tv, 'gridStyle');
    const colour = get(tv, 'gridColor');
    if (style === undefined && colour === undefined) return undefined;
    return [style, colour].filter((x) => x !== undefined && x !== null).map((x) => esc(String(x))).join(' &middot; ');
  };
  const columns = (pr) => {
    const c = get(pr, 'columns');
    if (c === undefined || c === null) return undefined;
    const count = get(c, 'count');
    const width = get(c, 'width');
    return `${esc(String(count))} columns${width === undefined ? '' : ` &middot; ${esc(String(width))} wide`}`;
  };
  const margins = (pr) => {
    const m = get(pr, 'pageMargins');
    if (m === undefined || m === null) return undefined;
    return ['left', 'top', 'right', 'bottom'].map((s) => esc(String(get(m, s) ?? ''))).join(' / ');
  };
  const groups = [
    propertyGroup('General', detail, LAYOUT_BOOLEANS, []),
    propertyGroup('Table view', get(detail, 'tableView'), TABLE_VIEW_BOOLEANS, [
      ['grid', 'Grid', grid],
      ['rowHeight', 'Row height', (tv) => { const h = get(tv, 'rowHeight'); return h === undefined ? undefined : esc(String(h)); }],
    ]),
    propertyGroup('Printing', get(detail, 'printing'), [['facingPages', 'facing pages']], [
      ['flowOrder', 'Flow order', (pr) => { const f = get(pr, 'flowOrder'); return f === undefined ? undefined : esc(String(f)); }],
      ['columns', 'Columns', columns],
      ['pageMargins', 'Margins (l/t/r/b)', margins],
    ]),
  ];
  return groups.filter(Boolean).join('');
}

// The Part Definition dialog, which fm 0.8.0 reports for the first time as
// `parts[].pagination` and, on the body, `parts[].rowState`. Each entry is
// [key, label]. `breakAfterEvery` is deliberately not in this list: it is the one
// member that is not a boolean -- fm reports null when it is not set and a count when
// it is -- so it renders its value rather than its presence.
const PAGINATION_OPTIONS = [
  ['breakBefore', 'break before'],
  ['restartPageNumbers', 'restart page numbers'],
  ['allowBreakAcrossPages', 'allow break across pages'],
  ['discardRemainder', 'discard remainder'],
];
const ROW_STATE_OPTIONS = [['useAlternate', 'alternate rows'], ['useActive', 'active row']];

/** What a part's Part Definition dialog has switched on, as badges.
 *
 *  Three states a reader has to tell apart, because fm reports all three and they
 *  mean different things:
 *
 *    no `pagination` object   this part TYPE has no Part Definition options at all.
 *                             Measured on ooe: topNavigation, bottomNavigation and
 *                             titleFooter carry none, a header carries
 *                             restartPageNumbers alone, a body carries all five.
 *    present, nothing on      the part has the options and none of them is set.
 *    present, some on         one badge per option that is on.
 *
 *  Rendering the first two alike would say "nothing is set here" about a part that
 *  cannot have anything set -- the same lie the Solution tab's `field` row exists to
 *  avoid. The title carries every member fm reported with its value, so an option
 *  that is OFF stays discoverable on hover instead of being merely absent. */
export function partDefinition(part) {
  const pagination = get(part, 'pagination');
  const rowState = get(part, 'rowState');
  if (pagination === undefined && rowState === undefined) {
    const type = String(get(part, 'type') ?? 'part');
    return `<span class="muted" title="${esc(`fm reports no Part Definition options for a ${type} part`)}">n/a</span>`;
  }
  const badges = [];
  for (const [key, label] of PAGINATION_OPTIONS) if (get(pagination, key) === true) badges.push(badge(label, 'info'));
  const every = get(pagination, 'breakAfterEvery');
  if (every !== undefined && every !== null && every !== false) badges.push(badge(`break after every ${every}`, 'info'));
  for (const [key, label] of ROW_STATE_OPTIONS) if (get(rowState, key) === true) badges.push(badge(label, 'info'));
  const reported = [...Object.entries(pagination ?? {}), ...Object.entries(rowState ?? {})]
    .map(([k, v]) => `${k}: ${v === null ? 'not set' : v}`).join(', ');
  const title = reported ? ` title="${esc(reported)}"` : '';
  return badges.length
    ? `<span${title}>${badges.join(' ')}</span>`
    : `<span class="muted"${title}>none set</span>`;
}

const PART_COLUMNS = [
  { key: 'type', label: 'Part' },
  { key: 'name', label: 'Name' },
  { key: 'height', label: 'Height', num: true, render: (r) => count(r.height) },
  { key: 'offset', label: 'Offset', num: true, render: (r) => count(r.offset) },
  { key: 'breakField', label: 'Break field' },
  { key: 'partDefinition', label: 'Part Definition', render: (r) => r.partDefinition },
];

function partRows(detail) {
  return (path(detail, 'parts') ?? []).map((p) => ({
    type: String(get(p, 'type') ?? ''), name: String(get(p, 'name') ?? ''),
    height: num(get(p, 'height')), offset: num(get(p, 'offset')),
    breakField: String(path(p, 'breakField.name') ?? ''),
    partDefinition: partDefinition(p),
  }));
}

/** The nesting indent rides on `--depth`, the way the script step list carries
 *  its own block depth (ui/tabs/scripts.js), rather than padding characters
 *  baked into the cell's text -- a stylesheet renders it, a test measures the
 *  field directly instead of counting characters. */
const OBJECT_COLUMNS = [
  { key: 'type', label: 'Type', render: (r) => `<span class="obj-type" style="--depth:${r.depth}">${esc(r.type)}</span>` },
  { key: 'control', label: 'Control' },
  { key: 'what', label: 'Name / text' },
  { key: 'bounds', label: 'Bounds' },
  { key: 'style', label: 'Style' },
  { key: 'flags', label: 'Flags', render: (r) => r.flags },
];

function objectRows(detail, key) {
  const rows = [];
  walkObjects(path(detail, 'contents.objects'), (obj, depth, origin) => {
    const b = boundsOf(obj);
    const id = get(obj, 'id');
    rows.push({
      id,
      key: `${key}#${id}`,
      depth,
      type: String(get(obj, 'type') ?? ''),
      control: String(get(obj, 'control') ?? ''),
      what: String(whatOf(obj)),
      bounds: `${origin.left + b.left}, ${origin.top + b.top} · ${b.width}×${b.height}`,
      style: String(get(obj, 'style') ?? ''),
      flags: [get(obj, 'locked') === true ? badge('locked', 'warn') : '',
        get(obj, 'hideWhenPrinting') === true ? badge('no print', 'muted') : '',
        get(obj, 'hideCondition') ? badge('hide when', 'info') : ''].filter(Boolean).join(' '),
    });
  });
  return rows;
}

function legend(counts) {
  const chips = Object.entries(counts.byType).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, n]) => `<li><span class="obj ${esc(type)}"></span>${esc(type)} ${count(n)}</li>`).join('');
  return chips ? `<ul class="legend">${chips}</ul>` : '';
}

function detailPairs(detail, counts) {
  const enabled = Object.entries(path(detail, 'viewStyles.enabled') ?? {}).filter(([, on]) => on === true).map(([v]) => v);
  const g = path(detail, 'geometry') ?? {};
  return [
    ['Id', esc(get(detail, 'id'))],
    ['Folder', esc(get(detail, 'folder')) || '(root)'],
    ['Occurrence', esc(path(detail, 'tableOccurrence.name'))
      + ` <span class="muted">of ${esc(path(detail, 'tableOccurrence.table.name'))}</span>`],
    ['Theme', `${esc(path(detail, 'theme.displayName'))} <span class="muted">(${esc(path(detail, 'theme.group'))})</span>`],
    ['View styles', `${esc(path(detail, 'viewStyles.default'))} <span class="muted">enabled: ${esc(enabled.join(', ')) || 'none'}</span>`],
    ['Flags', path(detail, 'flags.areDefaults') === true ? 'defaults' : esc((path(detail, 'flags.set') ?? []).join(', ')) || 'none'],
    ['Geometry', `${num(get(g, 'baseWidth'))} ${esc(get(g, 'units'))} wide, body ${num(get(g, 'bodyHeight'))}`
      + ` <span class="muted">${esc(get(g, 'layoutType'))}, ${esc(get(g, 'orientation'))}, ${esc(get(g, 'clientType'))}</span>`],
    ['Triggers', count(get(detail, 'scriptTriggerCount'))
      + ` <span class="muted">${esc((get(detail, 'scriptTriggers') ?? []).map((t) => get(t, 'event')).join(', '))}</span>`],
    ['Contents', `${count(counts.total)} objects <span class="muted">fm counts ${esc(path(detail, 'contents.fieldCount'))} fields,`
      + ` ${esc(path(detail, 'contents.portalCount'))} portals, ${esc(path(detail, 'contents.webViewerCount'))} web viewers,`
      + ` ${esc(path(detail, 'contents.unmodelledCount'))} it could not model</span>`],
    ['Modified', `${esc(path(detail, 'modified.timestamp'))} <span class="muted">by ${esc(path(detail, 'modified.account'))}</span>`],
  ];
}

function renderSelected(solution, view) {
  const sel = selectionOf(view);
  const file = sel && solution.files[sel.target];
  if (!file) return '';
  const entry = entryOf(file, sel.id);
  if (!entry) return '';
  const detail = get(entry, 'result');
  const item = layoutsOf(file).find((i) => String(get(i, 'id')) === sel.id);
  const name = get(detail, 'name') ?? get(item, 'name') ?? sel.id;
  const title = `Layout ${name}${view.multiFile ? ` (${file.name ?? file.target})` : ''}`;
  const actions = rereadObjectButton({ kind: 'object', target: file.target, catalog: 'layout', key: String(sel.id) }, 'Re-read layout');
  const error = get(entry, 'error');
  if (error || !detail) {
    return section(title, `<p class="error">${esc(get(error, 'code') ?? 'unread')}: `
      + `${esc(get(error, 'message') ?? 'no describe for this layout')}</p>`, { actions });
  }
  const counts = objectCounts(detail);
  const key = selectionKey(file.target, sel.id);
  const rows = objectRows(detail, key).filter((r) => matches(r.type, view.filter) || matches(r.what, view.filter)
    || matches(r.control, view.filter) || matches(r.style, view.filter));
  const body = kv(detailPairs(detail, counts))
    + propertiesSection(detail)
    + '<h3>Parts</h3>' + table(PART_COLUMNS, partRows(detail), { empty: 'No parts' })
    + '<h3>Wireframe</h3>'
    + `<div class="wireframe-wrap">${wireframeSvg(detail, { highlight: sel.object, key })}</div>`
    + legend(counts)
    + '<h3>Objects</h3>' + table(OBJECT_COLUMNS, rows, {
      empty: 'No objects',
      rowAttrs: (r) => `data-select="${esc(r.key)}"${sel.object !== null && String(r.id) === sel.object ? ' class="selected"' : ''}`,
    });
  return section(title, body, { actions });
}

export const tab = {
  id: 'layouts',
  label: 'Layouts',
  render(solution, view = {}) {
    return renderSelected(solution, view) + renderList(solution, view);
  },
};
