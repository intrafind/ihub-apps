# Complete `web-artifacts` examples

Four finished artifacts, one per kind of job. Read the one closest to the task, **keep its structure and replace its content**: the figures, names and texts below are invented example data, never facts to reuse. Each passes the checks of `create_web_artifact` without a problem or a note, works in light and dark mode, on a phone and with the keyboard, and asks follow-up questions only where the chat can answer them.

| #   | Job                                 | Shows how to                                                         |
| --- | ----------------------------------- | -------------------------------------------------------------------- |
| 1   | KPI overview with a clickable chart | Theme tokens, KPI strip, inline SVG bars, `sendPrompt` per bar       |
| 2   | Calculator                          | Sliders with live results, number formatting, a reset                |
| 3   | Data explorer                       | Search, filter and sortable columns over embedded rows               |
| 4   | Clickable diagram                   | SVG nodes with a detail panel, keyboard focus, "ask about this step" |

Two habits carry over to every artifact: an SVG with text gets a `viewBox` about as wide as the space it fills on a phone (around 360), or a sideways-scrolling box with a `min-width`, so its text never shrinks below about 11 px; and every click target is also reachable with Tab and Enter.

After the first version, change an artifact with `edit_web_artifact` (see the end of this file), not by sending the whole file again.

## 1. KPI overview with a clickable chart

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Regional sales Q3</title>
<style>
  :root { --bg:#f8fafc; --surface:#fff; --border:#e2e8f0; --text:var(--brand-text,#0f172a); --muted:#64748b; --primary:var(--brand-primary,#1e3a8a); }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#0b0f19; --surface:#111827; --border:#1e293b; --text:#f1f5f9; --muted:#94a3b8; --primary:#93c5fd; } }
  :root[data-theme="dark"] { --bg:#0b0f19; --surface:#111827; --border:#1e293b; --text:#f1f5f9; --muted:#94a3b8; --primary:#93c5fd; }
  * { box-sizing:border-box; margin:0; }
  body { font-family:var(--brand-font,system-ui,sans-serif); background:var(--bg); color:var(--text); padding:20px; line-height:1.5; }
  h1 { font-size:1.25rem; } .sub { color:var(--muted); font-size:.875rem; margin-bottom:16px; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:20px; }
  .kpi { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:12px 14px; }
  .kpi b { display:block; font-size:1.5rem; font-variant-numeric:tabular-nums; }
  .kpi span { color:var(--muted); font-size:.8rem; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:16px; }
  .bar rect { fill:var(--primary); } .bar:hover rect, .bar:focus rect { opacity:.8; }
  .bar { cursor:pointer; outline:none; } .bar:focus-visible rect { stroke:var(--text); stroke-width:2; }
  #chart { display:block; width:100%; max-width:560px; }
  svg text { fill:var(--text); font-size:12px; } .hint { color:var(--muted); font-size:.8rem; margin-top:8px; }
</style>
</head>
<body>
  <h1>Regional sales, Q3 2026</h1>
  <p class="sub">Example data · in € thousand</p>
  <section class="kpis" id="kpis"></section>
  <section class="card">
    <svg id="chart" viewBox="0 0 360 220" role="img" aria-label="Sales by region"></svg>
    <p class="hint" id="hint"></p>
  </section>
<script>
  const regions = [
    { name: 'North', sales: 1240, growth: 8.1 },
    { name: 'South', sales: 980, growth: -2.4 },
    { name: 'East', sales: 760, growth: 12.6 },
    { name: 'West', sales: 1105, growth: 3.2 }
  ];
  const fmt = new Intl.NumberFormat(document.documentElement.lang);
  const total = regions.reduce((sum, r) => sum + r.sales, 0);
  const best = regions.reduce((a, b) => (b.growth > a.growth ? b : a));
  document.getElementById('kpis').innerHTML = [
    ['Total sales', fmt.format(total)],
    ['Regions', regions.length],
    ['Fastest growth', best.name + ' +' + best.growth + '\u00a0%']
  ].map(([label, value]) => `<div class="kpi"><b>${value}</b><span>${label}</span></div>`).join('');

  const canAsk = Boolean(window.sendPrompt && sendPrompt.available);
  const max = Math.max(...regions.map(r => r.sales));
  const svg = document.getElementById('chart');
  svg.innerHTML = regions.map((r, i) => {
    const w = Math.round((r.sales / max) * 170);
    const y = 20 + i * 48;
    return `<g class="bar" tabindex="0" role="button" data-i="${i}" aria-label="${r.name}: ${fmt.format(r.sales)}">
      <text x="0" y="${y + 20}">${r.name}</text>
      <rect x="56" y="${y}" width="${w}" height="30" rx="4"></rect>
      <text x="${62 + w}" y="${y + 20}">${fmt.format(r.sales)} (${r.growth > 0 ? '+' : ''}${r.growth} %)</text>
      <title>${r.name}: ${fmt.format(r.sales)}</title></g>`;
  }).join('');
  document.getElementById('hint').textContent = canAsk
    ? 'Click a bar (or press Enter on it) to ask about that region.'
    : 'Figures per region; growth against Q2.';

  function ask(i) {
    const r = regions[i];
    if (canAsk) sendPrompt(`Why did sales in region ${r.name} change by ${r.growth} % in Q3 2026 (${fmt.format(r.sales)} thousand €)?`);
  }
  svg.addEventListener('click', e => { const g = e.target.closest('.bar'); if (g) ask(Number(g.dataset.i)); });
  svg.addEventListener('keydown', e => {
    const g = e.target.closest('.bar');
    if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ask(Number(g.dataset.i)); }
  });
</script>
</body>
</html>
```

## 2. Calculator

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Loan calculator</title>
<style>
  :root { --bg:#f8fafc; --surface:#fff; --border:#e2e8f0; --text:var(--brand-text,#0f172a); --muted:#64748b; --primary:var(--brand-primary,#1e3a8a); }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#0b0f19; --surface:#111827; --border:#1e293b; --text:#f1f5f9; --muted:#94a3b8; --primary:#93c5fd; } }
  :root[data-theme="dark"] { --bg:#0b0f19; --surface:#111827; --border:#1e293b; --text:#f1f5f9; --muted:#94a3b8; --primary:#93c5fd; }
  * { box-sizing:border-box; margin:0; }
  body { font-family:var(--brand-font,system-ui,sans-serif); background:var(--bg); color:var(--text); padding:20px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:16px; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:16px; }
  label { display:block; margin:12px 0 4px; font-size:.875rem; }
  label output { float:right; font-variant-numeric:tabular-nums; font-weight:600; }
  input[type=range] { width:100%; accent-color:var(--primary); }
  .result b { display:block; font-size:2rem; font-variant-numeric:tabular-nums; color:var(--primary); }
  .row { display:flex; justify-content:space-between; padding:6px 0; border-top:1px solid var(--border); font-variant-numeric:tabular-nums; }
  button { margin-top:14px; padding:6px 12px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--text); cursor:pointer; }
</style>
</head>
<body>
  <h1 style="font-size:1.25rem;margin-bottom:12px">Loan calculator</h1>
  <div class="grid">
    <form class="card" id="form">
      <label for="amount">Amount <output id="amountOut"></output></label>
      <input id="amount" type="range" min="10000" max="500000" step="5000" value="200000">
      <label for="rate">Interest rate <output id="rateOut"></output></label>
      <input id="rate" type="range" min="0.5" max="9" step="0.1" value="3.8">
      <label for="years">Term <output id="yearsOut"></output></label>
      <input id="years" type="range" min="1" max="35" step="1" value="20">
      <button type="reset">Reset</button>
    </form>
    <section class="card result" aria-live="polite">
      <span>Monthly payment</span><b id="monthly"></b>
      <div class="row"><span>Total paid</span><span id="totalPaid"></span></div>
      <div class="row"><span>Total interest</span><span id="interest"></span></div>
    </section>
  </div>
<script>
  const money = new Intl.NumberFormat(document.documentElement.lang, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const $ = id => document.getElementById(id);
  function update() {
    const amount = Number($('amount').value);
    const rate = Number($('rate').value) / 100 / 12;
    const months = Number($('years').value) * 12;
    const monthly = rate === 0 ? amount / months : (amount * rate) / (1 - Math.pow(1 + rate, -months));
    $('amountOut').textContent = money.format(amount);
    $('rateOut').textContent = $('rate').value + ' %';
    $('yearsOut').textContent = $('years').value + ' years';
    $('monthly').textContent = money.format(monthly);
    $('totalPaid').textContent = money.format(monthly * months);
    $('interest').textContent = money.format(monthly * months - amount);
  }
  $('form').addEventListener('input', update);
  $('form').addEventListener('reset', () => setTimeout(update, 0));
  update();
</script>
</body>
</html>
```

## 3. Data explorer

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Open tickets</title>
<style>
  :root { --bg:#f8fafc; --surface:#fff; --border:#e2e8f0; --text:var(--brand-text,#0f172a); --muted:#64748b; --bad:#b91c1c; --ok:#047857; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#0b0f19; --surface:#111827; --border:#1e293b; --text:#f1f5f9; --muted:#94a3b8; --bad:#fca5a5; --ok:#6ee7b7; } }
  :root[data-theme="dark"] { --bg:#0b0f19; --surface:#111827; --border:#1e293b; --text:#f1f5f9; --muted:#94a3b8; --bad:#fca5a5; --ok:#6ee7b7; }
  * { box-sizing:border-box; margin:0; }
  body { font-family:var(--brand-font,system-ui,sans-serif); background:var(--bg); color:var(--text); padding:20px; }
  .tools { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0; }
  input, select { padding:6px 8px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--text); }
  .wrap { overflow-x:auto; background:var(--surface); border:1px solid var(--border); border-radius:10px; }
  table { border-collapse:collapse; width:100%; font-size:.875rem; }
  th, td { padding:8px 10px; text-align:left; border-bottom:1px solid var(--border); white-space:nowrap; }
  th button { all:unset; cursor:pointer; font-weight:600; } th button:focus-visible { outline:2px solid currentColor; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; }
  .high { color:var(--bad); font-weight:600; } .low { color:var(--ok); }
  .count { color:var(--muted); font-size:.8rem; margin-top:8px; }
</style>
</head>
<body>
  <h1 style="font-size:1.25rem">Open tickets</h1>
  <div class="tools">
    <input id="q" type="search" placeholder="Search title or team" aria-label="Search">
    <select id="prio" aria-label="Priority"><option value="">All priorities</option><option>high</option><option>medium</option><option>low</option></select>
  </div>
  <div class="wrap"><table>
    <thead><tr id="head"></tr></thead>
    <tbody id="body"></tbody>
  </table></div>
  <p class="count" id="count" aria-live="polite"></p>
<script>
  const columns = [
    { key: 'id', label: 'ID' }, { key: 'title', label: 'Title' }, { key: 'team', label: 'Team' },
    { key: 'priority', label: 'Priority' }, { key: 'age', label: 'Age (days)', num: true }
  ];
  const rows = [
    { id: 'T-101', title: 'Login fails on SSO', team: 'Identity', priority: 'high', age: 3 },
    { id: 'T-102', title: 'Export takes too long', team: 'Reports', priority: 'medium', age: 12 },
    { id: 'T-103', title: 'Typo in footer', team: 'Web', priority: 'low', age: 30 },
    { id: 'T-104', title: 'Search misses PDFs', team: 'Search', priority: 'high', age: 6 },
    { id: 'T-105', title: 'Dark mode contrast', team: 'Web', priority: 'medium', age: 9 }
  ];
  let sort = { key: 'age', dir: -1 };
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function render() {
    const q = $('q').value.trim().toLowerCase();
    const prio = $('prio').value;
    const shown = rows
      .filter(r => (!prio || r.priority === prio) && (!q || (r.title + ' ' + r.team).toLowerCase().includes(q)))
      .sort((a, b) => (a[sort.key] > b[sort.key] ? 1 : a[sort.key] < b[sort.key] ? -1 : 0) * sort.dir);
    $('head').innerHTML = columns.map(c => {
      const state = sort.key === c.key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none';
      return `<th aria-sort="${state}"><button data-key="${c.key}">${c.label}${state === 'none' ? '' : state === 'ascending' ? ' ▲' : ' ▼'}</button></th>`;
    }).join('');
    $('body').innerHTML = shown.map(r => '<tr>' + columns.map(c =>
      `<td class="${c.num ? 'num' : ''} ${c.key === 'priority' ? r.priority : ''}">${esc(r[c.key])}</td>`).join('') + '</tr>').join('');
    $('count').textContent = `${shown.length} of ${rows.length} tickets`;
  }
  $('head').addEventListener('click', e => {
    const key = e.target.closest('button')?.dataset.key;
    if (!key) return;
    sort = { key, dir: sort.key === key ? -sort.dir : 1 };
    render();
  });
  $('q').addEventListener('input', render);
  $('prio').addEventListener('change', render);
  render();
</script>
</body>
</html>
```

## 4. Clickable diagram

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Order process</title>
<style>
  :root { --bg:#f8fafc; --surface:#fff; --border:#cbd5e1; --text:var(--brand-text,#0f172a); --muted:#64748b; --primary:var(--brand-primary,#1e3a8a); --node:#eef2ff; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#0b0f19; --surface:#111827; --border:#334155; --text:#f1f5f9; --muted:#94a3b8; --primary:#93c5fd; --node:#1e293b; } }
  :root[data-theme="dark"] { --bg:#0b0f19; --surface:#111827; --border:#334155; --text:#f1f5f9; --muted:#94a3b8; --primary:#93c5fd; --node:#1e293b; }
  * { box-sizing:border-box; margin:0; }
  body { font-family:var(--brand-font,system-ui,sans-serif); background:var(--bg); color:var(--text); padding:20px; }
  .scroll { overflow-x:auto; background:var(--surface); border:1px solid var(--border); border-radius:10px; }
  svg { display:block; width:100%; min-width:600px; height:auto; }
  .node rect { fill:var(--node); stroke:var(--border); } .node text { fill:var(--text); font-size:13px; }
  .node { cursor:pointer; outline:none; } .node[aria-pressed="true"] rect, .node:focus-visible rect { stroke:var(--primary); stroke-width:2.5; }
  .arrow { stroke:var(--muted); stroke-width:1.5; fill:none; marker-end:url(#tip); }
  #tip path { fill:var(--muted); }
  .panel { margin-top:12px; background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:14px; min-height:84px; }
  .panel p { color:var(--muted); margin-top:4px; }
  button { margin-top:10px; padding:6px 12px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--text); cursor:pointer; }
</style>
</head>
<body>
  <h1 style="font-size:1.25rem;margin-bottom:12px">Order process</h1>
  <div class="scroll"><svg viewBox="0 0 680 140" id="diagram" role="group" aria-label="Order process steps">
    <defs><marker id="tip" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z"></path></marker></defs>
  </svg></div>
  <section class="panel" id="panel" aria-live="polite"><strong>Select a step</strong><p>Click a box, or move to it with Tab and press Enter.</p></section>
<script>
  const steps = [
    { id: 'order', label: 'Order received', detail: 'The shop sends the order with items, address and payment method.' },
    { id: 'check', label: 'Credit check', detail: 'Orders above the limit are checked automatically within minutes.' },
    { id: 'pick', label: 'Picking', detail: 'The warehouse collects the items; missing stock pauses the order.' },
    { id: 'ship', label: 'Shipping', detail: 'The carrier gets the parcel and the tracking number goes to the customer.' }
  ];
  const svg = document.getElementById('diagram');
  const panel = document.getElementById('panel');
  const canAsk = Boolean(window.sendPrompt && sendPrompt.available);
  svg.insertAdjacentHTML('beforeend', steps.map((s, i) => {
    const x = 16 + i * 166;
    const arrow = i < steps.length - 1 ? `<path class="arrow" d="M${x + 136},70 L${x + 162},70"></path>` : '';
    return `<g class="node" tabindex="0" role="button" aria-pressed="false" data-i="${i}">
      <rect x="${x}" y="40" width="136" height="60" rx="8"></rect>
      <text x="${x + 68}" y="75" text-anchor="middle">${s.label}</text></g>${arrow}`;
  }).join(''));

  function select(i) {
    const step = steps[i];
    svg.querySelectorAll('.node').forEach(n => n.setAttribute('aria-pressed', String(n.dataset.i === String(i))));
    panel.innerHTML = `<strong>${step.label}</strong><p>${step.detail}</p>` +
      (canAsk ? '<button type="button" id="ask">Ask how to speed this step up</button>' : '');
    if (canAsk) {
      document.getElementById('ask').addEventListener('click', () =>
        sendPrompt(`How could we speed up the step "${step.label}" in our order process? It works like this: ${step.detail}`));
    }
  }
  svg.addEventListener('click', e => { const n = e.target.closest('.node'); if (n) select(Number(n.dataset.i)); });
  svg.addEventListener('keydown', e => {
    const n = e.target.closest('.node');
    if (n && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(Number(n.dataset.i)); }
  });
</script>
</body>
</html>
```

## Changing an artifact afterwards

The user asks for "the bars in green and a fifth region" on example 1. Do not write the file again; edit it:

```json
{
  "filename": "regional-sales.html",
  "edits": [
    {
      "oldText": ".bar rect { fill:var(--primary); }",
      "newText": ".bar rect { fill:#047857; }"
    },
    {
      "oldText": "    { name: 'West', sales: 1105, growth: 3.2 }\n  ];",
      "newText": "    { name: 'West', sales: 1105, growth: 3.2 },\n    { name: 'Central', sales: 640, growth: 5.0 }\n  ];"
    }
  ]
}
```

Each `oldText` is copied exactly and occurs once; everything else in the file stays as it was. A fifth bar needs more height, so a third edit would change `viewBox="0 0 360 220"` to `viewBox="0 0 360 270"`.
