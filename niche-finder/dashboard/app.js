/**
 * Niche Finder Dashboard
 * Reads niches.json + payer_profiles.json from data/ and renders a sortable,
 * filterable table with staleness highlighting and a payer profiles panel.
 */

const STALENESS_DAYS = 30;

// ── Helpers ──────────────────────────────────────────────────────────────────

function daysAgo(isoStr) {
  if (!isoStr) return Infinity;
  const ms = Date.now() - new Date(isoStr).getTime();
  return Math.floor(ms / 86_400_000);
}

function isStale(niche) {
  if (!niche.competition || !niche.competition_checked_at) return true;
  return daysAgo(niche.competition_checked_at) >= STALENESS_DAYS;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function badge(cls, text) {
  if (!text) return '<span class="badge badge-competition-" title="Not yet checked">—</span>';
  return `<span class="badge ${esc(cls)}">${esc(text.replace(/_/g, ' '))}</span>`;
}

function formatDate(isoStr) {
  if (!isoStr) return '—';
  try {
    return new Date(isoStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return isoStr; }
}

// ── Sort state ────────────────────────────────────────────────────────────────

const COMPETITION_ORDER = { very_low: 0, low: 1, moderate: 2, high: 3, very_high: 4, '': 5 };
const STRENGTH_ORDER    = { confirmed: 0, strong_inferred: 1, moderate_inferred: 2, weak_inferred: 3 };
const VOLUME_ORDER      = { small: 1, good: 0, excellent: 0, capped: 0 };

let sortCol = 'competition';
let sortDir = 1; // 1 = asc, -1 = desc

function sortValue(niche, col) {
  switch (col) {
    case 'competition':    return [COMPETITION_ORDER[niche.competition] ?? 5, STRENGTH_ORDER[niche.mechanism_strength] ?? 9, VOLUME_ORDER[niche.effective_volume_bucket] ?? 1, niche.niche];
    case 'mechanism_strength': return [STRENGTH_ORDER[niche.mechanism_strength] ?? 9, COMPETITION_ORDER[niche.competition] ?? 5, niche.niche];
    case 'effective_volume_raw': return [-niche.effective_volume_raw];
    case 'niche':          return [niche.niche.toLowerCase()];
    case 'mechanism':      return [niche.mechanism_display.toLowerCase()];
    case 'branch':         return [niche.branch, niche.niche];
    default:               return [String(niche[col] ?? '').toLowerCase()];
  }
}

function compareArrays(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

function sortNiches(niches) {
  return [...niches].sort((a, b) => {
    const cmp = compareArrays(sortValue(a, sortCol), sortValue(b, sortCol));
    return cmp * sortDir;
  });
}

// ── Filter state ──────────────────────────────────────────────────────────────

let filters = { branch: '', mechanism_strength: '', competition: '', volume: '', search: '' };

function applyFilters(niches) {
  return niches.filter(n => {
    if (filters.branch && n.branch !== filters.branch) return false;
    if (filters.mechanism_strength && n.mechanism_strength !== filters.mechanism_strength) return false;
    if (filters.competition && n.competition !== filters.competition) return false;
    if (filters.volume && n.effective_volume_bucket !== filters.volume) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      const haystack = [n.niche, n.mechanism_display, n.notes, n.evidence_source, n.payer_profile].join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

// ── Summary counts ─────────────────────────────────────────────────────────────

function computeSummary(niches) {
  const total = niches.length;
  const structural = niches.filter(n => n.branch === 'structural').length;
  const contingent = niches.filter(n => n.branch === 'contingent').length;
  const confirmed = niches.filter(n => n.mechanism_strength === 'confirmed').length;
  const staleCount = niches.filter(isStale).length;
  const unchecked = niches.filter(n => !n.competition).length;
  const veryLow = niches.filter(n => n.competition === 'very_low').length;
  const low = niches.filter(n => n.competition === 'low').length;
  return { total, structural, contingent, confirmed, staleCount, unchecked, veryLow, low };
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderSummary(s) {
  return `
    <div class="summary-grid">
      <div class="stat-card"><div class="label">Total niches</div><div class="value" style="color:var(--accent)">${s.total}</div></div>
      <div class="stat-card"><div class="label">Structural</div><div class="value" style="color:var(--green)">${s.structural}</div></div>
      <div class="stat-card"><div class="label">Contingent</div><div class="value" style="color:var(--purple)">${s.contingent}</div></div>
      <div class="stat-card"><div class="label">Very low competition</div><div class="value" style="color:var(--green)">${s.veryLow}</div></div>
      <div class="stat-card"><div class="label">Low competition</div><div class="value" style="color:#6ee7b7">${s.low}</div></div>
      <div class="stat-card"><div class="label">Competition unchecked</div><div class="value" style="color:var(--muted)">${s.unchecked}</div></div>
      ${s.staleCount ? `<div class="stat-card" style="border-color:var(--stale-border);background:var(--stale-bg)"><div class="label" style="color:var(--orange)">Stale (>${STALENESS_DAYS}d)</div><div class="value" style="color:var(--orange)">${s.staleCount}</div></div>` : ''}
    </div>`;
}

function renderFilters() {
  return `
    <div class="filter-bar">
      <div class="filter-group">
        <label>Search</label>
        <input type="text" id="f-search" placeholder="niche, mechanism, keyword…" value="${esc(filters.search)}" />
      </div>
      <div class="filter-group">
        <label>Branch</label>
        <select id="f-branch">
          <option value="">All</option>
          <option value="structural" ${filters.branch==='structural'?'selected':''}>Structural</option>
          <option value="contingent" ${filters.branch==='contingent'?'selected':''}>Contingent</option>
        </select>
      </div>
      <div class="filter-group">
        <label>Mechanism strength</label>
        <select id="f-strength">
          <option value="">All</option>
          <option value="confirmed" ${filters.mechanism_strength==='confirmed'?'selected':''}>Confirmed</option>
          <option value="strong_inferred" ${filters.mechanism_strength==='strong_inferred'?'selected':''}>Strong inferred</option>
          <option value="moderate_inferred" ${filters.mechanism_strength==='moderate_inferred'?'selected':''}>Moderate inferred</option>
          <option value="weak_inferred" ${filters.mechanism_strength==='weak_inferred'?'selected':''}>Weak inferred</option>
        </select>
      </div>
      <div class="filter-group">
        <label>Competition</label>
        <select id="f-competition">
          <option value="">All</option>
          <option value="very_low" ${filters.competition==='very_low'?'selected':''}>Very low</option>
          <option value="low" ${filters.competition==='low'?'selected':''}>Low</option>
          <option value="moderate" ${filters.competition==='moderate'?'selected':''}>Moderate</option>
          <option value="high" ${filters.competition==='high'?'selected':''}>High</option>
          <option value="very_high" ${filters.competition==='very_high'?'selected':''}>Very high</option>
        </select>
      </div>
      <div class="filter-group">
        <label>Volume</label>
        <select id="f-volume">
          <option value="">All</option>
          <option value="small" ${filters.volume==='small'?'selected':''}>Small (&lt;50)</option>
          <option value="good" ${filters.volume==='good'?'selected':''}>Good (50–199)</option>
          <option value="excellent" ${filters.volume==='excellent'?'selected':''}>Excellent (200–499)</option>
          <option value="capped" ${filters.volume==='capped'?'selected':''}>Capped (500+)</option>
        </select>
      </div>
      <button class="reset-btn" id="f-reset">Reset filters</button>
    </div>`;
}

function thCell(col, label) {
  const cls = sortCol === col ? (sortDir === 1 ? 'sort-asc' : 'sort-desc') : '';
  return `<th data-col="${col}" class="${cls}">${esc(label)}<span class="sort-arrow"></span></th>`;
}

function renderTable(niches) {
  if (niches.length === 0) {
    return `<div class="empty-state"><h3>No niches match your filters</h3><p>Try clearing a filter or broadening your search.</p></div>`;
  }

  const rows = niches.map(n => {
    const staleClass = isStale(n) ? ' stale' : '';
    const staleTag = isStale(n) && n.competition ? `<span class="stale-tag" title="Competition data is stale — run --recheck-competition">stale</span>` : '';
    const checkedDisplay = n.competition_checked_at ? formatDate(n.competition_checked_at) + staleTag : '<span style="color:var(--muted)">—</span>';

    return `
      <tr class="${staleClass}">
        <td class="niche-name">${esc(n.niche)}</td>
        <td>${badge('badge-branch-' + n.branch, n.branch)}</td>
        <td>${esc(n.mechanism_display)}</td>
        <td>${badge('badge-strength-' + n.mechanism_strength, n.mechanism_strength)}</td>
        <td>${badge('badge-competition-' + (n.competition||''), n.competition||'')}</td>
        <td style="font-size:12px;white-space:nowrap">${checkedDisplay}</td>
        <td>${badge('badge-vol-' + n.effective_volume_bucket, n.effective_volume_bucket + ' (' + n.effective_volume_raw + ')')}</td>
        <td>${badge('badge-style-' + n.call_style, n.call_style)}</td>
        <td style="font-size:12px;white-space:nowrap">${esc(n.fx_direction.replace(/_/g,' '))}</td>
        ${n.payer_profile ? `<td style="font-size:12px">${esc(n.payer_profile)}</td>` : '<td style="color:var(--muted);font-size:12px">—</td>'}
        <td class="notes-cell">${esc(n.notes)}${n.overlaps_with ? `<br><span style="font-size:11px;color:var(--orange)">⚠ adjacent to: ${esc(n.overlaps_with)}</span>` : ''}</td>
      </tr>`;
  }).join('');

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            ${thCell('niche', 'Niche')}
            ${thCell('branch', 'Branch')}
            ${thCell('mechanism', 'Mechanism')}
            ${thCell('mechanism_strength', 'Strength')}
            ${thCell('competition', 'Competition')}
            <th>Checked</th>
            ${thCell('effective_volume_raw', 'Volume')}
            <th>Call style</th>
            <th>FX direction</th>
            <th>Payer profile</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderProfiles(profiles) {
  if (!profiles || profiles.length === 0) return '';
  const cards = profiles.map(p => `
    <div class="profile-card">
      <div class="pname">
        ${esc(p.name)}
        <span class="currency-tag">${esc(p.currency)}</span>
        <span class="conf-tag">${esc(p.confidence)}</span>
      </div>
      <div class="pevidence">${esc(p.evidence)}</div>
      <div class="psource">Source: ${esc(p.source)}</div>
    </div>`).join('');
  return `
    <div class="section-title">Payer Profiles — counterparties whose payment currency is already established</div>
    <div class="profiles-grid">${cards}</div>`;
}

// ── Main render cycle ────────────────────────────────────────────────────────

let allNiches = [];
let payerProfiles = [];

function render() {
  const filtered = applyFilters(allNiches);
  const sorted   = sortNiches(filtered);
  const summary  = computeSummary(allNiches);
  const staleCount = allNiches.filter(isStale).length;

  const staleBanner = staleCount > 0
    ? `<div class="stale-banner visible">
        ⚠ ${staleCount} niche${staleCount > 1 ? 's have' : ' has'} stale or missing competition data
        (older than ${STALENESS_DAYS} days). Run <code>python main.py --recheck-competition</code> to refresh.
       </div>`
    : '';

  document.getElementById('app').innerHTML = `
    ${renderSummary(summary)}
    ${renderFilters()}
    ${staleBanner}
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px">
      Showing <strong style="color:var(--text)">${sorted.length}</strong> of ${allNiches.length} niches
    </div>
    ${renderTable(sorted)}
    ${renderProfiles(payerProfiles)}
    <footer>
      Competition is the primary ranking axis. Sort by any column. Rows highlighted in amber have stale or missing competition data — run
      <code>python main.py --recheck-competition</code> to refresh. Mechanism strength is a stable structural fact and does not need re-checking.
    </footer>`;

  // Attach filter event listeners
  document.getElementById('f-search').addEventListener('input', e => { filters.search = e.target.value; render(); });
  document.getElementById('f-branch').addEventListener('change', e => { filters.branch = e.target.value; render(); });
  document.getElementById('f-strength').addEventListener('change', e => { filters.mechanism_strength = e.target.value; render(); });
  document.getElementById('f-competition').addEventListener('change', e => { filters.competition = e.target.value; render(); });
  document.getElementById('f-volume').addEventListener('change', e => { filters.volume = e.target.value; render(); });
  document.getElementById('f-reset').addEventListener('click', () => {
    filters = { branch: '', mechanism_strength: '', competition: '', volume: '', search: '' };
    render();
  });

  // Attach sort listeners
  document.querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortCol === col) {
        sortDir *= -1;
      } else {
        sortCol = col;
        sortDir = 1;
      }
      render();
    });
  });
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadData() {
  try {
    const [nichesRes, profilesRes] = await Promise.all([
      fetch('data/niches.json'),
      fetch('data/payer_profiles.json'),
    ]);

    if (!nichesRes.ok) throw new Error(`niches.json: ${nichesRes.status} ${nichesRes.statusText}`);

    allNiches = await nichesRes.json();

    if (profilesRes.ok) {
      const profileData = await profilesRes.json();
      payerProfiles = profileData.profiles || [];
    }

    document.getElementById('loading').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    render();

  } catch (err) {
    document.getElementById('loading').style.display = 'none';
    const errEl = document.getElementById('error-msg');
    errEl.style.display = 'block';
    errEl.innerHTML = `
      <strong>Could not load niche data.</strong><br>
      ${esc(err.message)}<br><br>
      If running locally, serve from this directory with:<br>
      <code>cd niche-finder/dashboard && python -m http.server 8080</code><br>
      then open <a href="http://localhost:8080" style="color:var(--accent)">http://localhost:8080</a>.<br><br>
      Make sure <code>data/niches.json</code> exists — run <code>python main.py</code> first.`;
  }
}

loadData();
