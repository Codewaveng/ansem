/* ═══════════════════════════════════════════════
   $ANSEM — Frontend Logic
═══════════════════════════════════════════════ */

const state = {
  market:      null,
  historical:  null,
  holders:     null,
  selectedDays: 2,
  selectedType: 'bullish',
  lastPost:    null,
};

// Safe wrapper — never crash if lucide CDN is slow/blocked
function icons() {
  try { if (typeof lucide !== 'undefined') lucide.createIcons(); } catch (_) {}
}

// ── Bootstrap ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  icons();

  await loadConfig();
  await Promise.all([loadMarket(), loadHolders()]);
  loadTopHolders();
  loadTrades();

  setupCalculator();
  setupPostGenerator();

  setInterval(loadMarket,  30_000);
  setInterval(loadHolders, 60_000);
  setInterval(loadTrades,  20_000);
});

// ── Config ──────────────────────────────────────────
async function loadConfig() {
  try {
    const d = await api('/api/config');
    if (d.joinLink) {
      document.getElementById('join-btn').href   = d.joinLink;
      document.getElementById('join-btn-2').href = d.joinLink;
    }
  } catch (_) {}
}

// ── Market data ─────────────────────────────────────
async function loadMarket() {
  try {
    const [market, hist] = await Promise.all([
      api('/api/market'),
      api('/api/historical?days=90'),
    ]);
    state.market     = market;
    state.historical = hist;

    updateHeader(market);
    updateStatsStrip(market);
    updateCalculatorResult();
  } catch (e) {
    console.warn('Market:', e.message);
  }
}

function updateHeader(m) {
  setText('h-price', `$${fmtPrice(m.price)}`);
  const el  = document.getElementById('h-change');
  const pct = m.change24h;
  el.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
  el.className   = `price-badge ${pct > 0 ? 'badge-up' : pct < 0 ? 'badge-down' : 'badge-flat'}`;
}

function updateStatsStrip(m) {
  setText('s-price',  `$${fmtPrice(m.price)}`);

  const chEl = document.getElementById('s-change');
  const pct  = m.change24h;
  chEl.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
  chEl.style.color = pct > 0 ? 'var(--green)' : pct < 0 ? 'var(--red)' : 'var(--muted-2)';

  setText('s-mcap',  fmtLarge(m.marketCap));
  setText('s-vol',   fmtLarge(m.volume24h));
  setText('s-liq',   fmtLarge(m.liquidity));
  const t24 = m.txns?.h24;
  if (t24) setText('s-txns', `${fmtNum(t24.buys + t24.sells)} (${fmtNum(t24.buys)} buys)`);
}

// ── Holders ─────────────────────────────────────────
async function loadHolders() {
  try {
    const d = await api('/api/holders');
    state.holders = d;
    renderHolderBlock(d);
  } catch (e) {
    console.warn('Holders:', e.message);
  }
}

let _holderPollTimer = null;

function renderHolderBlock(d) {
  // Background job still counting — show loading state and retry
  if (d.loading) {
    setText('holder-count', 'Counting…');
    setText('progress-pct', '—');
    setText('holders-needed', 'Scanning blockchain…');
    document.getElementById('holder-config-note').classList.add('hidden');
    document.getElementById('progress-fill').style.width = '0%';
    document.getElementById('holder-count').classList.add('counting');

    if (!_holderPollTimer) {
      _holderPollTimer = setInterval(async () => {
        try {
          const d2 = await api('/api/holders');
          if (!d2.loading) {
            clearInterval(_holderPollTimer);
            _holderPollTimer = null;
            state.holders = d2;
            renderHolderBlock(d2);
          }
        } catch (_) {}
      }, 5000);
    }
    return;
  }

  // Got real data — cancel any pending poll
  if (_holderPollTimer) {
    clearInterval(_holderPollTimer);
    _holderPollTimer = null;
  }
  document.getElementById('holder-count').classList.remove('counting');

  const count  = d.holders || 0;
  const target = 1_000_000;
  const pct    = Math.min((count / target) * 100, 100);
  const needed = Math.max(target - count, 0);

  if (d.needsConfig || count === 0) {
    setText('holder-count', 'N/A');
    setText('progress-pct', '—');
    setText('holders-needed', 'Add Helius key');
    document.getElementById('holder-config-note').classList.remove('hidden');
    document.getElementById('progress-fill').style.width = '0%';
    return;
  }

  animateCount('holder-count', count, v => fmtNum(v));
  document.getElementById('progress-fill').style.width = `${pct.toFixed(3)}%`;
  setText('progress-pct', `${pct.toFixed(2)}%`);
  setText('holders-needed', `${fmtNum(needed)} to go`);
}

// ── Calculator ───────────────────────────────────────
function setupCalculator() {
  document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.selectedDays = parseInt(btn.dataset.days);
    });
  });
  document.getElementById('calc-btn').addEventListener('click', updateCalculatorResult);
  document.getElementById('calc-amount').addEventListener('keydown', e => {
    if (e.key === 'Enter') updateCalculatorResult();
  });
}

function updateCalculatorResult() {
  const m    = state.market;
  const hist = state.historical;
  if (!m || !hist?.prices?.length) return;

  const amount  = parseFloat(document.getElementById('calc-amount').value) || 100;
  const days    = state.selectedDays;
  const curP    = m.price;
  const prices  = hist.prices;

  // Find historical price closest to `days` ago
  const targetTs = Date.now() - days * 86_400_000;
  let closest = prices[0];
  for (const p of prices) {
    if (Math.abs(p[0] - targetTs) < Math.abs(closest[0] - targetTs)) closest = p;
  }
  const histPrice = closest[1];

  if (!histPrice || histPrice <= 0) {
    renderCalcResult(null, amount, days);
    return;
  }

  const worth  = amount * (curP / histPrice);
  const profit = worth - amount;
  const roi    = (curP / histPrice - 1) * 100;

  renderCalcResult({ worth, profit, roi, curP, histPrice, amount, days }, amount, days);
}

function renderCalcResult(data, amount, days) {
  const container = document.getElementById('calc-result');

  if (!data) {
    container.innerHTML = `
      <div class="result-placeholder">
        <div style="color:var(--red);font-size:0.9rem;">No historical data for this period yet.</div>
      </div>`;
    return;
  }

  const { worth, profit, roi, curP, histPrice } = data;
  const isProfit = profit >= 0;
  const periodLabel = fmtPeriodLabel(days);
  const signal = getSignal(roi, m => m);

  container.innerHTML = `
    <div class="result-content">
      <div class="result-row">
        <span class="result-key">If you invested ${periodLabel}</span>
        <span class="result-val neutral">$${fmtMoney(amount)}</span>
      </div>
      <div class="result-row">
        <span class="result-key">Price ${periodLabel}</span>
        <span class="result-val neutral">$${fmtPrice(histPrice)}</span>
      </div>
      <div class="result-row">
        <span class="result-key">Price today</span>
        <span class="result-val neutral">$${fmtPrice(curP)}</span>
      </div>
      <div class="result-row">
        <span class="result-key">Worth now</span>
        <span class="result-val ${isProfit ? 'up' : 'down'}">$${fmtMoney(worth)}</span>
      </div>
      <div class="result-row">
        <span class="result-key">Return</span>
        <span class="result-val ${isProfit ? 'up' : 'down'}">${isProfit ? '+' : ''}${roi.toFixed(2)}% (${isProfit ? '+' : ''}$${fmtMoney(profit)})</span>
      </div>
      <div class="signal-box ${signal.cls}">
        <div class="signal-tag">${signal.tag}</div>
        <div class="signal-desc">${signal.desc}</div>
      </div>
    </div>`;
  icons();
}

function getSignal(roi) {
  if (roi > 500)  return { cls: 'early',   tag: 'Extremely Early',   desc: 'You got in at the very beginning. This is what life-changing returns look like. The community is still tiny.' };
  if (roi > 200)  return { cls: 'early',   tag: 'Very Early Entry',  desc: 'Strong returns so far. You found $ANSEM before most people. Still a long way to 1M holders.' };
  if (roi > 50)   return { cls: 'early',   tag: 'Early & Bullish',   desc: 'Good entry point. You\'re in the green and the holder base is still growing toward the 1M target.' };
  if (roi > 10)   return { cls: 'early',   tag: 'Bullish Entry',     desc: 'Solid position. The momentum is working in your favor. Community growth is the key metric to watch.' };
  if (roi > -10)  return { cls: 'neutral', tag: 'Neutral / DCA',     desc: 'Close to break-even. Consider DCA\'ing in over time to reduce price risk as the community grows.' };
  if (roi > -30)  return { cls: 'neutral', tag: 'DCA Opportunity',   desc: 'Down a bit from that entry. This could be a good DCA level. The 1M holder milestone remains the target.' };
  if (roi > -60)  return { cls: 'late',    tag: 'High Risk — DCA',   desc: 'Significant drawdown from that entry. Risk is elevated. Dollar-cost averaging could reduce your average cost.' };
  return           { cls: 'late',           tag: 'Underwater — Hold', desc: 'Deep in the red from that entry point. HODL or DCA carefully. Never invest more than you can afford to lose.' };
}

function fmtPeriodLabel(days) {
  if (days === 1)  return '1 day ago';
  if (days === 7)  return '1 week ago';
  if (days === 14) return '2 weeks ago';
  if (days === 30) return '1 month ago';
  if (days === 90) return '3 months ago';
  return `${days} days ago`;
}

// ── Transactions ─────────────────────────────────────
async function loadTrades() {
  try {
    const data = await api('/api/trades');
    renderTrades(data);
  } catch (e) {
    console.warn('Trades:', e.message);
  }
}

function renderTrades(data) {
  const grid = document.getElementById('tx-grid');

  // Helius individual transactions
  if (Array.isArray(data) && data.length && data[0].source === 'helius') {
    grid.innerHTML = `
      <div class="tx-helius-card">
        <div class="tx-row" style="font-size:0.75rem;color:var(--muted);border-bottom:1px solid var(--border);padding:0.6rem 1.2rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;">
          <span>Type</span><span>Signature</span><span>Time</span><span></span>
        </div>
        ${data.map(tx => `
          <div class="tx-row ${tx.type === 'SWAP' ? 'buy-row' : ''}">
            <span class="tx-badge buy">${tx.type}</span>
            <span class="tx-sig">${tx.shortSig}</span>
            <span class="tx-time">${timeAgo(tx.ts)}</span>
            <a href="https://solscan.io/tx/${tx.sig}" target="_blank" style="color:var(--muted);font-size:0.8rem;">View</a>
          </div>`).join('')}
      </div>`;
    icons();
    return;
  }

  // DexScreener trading stats (buys/sells per time window)
  if (data.source === 'dexscreener_stats' && data.txns) {
    const { txns } = data;
    const periods = [
      { label: 'Last 5 Min',   d: txns.m5  },
      { label: 'Last 1 Hour',  d: txns.h1  },
      { label: 'Last 6 Hours', d: txns.h6  },
      { label: 'Last 24 Hours',d: txns.h24 },
    ];

    grid.innerHTML = periods.map(({ label, d }) => {
      if (!d) return '';
      const total    = (d.buys || 0) + (d.sells || 0);
      const buyPct   = total > 0 ? ((d.buys / total) * 100).toFixed(0) : 50;
      const sellPct  = 100 - buyPct;
      return `
        <div class="tx-stat-card">
          <div class="tx-period">${label}</div>
          <div class="tx-bars">
            <div class="tx-bar-row">
              <div class="tx-bar-label">
                <span class="buy-label">Buys — ${fmtNum(d.buys)}</span>
                <span>${buyPct}%</span>
              </div>
              <div class="tx-bar-track">
                <div class="tx-bar-fill buy" style="width:${buyPct}%"></div>
              </div>
            </div>
            <div class="tx-bar-row">
              <div class="tx-bar-label">
                <span class="sell-label">Sells — ${fmtNum(d.sells)}</span>
                <span>${sellPct}%</span>
              </div>
              <div class="tx-bar-track">
                <div class="tx-bar-fill sell" style="width:${sellPct}%"></div>
              </div>
            </div>
          </div>
          <div class="tx-total">Total: <strong>${fmtNum(total)}</strong> transactions</div>
        </div>`;
    }).join('');
    icons();
  }
}

// ── Top holders ──────────────────────────────────────
async function loadTopHolders() {
  try {
    const holders = await api('/api/top-holders');
    renderTopHolders(holders);
  } catch (e) {
    console.warn('Top holders:', e.message);
  }
}

function renderTopHolders(holders) {
  const container = document.getElementById('holders-rows');
  if (!holders?.length) {
    container.innerHTML = '<div class="table-loading">No data available.</div>';
    return;
  }
  container.innerHTML = holders.map(h => {
    const rankCls = h.rank === 1 ? 'r1' : h.rank === 2 ? 'r2' : h.rank === 3 ? 'r3' : 'rx';
    const rankLabel = h.rank <= 3 ? ['🥇','🥈','🥉'][h.rank-1] : `#${h.rank}`;
    const demo = h.isDemo ? '<span class="demo-badge">Demo</span>' : '';
    const solscanUrl = h.address ? `https://solscan.io/account/${h.address}` : '#';
    return `
      <div class="table-row">
        <span class="t-rank ${rankCls}">${rankLabel}</span>
        <span class="t-addr">${h.shortAddress}${demo}</span>
        <span class="t-amount right">${fmtLargeRaw(h.amount)}</span>
        <a href="${solscanUrl}" target="_blank" class="t-link right">
          View <i data-lucide="external-link"></i>
        </a>
      </div>`;
  }).join('');
  icons();
}

// ── Post Generator ────────────────────────────────────
function setupPostGenerator() {
  document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.selectedType = btn.dataset.type;
    });
  });
  document.getElementById('gen-btn').addEventListener('click', generatePost);
}

async function generatePost() {
  const btn = document.getElementById('gen-btn');
  btn.disabled = true;
  btn.innerHTML = `<i data-lucide="loader" class="btn-icon spin"></i> Generating…`;
  icons();

  try {
    const d = await apiPost('/api/generate-post', {
      type: state.selectedType,
    });
    state.lastPost = d.post;
    renderPost(d.post);
  } catch (e) {
    renderPost('Failed to generate post. Please try again.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i data-lucide="sparkles" class="btn-icon"></i> Generate Post`;
    icons();
  }
}

function renderPost(text) {
  document.getElementById('gen-output').innerHTML = `
    <div class="post-output">
      <div class="post-text">${escHtml(text)}</div>
      <div class="post-actions">
        <button class="btn-copy" onclick="copyPost()">
          <i data-lucide="copy"></i> Copy
        </button>
        <button class="btn-regen" onclick="generatePost()">
          <i data-lucide="refresh-cw"></i> Regenerate
        </button>
      </div>
    </div>`;
  icons();
}

window.copyPost = async function () {
  const text = document.querySelector('.post-text')?.innerText;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const btn = document.querySelector('.btn-copy');
    if (btn) { btn.innerHTML = '<i data-lucide="check"></i> Copied!'; icons(); }
    setTimeout(() => {
      const b = document.querySelector('.btn-copy');
      if (b) { b.innerHTML = '<i data-lucide="copy"></i> Copy'; icons(); }
    }, 2000);
  } catch (_) {}
};

// ── Counter animation ────────────────────────────────
function animateCount(id, target, fmt, ms = 1400) {
  const el = document.getElementById(id);
  if (!el) return;
  const start = performance.now();
  (function step(now) {
    const t = Math.min((now - start) / ms, 1);
    const e = 1 - Math.pow(1 - t, 3);
    el.textContent = fmt ? fmt(Math.round(target * e)) : Math.round(target * e);
    if (t < 1) requestAnimationFrame(step);
  })(start);
}

// ── Utilities ─────────────────────────────────────────
async function api(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function apiPost(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function fmtPrice(p) {
  if (!p) return '0';
  if (p >= 1)        return p.toFixed(2);
  if (p >= 0.01)     return p.toFixed(4);
  if (p >= 0.0001)   return p.toFixed(6);
  if (p >= 0.000001) return p.toFixed(8);
  return p.toExponential(4);
}
function fmtMoney(n) {
  if (n >= 1_000_000) return `${(n/1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n.toFixed(2);
}
function fmtLarge(n) {
  if (!n) return '$0';
  if (n >= 1e9) return `$${(n/1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n/1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n/1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}
function fmtLargeRaw(n) {
  if (!n) return '0';
  if (n >= 1e9) return `${(n/1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n/1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n/1e3).toFixed(1)}K`;
  return n.toLocaleString();
}
function fmtNum(n) {
  if (!n) return '0';
  return n.toLocaleString('en-US');
}
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
