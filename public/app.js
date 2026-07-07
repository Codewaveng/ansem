/* ═══════════════════════════════════════════════════
   $ANSEM Frontend — Live data, calculator, particles
═══════════════════════════════════════════════════ */

// ── State ──────────────────────────────────────────
const state = {
  market: null,
  historical: null,   // { prices: [[ts, price], ...] }
  holders: null,
  posts: [],
  joinLink: 'https://ansem.com',
};

// ── Init ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initStarfield();
  await loadConfig();
  await Promise.all([loadMarket(), loadHolders(), loadCommunity()]);
  loadTopHolders();

  document.getElementById('invest-input').addEventListener('input', updateCalculator);

  // Auto-refresh
  setInterval(loadMarket,  30_000);
  setInterval(loadHolders, 60_000);
});

// ── Config (join link) ─────────────────────────────
async function loadConfig() {
  try {
    const d = await api('/api/config');
    if (d.joinLink) {
      state.joinLink = d.joinLink;
      document.getElementById('join-btn-nav').href  = d.joinLink;
      document.getElementById('join-btn-main').href = d.joinLink;
    }
  } catch (_) {}
}

// ── Market data ────────────────────────────────────
async function loadMarket() {
  try {
    const [market, hist] = await Promise.all([
      api('/api/market'),
      api('/api/historical?days=35'),
    ]);
    state.market = market;
    state.historical = hist;

    updateHero();
    updateTicker();
    updateMoonometer();
    updateCalculator();
  } catch (e) {
    console.warn('Market fetch failed:', e);
  }
}

function updateHero() {
  const m = state.market;
  if (!m) return;

  const price     = formatPrice(m.price);
  const chSign    = m.change24h >= 0 ? '+' : '';
  const chClass   = m.change24h >= 0 ? 'change-positive' : 'change-negative';

  setText('hero-price',  `$${price}`);
  setHtml('hero-change', `<span class="${chClass}">${chSign}${m.change24h.toFixed(2)}%</span>`);
  setText('hero-mcap',   formatLarge(m.marketCap));
  setText('hero-vol',    formatLarge(m.volume24h));
  setText('hero-liq',    formatLarge(m.liquidity));

  // Nav pill
  setText('nav-price',  `$${price}`);
  const navChEl = document.getElementById('nav-change');
  if (navChEl) {
    navChEl.textContent = `${chSign}${m.change24h.toFixed(2)}%`;
    navChEl.className = chClass;
  }

  // Animate number flip on nav price
  document.getElementById('nav-price')?.classList.add('flip');
  setTimeout(() => document.getElementById('nav-price')?.classList.remove('flip'), 400);
}

function updateTicker() {
  const m = state.market;
  if (!m) return;
  const chSign = m.change24h >= 0 ? '▲' : '▼';
  const items = [
    `🚀 $ANSEM`,
    `💰 $${formatPrice(m.price)}`,
    `${chSign} ${m.change24h >= 0 ? '+' : ''}${m.change24h.toFixed(2)}% (24H)`,
    `📊 MCap: ${formatLarge(m.marketCap)}`,
    `🔥 Vol: ${formatLarge(m.volume24h)}`,
    `💧 Liq: ${formatLarge(m.liquidity)}`,
    `🌕 TO THE MOON`,
    `💎 DIAMOND HANDS ONLY`,
    `🦍 APE IN`,
    `1,000,000 HOLDERS LFG`,
  ];
  const doubled = [...items, ...items].join('  ·  ');
  const el = document.getElementById('ticker-content');
  if (el) el.textContent = doubled;
}

function updateMoonometer() {
  const m = state.market;
  if (!m) return;
  const c = m.change24h;
  let emoji, text;
  if (c <= -50)       { emoji = '💀'; text = 'TOTAL REKT'; }
  else if (c <= -25)  { emoji = '😢'; text = 'Pain. Hold.'; }
  else if (c <= -10)  { emoji = '😰'; text = 'Watching...'; }
  else if (c <= -3)   { emoji = '😐'; text = 'Accumulating'; }
  else if (c <= 3)    { emoji = '😏'; text = 'Chilling'; }
  else if (c <= 10)   { emoji = '🙂'; text = 'Gaining'; }
  else if (c <= 25)   { emoji = '🤑'; text = 'We\'re so back!'; }
  else if (c <= 50)   { emoji = '🚀'; text = 'Moon Mode!'; }
  else if (c <= 100)  { emoji = '🌕'; text = 'WE\'RE ON THE MOON'; }
  else                { emoji = '🌌'; text = 'BEYOND THE UNIVERSE'; }

  setText('moon-emoji', emoji);
  setText('moon-text', text);
}

// ── Holders ────────────────────────────────────────
async function loadHolders() {
  try {
    const d = await api('/api/holders');
    state.holders = d;
    updateHolderCountdown(d);
  } catch (e) {
    console.warn('Holders fetch failed:', e);
  }
}

function updateHolderCountdown(d) {
  const count   = d.holders || 0;
  const target  = 1_000_000;
  const pct     = Math.min((count / target) * 100, 100);
  const needed  = Math.max(target - count, 0);

  if (d.needsConfig) {
    document.getElementById('holders-config-note').style.display = 'block';
    document.getElementById('holders-digits').textContent = 'Config needed';
    document.getElementById('cdown-fill').style.width = '30%';
    document.getElementById('cdown-pct').textContent  = 'Add API key to see live count';
    document.getElementById('cdown-needed').textContent = '⚙️ Set HELIUS_API_KEY in .env';
    return;
  }

  // Animate the counter
  animateCounter('holders-digits', count, v => formatNumber(v));
  document.getElementById('cdown-fill').style.width = `${pct.toFixed(1)}%`;
  document.getElementById('cdown-pct').textContent  = `${pct.toFixed(2)}% to 1M 🚀`;
  setText('cdown-needed', `${formatNumber(needed)} holders to go 🔥`);

  if (d.isEstimate) {
    document.getElementById('cdown-eta').textContent = '(estimated — add Helius key for exact count)';
  } else {
    document.getElementById('cdown-eta').textContent = `Updated ${new Date().toLocaleTimeString()} 🕐`;
  }
}

// ── Calculator ─────────────────────────────────────
function updateCalculator() {
  const m    = state.market;
  const hist = state.historical;
  if (!m || !hist?.prices?.length) return;

  const amount = parseFloat(document.getElementById('invest-input').value) || 100;
  const prices = hist.prices;
  const curP   = m.price;

  const periods = [
    { days: 2,  idSuffix: '2d',  label: '2 days ago' },
    { days: 5,  idSuffix: '5d',  label: '5 days ago' },
    { days: 30, idSuffix: '30d', label: '1 month ago' },
  ];

  periods.forEach(({ days, idSuffix }) => {
    // Find the price point closest to `days` ago
    const targetTs = Date.now() - days * 86_400_000;
    let closest = prices[0];
    prices.forEach(p => {
      if (Math.abs(p[0] - targetTs) < Math.abs(closest[0] - targetTs)) closest = p;
    });
    const histPrice = closest[1];

    const worth  = histPrice > 0 ? (amount * (curP / histPrice)) : 0;
    const profit = worth - amount;
    const pct    = histPrice > 0 ? ((curP / histPrice - 1) * 100) : 0;
    const isWin  = profit >= 0;

    setText(`inv-${idSuffix}`,   `$${formatMoney(amount)}`);
    setText(`worth-${idSuffix}`, `$${formatMoney(worth)}`);

    const profEl = document.getElementById(`profit-${idSuffix}`);
    if (profEl) {
      profEl.className = `calc-profit-line ${isWin ? 'profit-positive' : 'profit-negative'}`;
      const sign = isWin ? '+' : '';
      profEl.textContent = `${sign}$${formatMoney(profit)} (${sign}${pct.toFixed(1)}%)`;
    }

    const reactEl = document.getElementById(`react-${idSuffix}`);
    if (reactEl) reactEl.textContent = reactionEmoji(pct);

    // Trigger money rain on big wins
    if (pct > 200) triggerMoneyRain();
  });
}

function reactionEmoji(pct) {
  if (pct > 500)  return '🤯🤯🤯';
  if (pct > 200)  return '🤑🌕🚀';
  if (pct > 100)  return '🚀🔥💎';
  if (pct > 50)   return '🤑💰✨';
  if (pct > 20)   return '😏📈';
  if (pct > 5)    return '🙂👍';
  if (pct > -5)   return '😐🤷';
  if (pct > -20)  return '😬📉';
  if (pct > -50)  return '😢💸';
  return '💀😭🪦';
}

// ── Top holders ────────────────────────────────────
async function loadTopHolders() {
  try {
    const holders = await api('/api/top-holders');
    renderLeaderboard(holders);
  } catch (e) {
    console.warn('Top holders failed:', e);
  }
}

const WHALE_EMOJIS = ['🐋', '🦈', '🐬', '🐟', '🐠', '🦑', '🦞', '🦀', '🐡', '🦐'];
const WHALE_LABELS = [
  '🐋 ANSEM Whale',
  '💎 Diamond Hands',
  '🦈 Shark Bag',
  '🚀 Rocket Holder',
  '🌕 Moon Wallet',
  '🤑 Rich Ape',
  '🔥 Based Holder',
  '💰 Big Bag',
  '🦍 APE GANG',
  '👑 KING DEGEN',
];

function renderLeaderboard(holders) {
  const container = document.getElementById('leaderboard-rows');
  if (!holders?.length) {
    container.innerHTML = '<div class="lb-loading">No data yet 🌑</div>';
    return;
  }

  container.innerHTML = holders.map((h, i) => {
    const rankClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    const rankSymbol = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${h.rank}`;
    const label = h.label || WHALE_LABELS[i % WHALE_LABELS.length];
    const amount = formatLarge(h.amount);
    const mockBadge = h.isMock ? '<span class="lb-mock-badge">DEMO</span>' : '';

    return `
      <div class="lb-row" style="animation-delay:${i * 0.06}s">
        <span class="lb-rank ${rankClass}">${rankSymbol}</span>
        <span class="lb-addr">${h.shortAddress || shorten(h.address)}</span>
        <span class="lb-label">${label}${mockBadge}</span>
        <span class="lb-amount">${amount} $ANSEM</span>
      </div>`;
  }).join('');
}

// ── Community posts ────────────────────────────────
async function loadCommunity() {
  try {
    const posts = await api('/api/community');
    state.posts = posts;
    renderPosts(posts);
  } catch (e) {
    console.warn('Community fetch failed:', e);
  }
}

function renderPosts(posts) {
  const grid = document.getElementById('posts-grid');
  if (!posts?.length) {
    grid.innerHTML = '<div class="posts-loading">No posts yet 🌑</div>';
    return;
  }

  grid.innerHTML = posts.map((p, i) => `
    <div class="post-card" style="animation-delay:${i * 0.08}s">
      <div class="post-header">
        <div class="post-avatar">${p.avatar}</div>
        <div class="post-user">
          <span class="post-name">
            ${escHtml(p.username)}
            ${p.isVerified ? '<span class="verified-badge">✓</span>' : ''}
          </span>
          <span class="post-handle">${escHtml(p.handle)}</span>
        </div>
        <span class="post-time">${p.time}</span>
      </div>
      <div class="post-body">${escHtml(p.content).replace(/\n/g, '<br>')}</div>
      <div class="post-footer">
        <span class="post-stat">🔁 ${formatNumber(p.retweets)}</span>
        <span class="post-stat">❤️ ${formatNumber(p.likes)}</span>
      </div>
    </div>
  `).join('');
}

window.shufflePosts = function () {
  const shuffled = [...state.posts].sort(() => Math.random() - 0.5);
  renderPosts(shuffled);
  document.getElementById('posts-grid').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

// ── Money rain ──────────────────────────────────────
let rainTriggered = false;
function triggerMoneyRain() {
  if (rainTriggered) return;
  rainTriggered = true;
  const container = document.getElementById('money-rain');
  container.classList.remove('hidden');
  const symbols = ['💰', '🤑', '$', '💵', '🪙', '🚀', '🌕'];
  for (let i = 0; i < 40; i++) {
    setTimeout(() => {
      const drop = document.createElement('span');
      drop.className = 'money-drop';
      drop.textContent = symbols[Math.floor(Math.random() * symbols.length)];
      drop.style.left = `${Math.random() * 100}%`;
      drop.style.animationDuration = `${1.5 + Math.random() * 2}s`;
      drop.style.fontSize = `${1.4 + Math.random() * 1.5}rem`;
      container.appendChild(drop);
      drop.addEventListener('animationend', () => drop.remove());
    }, i * 80);
  }
  setTimeout(() => {
    container.classList.add('hidden');
    rainTriggered = false;
  }, 5000);
}

// ── Starfield canvas ────────────────────────────────
function initStarfield() {
  const canvas = document.getElementById('stars');
  const ctx    = canvas.getContext('2d');
  let W, H;
  const stars  = [];

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  // Create stars
  for (let i = 0; i < 220; i++) {
    stars.push({
      x:    Math.random() * W,
      y:    Math.random() * H,
      r:    Math.random() * 1.5 + 0.2,
      a:    Math.random(),
      da:   (Math.random() - 0.5) * 0.008,
      vx:   (Math.random() - 0.5) * 0.15,
      vy:   (Math.random() - 0.5) * 0.15,
      hue:  [255, 224, 0, 153, 69, 255, 20, 241, 149][Math.floor(Math.random() * 3) * 3]
        + ',' +
        [255, 224, 0, 153, 69, 255, 20, 241, 149][Math.floor(Math.random() * 3) * 3 + 1]
        + ',' +
        [255, 224, 0, 153, 69, 255, 20, 241, 149][Math.floor(Math.random() * 3) * 3 + 2],
    });
  }

  // Simpler: just randomize colors from our palette
  const palettes = [
    [255, 224, 0],
    [153, 69, 255],
    [20, 241, 149],
    [255, 255, 255],
  ];
  stars.forEach((s, i) => {
    const p = palettes[i % palettes.length];
    s.r_val = p[0]; s.g_val = p[1]; s.b_val = p[2];
  });

  function draw() {
    ctx.clearRect(0, 0, W, H);
    stars.forEach(s => {
      s.x += s.vx;
      s.y += s.vy;
      s.a += s.da;
      if (s.a < 0 || s.a > 1) s.da *= -1;
      if (s.x < 0) s.x = W;
      if (s.x > W) s.x = 0;
      if (s.y < 0) s.y = H;
      if (s.y > H) s.y = 0;

      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${s.r_val},${s.g_val},${s.b_val},${s.a.toFixed(2)})`;
      ctx.fill();

      // Glow for bigger stars
      if (s.r > 1) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r * 3, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${s.r_val},${s.g_val},${s.b_val},${(s.a * 0.15).toFixed(2)})`;
        ctx.fill();
      }
    });
    requestAnimationFrame(draw);
  }
  draw();
}

// ── Animated counter ───────────────────────────────
function animateCounter(elId, target, fmt, duration = 1200) {
  const el = document.getElementById(elId);
  if (!el) return;
  const start     = 0;
  const startTime = performance.now();
  function step(now) {
    const pct = Math.min((now - startTime) / duration, 1);
    const ease = 1 - Math.pow(1 - pct, 3); // ease-out cubic
    const val  = Math.round(start + (target - start) * ease);
    el.textContent = fmt ? fmt(val) : val;
    if (pct < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ── Utilities ──────────────────────────────────────
async function api(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function formatPrice(p) {
  if (!p || p === 0) return '0.000000';
  if (p >= 1)         return p.toFixed(2);
  if (p >= 0.01)      return p.toFixed(4);
  if (p >= 0.0001)    return p.toFixed(6);
  if (p >= 0.000001)  return p.toFixed(8);
  return p.toExponential(4);
}

function formatMoney(n) {
  if (n === 0) return '0.00';
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000)     return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n.toFixed(2);
}

function formatLarge(n) {
  if (!n || n === 0) return '$0';
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3)  return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function formatNumber(n) {
  if (n >= 1e6)  return (n / 1e6).toFixed(2) + 'M';
  return n.toLocaleString('en-US');
}

function shorten(addr) {
  if (!addr) return '???...???';
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setHtml(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
