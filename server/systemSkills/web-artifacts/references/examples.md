# Complete `web-artifacts` examples

Four finished artifacts, one per kind of job. Read the one closest to the task, **keep its structure and replace its content**: the figures, names and texts below are invented example data, never facts to reuse. Each passes the checks of `create_web_artifact` without a problem or a note, works in light and dark mode, on a phone and with the keyboard, works offline (libraries come from iHub's library kit, never from a CDN), and asks follow-up questions only where the chat can answer them.

| #   | Job                                 | Library (kit marker)  | Shows how to                                                         |
| --- | ----------------------------------- | --------------------- | -------------------------------------------------------------------- |
| 1   | KPI overview with a clickable chart | Chart.js (`chart.js`) | Theme colours in a chart, KPI strip, `sendPrompt` per bar             |
| 2   | Calculator                          | Alpine.js (`alpinejs`) | Sliders bound with `x-model`, computed results, a reset              |
| 3   | Data explorer                       | none                  | Search, filter and sortable columns over embedded rows               |
| 4   | Clickable diagram                   | D3 (`d3`)             | SVG nodes from data, a detail panel, keyboard focus, "ask about this step" |

Three habits carry over to every artifact: a library is loaded with its kit marker (`<script data-ihub-lib="chart.js"></script>`), never a CDN URL unless the user asks for one; an SVG with text gets a `viewBox` about as wide as the space it fills on a phone (around 360), or a sideways-scrolling box with a `min-width`, so its text never shrinks below about 11 px; and every click target is also reachable with Tab and Enter.

After the first version, change an artifact with `edit_web_artifact` (see the end of this file), not by sending the whole file again.

## 1. KPI overview with a clickable chart

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Regional sales Q3</title>
<script data-ihub-lib="chart.js"></script>
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
  .chart { position:relative; height:240px; max-width:640px; }
  .hint { color:var(--muted); font-size:.8rem; margin-top:8px; }
  .asks { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; }
  .asks button { padding:4px 10px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--text); cursor:pointer; }
</style>
</head>
<body>
  <h1>Regional sales, Q3 2026</h1>
  <p class="sub">Example data · in € thousand</p>
  <section class="kpis" id="kpis"></section>
  <section class="card">
    <div class="chart"><canvas id="chart" role="img" aria-label="Sales by region, Q3 2026, in € thousand"></canvas></div>
    <p class="hint" id="hint"></p>
    <div class="asks" id="asks"></div>
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

  // Chart.js draws on a canvas, which cannot read CSS variables: hand it the theme's colours.
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const canAsk = Boolean(window.sendPrompt && sendPrompt.available);
  const signed = g => (g > 0 ? '+' : '') + g;
  function ask(i) {
    const r = regions[i];
    if (canAsk) sendPrompt(`Why did sales in region ${r.name} change by ${r.growth} % in Q3 2026 (${fmt.format(r.sales)} thousand €)?`);
  }

  new Chart(document.getElementById('chart'), {
    type: 'bar',
    data: {
      labels: regions.map(r => r.name),
      datasets: [{ label: 'Sales (€ thousand)', data: regions.map(r => r.sales), backgroundColor: css('--primary'), borderRadius: 4 }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => `${fmt.format(c.raw)} (${signed(regions[c.dataIndex].growth)} %)` } }
      },
      scales: {
        x: { beginAtZero: true, ticks: { color: css('--muted') }, grid: { color: css('--border') } },
        y: { ticks: { color: css('--text') }, grid: { display: false } }
      },
      onClick: (event, elements) => { if (elements.length) ask(elements[0].index); },
      onHover: (event, elements) => { event.native.target.style.cursor = canAsk && elements.length ? 'pointer' : 'default'; }
    }
  });

  document.getElementById('hint').textContent = canAsk
    ? 'Click a bar, or one of the buttons, to ask about that region.'
    : 'Figures per region; growth against Q2.';
  if (canAsk) {
    const asks = document.getElementById('asks');
    asks.innerHTML = regions.map((r, i) => `<button type="button" data-i="${i}">Ask about ${r.name}</button>`).join('');
    asks.addEventListener('click', e => { const b = e.target.closest('button'); if (b) ask(Number(b.dataset.i)); });
  }
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
  <div class="grid" x-data="loan">
    <form class="card" @submit.prevent @reset.prevent="reset()">
      <label for="amount">Amount <output x-text="eur(amount)"></output></label>
      <input id="amount" type="range" min="10000" max="500000" step="5000" x-model.number="amount">
      <label for="rate">Interest rate <output x-text="rate + ' %'"></output></label>
      <input id="rate" type="range" min="0.5" max="9" step="0.1" x-model.number="rate">
      <label for="years">Term <output x-text="years + ' years'"></output></label>
      <input id="years" type="range" min="1" max="35" step="1" x-model.number="years">
      <button type="reset">Reset</button>
    </form>
    <section class="card result" aria-live="polite">
      <span>Monthly payment</span><b x-text="eur(monthly)"></b>
      <div class="row"><span>Total paid</span><span x-text="eur(monthly * months)"></span></div>
      <div class="row"><span>Total interest</span><span x-text="eur(monthly * months - amount)"></span></div>
    </section>
  </div>
<script>
  const DEFAULTS = { amount: 200000, rate: 3.8, years: 20 };
  const money = new Intl.NumberFormat(document.documentElement.lang, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  // Registered before Alpine starts: the kit marker below comes last in <body>.
  document.addEventListener('alpine:init', () => {
    Alpine.data('loan', () => ({
      ...DEFAULTS,
      get months() { return this.years * 12; },
      get monthly() {
        const r = this.rate / 100 / 12;
        return r === 0 ? this.amount / this.months : (this.amount * r) / (1 - Math.pow(1 + r, -this.months));
      },
      eur(value) { return money.format(value); },
      reset() { Object.assign(this, DEFAULTS); }
    }));
  });
</script>
<script data-ihub-lib="alpinejs"></script>
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
<script data-ihub-lib="d3"></script>
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
  const canAsk = Boolean(window.sendPrompt && sendPrompt.available);
  const svg = d3.select('#diagram');
  const panel = d3.select('#panel');
  // The centre of each box, evenly spaced across the diagram.
  const x = d3.scalePoint().domain(steps.map(s => s.id)).range([84, 582]);

  svg.selectAll('path.arrow').data(d3.pairs(steps)).join('path')
    .attr('class', 'arrow')
    .attr('d', ([a, b]) => `M${x(a.id) + 68},70 L${x(b.id) - 72},70`);

  const nodes = svg.selectAll('g.node').data(steps).join('g')
    .attr('class', 'node').attr('tabindex', 0).attr('role', 'button').attr('aria-pressed', 'false')
    .on('click', (event, step) => select(step))
    .on('keydown', (event, step) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(step); }
    });
  nodes.append('rect').attr('x', d => x(d.id) - 68).attr('y', 40).attr('width', 136).attr('height', 60).attr('rx', 8);
  nodes.append('text').attr('x', d => x(d.id)).attr('y', 75).attr('text-anchor', 'middle').text(d => d.label);

  function select(step) {
    nodes.attr('aria-pressed', d => String(d === step));
    panel.html('');
    panel.append('strong').text(step.label);
    panel.append('p').text(step.detail);
    if (canAsk) {
      panel.append('button').attr('type', 'button').text('Ask how to speed this step up')
        .on('click', () => sendPrompt(`How could we speed up the step "${step.label}" in our order process? It works like this: ${step.detail}`));
    }
  }
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
      "oldText": "backgroundColor: css('--primary')",
      "newText": "backgroundColor: '#047857'"
    },
    {
      "oldText": "    { name: 'West', sales: 1105, growth: 3.2 }\n  ];",
      "newText": "    { name: 'West', sales: 1105, growth: 3.2 },\n    { name: 'Central', sales: 640, growth: 5.0 }\n  ];"
    }
  ]
}
```

Each `oldText` is copied exactly and occurs once; everything else in the file stays as it was, the library marker included. Chart.js lays the fifth bar out by itself; with more than about six bars, a third edit would raise the chart's `height:240px`.
