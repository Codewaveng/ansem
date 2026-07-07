require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const path    = require('path');
const fs      = require('fs');

const app          = express();
const PORT         = process.env.PORT || 3000;
const HELIUS_KEY    = process.env.HELIUS_API_KEY  || '';
const DEEPSEEK_KEY  = process.env.DEEPSEEK_API_KEY || '';
const TOKEN_ADDR    = process.env.ANSEM_TOKEN_ADDRESS || '';
const JOIN_LINK     = process.env.JOIN_LINK || 'https://app.bullpen.fi/';

const _cache = {};
function fromCache(key, maxMs) {
  const e = _cache[key];
  return (e && Date.now() - e.ts < maxMs) ? e.data : null;
}
function toCache(key, data) { _cache[key] = { data, ts: Date.now() }; }

const heliusRpc  = () => `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const hasHelius  = () => HELIUS_KEY   && HELIUS_KEY   !== 'your_helius_api_key_here';
const hasDeepSeek = () => DEEPSEEK_KEY && DEEPSEEK_KEY !== 'your_deepseek_api_key_here';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── Config ─────────────────────────────────────────────────────────────────
app.get('/api/config', (_req, res) => res.json({ joinLink: JOIN_LINK }));

// ─── Market data (DexScreener) ───────────────────────────────────────────────
app.get('/api/market', async (req, res) => {
  const cached = fromCache('market', 20_000);
  if (cached) return res.json(cached);
  try {
    const { data } = await axios.get(
      'https://api.dexscreener.com/latest/dex/search?q=ANSEM', { timeout: 8000 }
    );
    const pairs = (data.pairs || [])
      .filter(p => p.chainId === 'solana' && p.baseToken?.symbol?.toUpperCase() === 'ANSEM')
      .sort((a, b) => (parseFloat(b.volume?.h24) || 0) - (parseFloat(a.volume?.h24) || 0));
    const p = pairs[0];
    if (!p) return res.json({ error: 'Pair not found', price: 0 });

    const result = {
      price:        parseFloat(p.priceUsd)          || 0,
      change5m:     parseFloat(p.priceChange?.m5)   || 0,
      change1h:     parseFloat(p.priceChange?.h1)   || 0,
      change24h:    parseFloat(p.priceChange?.h24)  || 0,
      marketCap:    parseFloat(p.marketCap)          || 0,
      fdv:          parseFloat(p.fdv)                || 0,
      volume24h:    parseFloat(p.volume?.h24)        || 0,
      volume1h:     parseFloat(p.volume?.h1)         || 0,
      liquidity:    parseFloat(p.liquidity?.usd)     || 0,
      tokenAddress: p.baseToken?.address             || TOKEN_ADDR,
      pairAddress:  p.pairAddress                    || '',
      dexUrl:       p.url                            || '',
      txns: {
        m5:  { buys: p.txns?.m5?.buys  || 0, sells: p.txns?.m5?.sells  || 0 },
        h1:  { buys: p.txns?.h1?.buys  || 0, sells: p.txns?.h1?.sells  || 0 },
        h6:  { buys: p.txns?.h6?.buys  || 0, sells: p.txns?.h6?.sells  || 0 },
        h24: { buys: p.txns?.h24?.buys || 0, sells: p.txns?.h24?.sells || 0 },
      },
    };
    toCache('market', result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Historical prices (CoinGecko) ───────────────────────────────────────────
app.get('/api/historical', async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 90, 365);
  const ckey = `hist_${days}`;
  const cached = fromCache(ckey, 300_000);
  if (cached) return res.json(cached);

  // Try CoinGecko
  try {
    const { data } = await axios.get(
      `https://api.coingecko.com/api/v3/coins/ansem/market_chart`,
      { params: { vs_currency: 'usd', days, interval: 'daily' }, timeout: 8000 }
    );
    if (data?.prices?.length) { toCache(ckey, data); return res.json(data); }
  } catch (_) {}

  // Search CoinGecko for correct ID
  try {
    const { data: s } = await axios.get('https://api.coingecko.com/api/v3/search?query=ANSEM', { timeout: 6000 });
    const coin = (s.coins || []).find(c => c.symbol.toUpperCase() === 'ANSEM');
    if (coin) {
      const { data } = await axios.get(
        `https://api.coingecko.com/api/v3/coins/${coin.id}/market_chart`,
        { params: { vs_currency: 'usd', days, interval: 'daily' }, timeout: 8000 }
      );
      if (data?.prices?.length) { toCache(ckey, data); return res.json(data); }
    }
  } catch (_) {}

  // Approximate from current market data
  try {
    const m = fromCache('market', 300_000);
    if (m?.price) {
      const cur = m.price;
      const c24 = (m.change24h || 0) / 100;
      const now = Date.now();
      const prices = Array.from({ length: days + 1 }, (_, i) => {
        const drift = (Math.random() - 0.48) * 0.06;
        const factor = i === days ? 1 : Math.pow(1 / (1 + c24), (days - i) / days) * (1 + drift);
        return [now - (days - i) * 86_400_000, cur * factor];
      });
      const result = { source: 'estimated', prices };
      toCache(ckey, result);
      return res.json(result);
    }
  } catch (_) {}

  res.status(500).json({ error: 'Historical data unavailable' });
});

// ─── Holder count — binary search across getTokenAccounts pages ───────────────
//
// Helius getTokenAccounts returns `total` = count on *current page*, not global total.
// So we binary-search page numbers to find the last non-empty page, then:
//   total_holders = (lastPage - 1) * PAGE_SIZE + itemsOnLastPage
//
// Runs in the background every 5 min so the HTTP endpoint is always instant.

const PAGE_SIZE    = 1000;
const HISTORY_FILE = path.join(__dirname, 'holder_history.json');
const holderHistory = [];

function loadHolderHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const arr = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      if (Array.isArray(arr)) {
        const cutoff = Date.now() - 8 * 86_400_000;
        holderHistory.push(...arr.filter(h => h.ts > cutoff && typeof h.count === 'number'));
        console.log(`[holders] Loaded ${holderHistory.length} history snapshots from disk`);
      }
    }
  } catch (_) {}
}

function saveHolderHistory() {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(holderHistory), 'utf8'); } catch (_) {}
}

function recordHolderSnapshot(count) {
  const now = Date.now();
  holderHistory.push({ count, ts: now });
  const cutoff = now - 8 * 86_400_000;
  while (holderHistory.length > 1 && holderHistory[0].ts < cutoff) holderHistory.shift();
  saveHolderHistory();
}

function computeHolderGrowth() {
  const cached = fromCache('holders', 600_000);
  if (!cached?.holders || holderHistory.length < 2) return {};
  const current = cached.holders;
  const now     = Date.now();

  const oldest  = holderHistory[0];
  const ageDays = (now - oldest.ts) / 86_400_000;
  if (ageDays < 0.002) return {};

  const growth    = current - oldest.count;
  const dailyRate = growth / ageDays;

  // Try to find a snapshot closest to exactly 24h ago
  let dailyGrowth = null;
  const t24 = now - 86_400_000;
  let best = null, bestDiff = Infinity;
  for (const h of holderHistory) {
    if (h.count === current) continue;
    const d = Math.abs(h.ts - t24);
    if (d < bestDiff) { bestDiff = d; best = h; }
  }
  if (best && bestDiff < 14_400_000) {
    // Exact 24h measurement — show even if negative
    dailyGrowth = current - best.count;
  } else if (ageDays >= 0.5 && growth > 0) {
    // Extrapolated from a window of at least 12h with positive observed growth
    dailyGrowth = Math.round(dailyRate);
  }
  // Suppressed: short noisy windows (< 12h) where growth is 0 or negative

  let weeklyGrowth = null;
  if (ageDays >= 5) {
    weeklyGrowth = current - oldest.count;
  } else if (dailyRate > 0 && ageDays >= 0.5) {
    weeklyGrowth = Math.round(dailyRate * 7);
  }

  const estimatedDays = dailyRate > 0 ? Math.ceil((1_000_000 - current) / dailyRate) : null;
  const isExtrapolated = ageDays < 1;

  return { dailyGrowth, weeklyGrowth, estimatedDays, isExtrapolated };
}

loadHolderHistory(); // restore snapshots from last run

async function fetchPageLen(addr, page) {
  try {
    const { data } = await axios.post(heliusRpc(), {
      jsonrpc: '2.0', id: `hp${page}`,
      method: 'getTokenAccounts',
      params: {
        page,
        limit: PAGE_SIZE,
        mint: addr,
        displayOptions: { showZeroBalance: false },
      },
    }, { timeout: 15_000 });
    return (data?.result?.token_accounts || []).length;
  } catch (_) { return 0; }
}

async function countHolders(addr) {
  const c1 = await fetchPageLen(addr, 1);
  if (c1 === 0) return 0;
  if (c1 < PAGE_SIZE) return c1;

  // Binary search: find last page that still has results
  let lo = 1, hi = 5000;          // 5000 pages × 1000 = supports up to 5M holders
  let lastPage = 1, lastCount = c1;

  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const c   = await fetchPageLen(addr, mid);
    if (c > 0) { lo = mid; lastPage = mid; lastCount = c; }
    else          hi = mid - 1;
  }

  return (lastPage - 1) * PAGE_SIZE + lastCount;
}

async function refreshHolderCount() {
  const addr = TOKEN_ADDR || fromCache('market', 3_600_000)?.tokenAddress;
  if (!addr || !hasHelius()) return;
  try {
    console.log('[holders] counting via binary search...');
    const total = await countHolders(addr);
    if (total > 0) {
      toCache('holders', { holders: total });
      recordHolderSnapshot(total);
      console.log(`[holders] ${total.toLocaleString()} holders`);
    }
  } catch (e) {
    console.error('[holders] error:', e.message);
  }
}

// Kick off 8 s after server start, then refresh every 5 min
setTimeout(refreshHolderCount, 8_000);
setInterval(refreshHolderCount,  300_000);

app.get('/api/holders', (req, res) => {
  const addr = TOKEN_ADDR || fromCache('market', 3_600_000)?.tokenAddress;
  if (!addr || !hasHelius()) return res.json({ holders: 0, needsConfig: true });

  const cached = fromCache('holders', 300_000);      // serve cache up to 5 min old
  if (cached) return res.json(cached);

  res.json({ holders: 0, loading: true });           // still counting on first boot
});

app.get('/api/holder-stats', (req, res) => {
  const addr = TOKEN_ADDR || fromCache('market', 3_600_000)?.tokenAddress;
  if (!addr || !hasHelius()) return res.json({ holders: 0, needsConfig: true });
  const cached = fromCache('holders', 300_000);
  if (!cached) return res.json({ holders: 0, loading: true });
  const growth = computeHolderGrowth();
  // If all growth fields are null and we have < 12h of history, flag as collecting
  const hasAnyGrowth = growth.dailyGrowth != null || growth.weeklyGrowth != null || growth.estimatedDays != null;
  const oldestTs = holderHistory[0]?.ts ?? Date.now();
  const collecting = !hasAnyGrowth && (Date.now() - oldestTs) < 12 * 3_600_000;
  res.json({ holders: cached.holders, collecting, ...growth });
});

// ─── Top holders ──────────────────────────────────────────────────────────────
app.get('/api/top-holders', async (req, res) => {
  const cached = fromCache('top-holders', 120_000);
  if (cached) return res.json(cached);

  const addr = TOKEN_ADDR || fromCache('market', 120_000)?.tokenAddress;

  if (addr && hasHelius()) {
    try {
      const { data } = await axios.post(heliusRpc(), {
        jsonrpc: '2.0', id: 'top',
        method: 'getTokenLargestAccounts',
        params: [addr, { commitment: 'finalized' }],
      }, { timeout: 10_000 });
      if (data?.result?.value) {
        const holders = data.result.value.map((h, i) => ({
          rank: i + 1,
          address: h.address,
          shortAddress: `${h.address.slice(0, 6)}...${h.address.slice(-4)}`,
          amount: parseFloat(h.uiAmount) || 0,
        }));
        toCache('top-holders', holders);
        return res.json(holders);
      }
    } catch (_) {}
  }

  // Solscan fallback
  if (addr) {
    try {
      const { data } = await axios.get(
        `https://public-api.solscan.io/token/holders?tokenAddress=${addr}&limit=10&offset=0`,
        { timeout: 6000, headers: { 'Accept': 'application/json' } }
      );
      if (data?.data?.length) {
        const holders = data.data.map((h, i) => ({
          rank: i + 1,
          address: h.owner,
          shortAddress: `${h.owner.slice(0, 6)}...${h.owner.slice(-4)}`,
          amount: parseFloat(h.uiAmount) || 0,
        }));
        toCache('top-holders', holders);
        return res.json(holders);
      }
    } catch (_) {}
  }

  // Demo data
  res.json([
    { rank: 1,  shortAddress: '7xKXTR...mPQh', amount: 42069000000 },
    { rank: 2,  shortAddress: 'Ans3mH...QRKX', amount: 31337000000 },
    { rank: 3,  shortAddress: 'D3gN8q...AsMn', amount: 28000000000 },
    { rank: 4,  shortAddress: 'MoonS4...HoU2', amount: 19420000000 },
    { rank: 5,  shortAddress: 'WaGm1v...TzH1', amount: 15000000000 },
    { rank: 6,  shortAddress: 'DeGN4F...9qRt', amount: 12500000000 },
    { rank: 7,  shortAddress: 'SoLa7v...kzp7', amount:  9999000000 },
    { rank: 8,  shortAddress: 'Ape1Xj...vKeL', amount:  8420000000 },
    { rank: 9,  shortAddress: 'HodL9B...pQm9', amount:  7300000000 },
    { rank: 10, shortAddress: 'VibeK5...mY5K', amount:  6900000000 },
  ].map(h => ({ ...h, isDemo: true })));
});

// ─── Recent transactions (Helius parsed txns or DexScreener stats) ────────────
app.get('/api/trades', async (req, res) => {
  const cached = fromCache('trades', 15_000);
  if (cached) return res.json(cached);

  const market = fromCache('market', 120_000);
  const pairAddr = market?.pairAddress;
  const addr     = TOKEN_ADDR || market?.tokenAddress;

  // Helius: recent parsed swap transactions for the pair pool
  if (pairAddr && hasHelius()) {
    try {
      const { data } = await axios.get(
        `https://api.helius.xyz/v0/addresses/${pairAddr}/transactions`,
        { params: { 'api-key': HELIUS_KEY, limit: 20, type: 'SWAP' }, timeout: 10_000 }
      );
      if (Array.isArray(data) && data.length) {
        const trades = data.map(tx => ({
          sig:       tx.signature,
          shortSig:  `${tx.signature.slice(0, 8)}...`,
          type:      tx.type,
          ts:        tx.timestamp * 1000,
          fee:       tx.fee,
          nativeTransfers: tx.nativeTransfers || [],
          tokenTransfers:  tx.tokenTransfers  || [],
          source:    'helius',
        }));
        toCache('trades', trades);
        return res.json(trades);
      }
    } catch (_) {}
  }

  // DexScreener trading stats (always available)
  if (market) {
    const stats = {
      source: 'dexscreener_stats',
      txns: market.txns,
      volume24h: market.volume24h,
      volume1h:  market.volume1h,
      price:     market.price,
    };
    toCache('trades', stats);
    return res.json(stats);
  }

  res.status(500).json({ error: 'Trade data unavailable' });
});

// ─── Bull Post Generator ──────────────────────────────────────────────────────
// Primary: DeepSeek AI generates a fresh unique post on every request.
// Fallback: shuffled template queue if AI is unavailable.

const TYPE_PROMPTS = {
  bullish:    'Write a confident, bullish post expressing strong conviction about $ANSEM. Sound like a real crypto holder, not a marketing bot. Direct and authentic.',
  fomo:       'Write a FOMO-inducing post that makes the reader feel like they are missing a big opportunity with $ANSEM. Urgent, real, relatable.',
  data:       'Write a data-focused post presenting the $ANSEM market stats in a compelling way. Use bullet points or structured format. Analytical but exciting. Add NFA disclaimer.',
  hodl:       'Write a HODL/diamond-hands post expressing long-term conviction in $ANSEM and loyalty to the 1M holder mission. Patient and resolute.',
  degen:      'Write a degen-style post about $ANSEM. Chaotic, funny, lowercase energy. Unhinged but loveable. No corporate speak at all.',
  meme:       'Write a meme-style post about $ANSEM. Use viral internet formats like "POV:", "me:", "nobody:". Relatable crypto humor, shareable and funny. Max 3 lines.',
  conviction: 'Write a conviction post about $ANSEM — deep long-term thesis, not just price. Explain WHY the 1M holder milestone matters. Thoughtful and inspiring, no hype.',
  reply:      'Write a short reply-guy post for $ANSEM. Max 2 sentences. The kind of response that gets likes under crypto influencer posts. Sharp, witty, confident.',
  thread:     'Write the opening hook tweet for a Twitter/X thread about $ANSEM. Format it starting with "1/ 🧵". Strong, bold, intriguing — makes people click to read more.',
  cta:        'Write a call-to-action post urging people to buy $ANSEM or join the community now. Direct, energetic, creates urgency around the 1M holder milestone. Include the holder count.',
};

async function generateWithDeepSeek(type, market, holders) {
  const price   = market.price     ? `$${formatP(market.price)}`                                        : 'N/A';
  const change  = market.change24h ? `${market.change24h > 0 ? '+' : ''}${market.change24h.toFixed(1)}%` : 'N/A';
  const mcap    = market.marketCap  ? formatBig(market.marketCap)                                        : 'N/A';
  const vol     = market.volume24h  ? formatBig(market.volume24h)                                        : 'N/A';
  const holdCnt = holders.holders   ? holders.holders.toLocaleString()                                   : 'hundreds of thousands of';

  const { data } = await axios.post(
    'https://api.deepseek.com/chat/completions',
    {
      model: 'deepseek-chat',
      temperature: 1.3,   // high variety — every post genuinely different
      max_tokens: 320,
      messages: [
        {
          role: 'system',
          content:
            'You are a genuine $ANSEM holder on Solana posting on X (Twitter). ' +
            'Write authentic crypto community posts — never sound like a press release or bot. ' +
            'Use the live market data given. ' +
            'Return ONLY the post text. No intro, no quotes, no explanation.',
        },
        {
          role: 'user',
          content:
            `Live $ANSEM data right now:\n` +
            `• Price: ${price}\n` +
            `• 24h change: ${change}\n` +
            `• Market cap: ${mcap}\n` +
            `• 24h volume: ${vol}\n` +
            `• Holders: ${holdCnt} (target: 1,000,000)\n\n` +
            `Task: ${TYPE_PROMPTS[type] || TYPE_PROMPTS.bullish}\n\n` +
            `Write the post now.`,
        },
      ],
    },
    {
      headers: { Authorization: `Bearer ${DEEPSEEK_KEY}`, 'Content-Type': 'application/json' },
      timeout: 20_000,
    }
  );

  const text = data?.choices?.[0]?.message?.content?.trim();
  return text || null;
}

// Template fallback — no repeats across all users
const postQueues = {}; // type -> shuffled queue of indices

function getTemplates(type, market, holders) {
  const price   = market.price    ? `$${formatP(market.price)}`    : 'rapidly growing';
  const change  = market.change24h ? `${market.change24h > 0 ? '+' : ''}${market.change24h.toFixed(1)}%` : '';
  const mcap    = market.marketCap  ? formatBig(market.marketCap)   : '';
  const vol     = market.volume24h  ? formatBig(market.volume24h)   : '';
  const holdCnt = holders.holders   ? holders.holders.toLocaleString() : 'hundreds of thousands of';
  const bullish24 = (market.change24h || 0) > 0;

  const all = {
    bullish: [
      `$ANSEM is one of the most underrated plays on Solana right now. ${price} with ${change} in 24 hours, ${holdCnt} holders, and a community that doesn't quit. The 1 million holder milestone is closer than most people think.`,
      `The fundamentals of $ANSEM speak for themselves. Market cap ${mcap}, 24h volume ${vol}, and a holder base growing every single day. This is not a trend. This is a movement.`,
      `I keep coming back to $ANSEM because the conviction here is different. Not a pump and dump. Just consistent growth, a strong community, and a clear path to mass adoption. ${holdCnt} holders already. We're just getting started.`,
      `What $ANSEM is building is rare — a genuinely loyal holder base. ${price} today. When 1 million holders hits, the narrative changes completely. Most people won't be ready.`,
      `The $ANSEM chart doesn't lie. ${price}, ${change} in 24h, ${holdCnt} holders. Every metric is pointing in the same direction. Up.`,
      `Quiet confidence is when you hold $ANSEM at ${price} and don't feel the need to explain yourself to anyone. ${holdCnt} holders feel exactly the same way.`,
      `The smartest play on Solana right now is $ANSEM. Not because of hype. Because ${holdCnt} people have decided this is the one worth holding. That number is going to 1M.`,
      `$ANSEM at ${price} with ${mcap} market cap and growing. For the size of this community, the valuation still makes no sense. In a good way.`,
    ],
    fomo: [
      `You had every chance to buy $ANSEM early. The chart was there. The community was there. It's ${price} now. Still early compared to where this ends up. Don't be the person explaining why you missed it.`,
      `$ANSEM is ${price} and still going. ${holdCnt} holders and counting toward 1 million. Every day you wait is a day someone else is loading your future bags.`,
      `People sleep on $ANSEM then wonder why they missed it. Right now: ${price}, ${change} in 24h, ${holdCnt} holders. This is still the accumulation window. It won't feel this early forever.`,
      `Imagine explaining to yourself in 6 months why you didn't buy $ANSEM at ${price}. With ${holdCnt} holders. With ${vol} in daily volume. With the community that this has. Don't do that to yourself.`,
      `The last time a Solana community pushed this hard toward 1 million holders it ended in life-changing numbers. $ANSEM is ${price}. ${holdCnt} in. The window doesn't stay open.`,
      `Some tokens you discover after the run. $ANSEM at ${price} with ${holdCnt} holders is still before the run. That gap is closing. Quickly.`,
    ],
    data: [
      `$ANSEM snapshot:\n\n• Price: ${price}\n• 24h: ${change}\n• Market Cap: ${mcap}\n• Volume: ${vol}\n• Holders: ${holdCnt} → 1,000,000\n\nThe numbers are clean. The community is real. DYOR.`,
      `Running the numbers on $ANSEM:\n\nPrice: ${price} (${change} 24h)\nMarket Cap: ${mcap}\nVolume: ${vol}\nHolders: ${holdCnt} of 1M target\n\nFor a community-driven token at this stage these metrics are strong. Watching closely.`,
      `$ANSEM data check:\n\nPrice ${price} · MCap ${mcap} · Vol ${vol}\nHolders: ${holdCnt} / 1,000,000 target\n24h: ${change}\n\nNFA. But the on-chain data doesn't lie. This community is building something real.`,
      `Thread on why $ANSEM metrics matter right now:\n\n1/ Price: ${price} with ${change} momentum\n2/ Volume: ${vol} in 24h — real activity\n3/ Holders: ${holdCnt} with a clear 1M milestone\n4/ Market cap ${mcap} — still room to move\n\nThis is a real project with real metrics. DYOR.`,
    ],
    hodl: [
      `I don't care what $ANSEM does today, this week, or this month. I care where it is when the 1,000,000th holder joins. I'm holding my position. The community is holding. That's the whole strategy.`,
      `Been holding $ANSEM through every single move. ${holdCnt} holders strong. The community doesn't flinch. They buy dips. They hold. They build. That's why this one is different.`,
      `Bought $ANSEM. Closed the app. Set a reminder for 1 million holders. ${price} today. Not interested in the noise. Here for the milestone.`,
      `The $ANSEM thesis is simple: ${holdCnt} people all holding for the same milestone. 1 million holders. When that happens the story changes. I'll still be holding.`,
      `I've watched a lot of tokens come and go. $ANSEM feels different because the holders feel different. Nobody is panicking. Nobody is dumping. ${holdCnt} addresses and counting. Just holding.`,
      `My $ANSEM bags are sealed until 1 million holders. ${price} now. Whatever the price is then — that's when I look. Not before. Diamond hands isn't a phrase. It's a commitment.`,
    ],
    meme: [
      `POV: you bought $ANSEM at ${price} and now you have ${holdCnt} friends you've never met. we're all gonna make it.`,
      `nobody:\nme at 3am: checking $ANSEM holder count for the 47th time. ${holdCnt}. refreshing. ${holdCnt}. refreshing. we're closer.`,
      `the $ANSEM community when the holder count goes up by 1000:\n\n🥹🥹🥹\n\n${holdCnt} strong. the march continues.`,
      `my therapist: what are you obsessing over?\nme: there are ${holdCnt} people holding $ANSEM and we need 1,000,000\nmy therapist: and how does that make you feel\nme: like buying more`,
    ],
    conviction: [
      `The $ANSEM thesis isn't complicated. ${holdCnt} people decided this was worth holding. When that becomes 1,000,000, the network effect changes everything. I'm not here for the trade. I'm here for the milestone.`,
      `What actually matters in crypto long-term is community density. $ANSEM has ${holdCnt} real holders, a clear goal, and a community that doesn't flinch. That combination is rare. Hold accordingly.`,
      `Every great community token had a moment where it seemed unlikely. $ANSEM is at ${holdCnt} holders. The people who don't sell between here and 1M will understand something the market hasn't priced in yet.`,
    ],
    reply: [
      `${holdCnt} holders and still early. you'll understand eventually.`,
      `while you were sleeping, $ANSEM added more holders. ${holdCnt} and counting to 1M.`,
      `${price} today. check back when we hit 1M holders. you're going to wish you remembered this tweet.`,
      `the community doesn't sleep. ${holdCnt} holders. 1M is inevitable.`,
    ],
    thread: [
      `1/ 🧵 I've spent the last week studying $ANSEM on-chain data. What I found changed how I think about this token. Thread:`,
      `1/ 🧵 Most people don't understand what happens when a memecoin hits 1,000,000 holders. $ANSEM is ${holdCnt} away from finding out. Here's why this matters:`,
      `1/ 🧵 The $ANSEM holder count just hit ${holdCnt}. I want to explain why this number is more important than the price. Thread:`,
    ],
    cta: [
      `${holdCnt} people are already holding $ANSEM. The question isn't whether to buy — it's whether you want to be in before 1,000,000. Buy on Bullpen. Join the march.`,
      `The $ANSEM community is at ${holdCnt} holders. We're building to 1,000,000. If you're not in yet, today is the day. Don't let this be the one you watched from the sideline.`,
      `Join ${holdCnt} holders on the march to 1M. $ANSEM is live on Solana. Buy on Bullpen. Be part of something that doesn't happen twice.`,
    ],
    degen: [
      `all in $ANSEM and i refuse to elaborate. ${price}. ${change}. ${holdCnt} holders. we march.`,
      `normies: "what's your investment strategy?"\nme: $ANSEM\nnormies: "that's not a strategy"\nme: ${price}. ${holdCnt} holders. 1 million incoming.\nnormies: "..."\nme: exactly.`,
      `if $ANSEM doesn't make me rich i'll have had the best time holding with the most unhinged community in crypto. ${holdCnt} holders. ${price}. we go to 1M or we go broke trying.`,
      `doctor: "you need to reduce stress"\nme: buys more $ANSEM\ndoctor: "that's the opposite"\nme: ${price}. ${holdCnt} holders. ${change} today. my stress is GONE.`,
      `just checked my $ANSEM bag. ${price}. ${change} today. ${holdCnt} holders. still not selling. still not stressed. this is the way.`,
      `$ANSEM is my retirement plan, my vacation fund, my therapy, and my personality. ${price}. ${holdCnt} holders. 1 million is the destination. i am not early. i am on time.`,
    ],
  };

  return all[type] || all.bullish;
}

function pickUniquePost(type, templates) {
  if (!postQueues[type] || postQueues[type].length === 0) {
    // Build a fresh shuffled queue of all indices for this type
    const indices = templates.map((_, i) => i);
    // Fisher-Yates shuffle
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    postQueues[type] = indices;
  }
  const idx = postQueues[type].shift();
  return templates[idx];
}

app.post('/api/generate-post', async (req, res) => {
  const { type = 'bullish' } = req.body;
  const market  = fromCache('market', 300_000)  || {};
  const holders = fromCache('holders', 300_000) || {};

  // Primary: DeepSeek AI — truly unique every time
  if (hasDeepSeek()) {
    try {
      const post = await generateWithDeepSeek(type, market, holders);
      if (post) return res.json({ post, type, generatedAt: Date.now(), source: 'ai' });
    } catch (e) {
      console.warn('[post-gen] DeepSeek error:', e.message);
    }
  }

  // Fallback: shuffled templates
  const templates = getTemplates(type, market, holders);
  const post      = pickUniquePost(type, templates);
  res.json({ post, type, generatedAt: Date.now(), source: 'template' });
});

function formatP(p) {
  if (!p) return '0';
  if (p >= 1)        return p.toFixed(2);
  if (p >= 0.01)     return p.toFixed(4);
  if (p >= 0.0001)   return p.toFixed(6);
  return p.toFixed(8);
}
function formatBig(n) {
  if (!n) return '$0';
  if (n >= 1e9) return `$${(n/1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n/1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n/1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

app.listen(PORT, () => console.log(`$ANSEM live → http://localhost:${PORT}`));
