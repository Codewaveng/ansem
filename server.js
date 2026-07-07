require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const path    = require('path');

const app          = express();
const PORT         = process.env.PORT || 3000;
const HELIUS_KEY   = process.env.HELIUS_API_KEY || '';
const TOKEN_ADDR   = process.env.ANSEM_TOKEN_ADDRESS || '';
const JOIN_LINK    = process.env.JOIN_LINK || 'https://app.bullpen.fi/';

const _cache = {};
function fromCache(key, maxMs) {
  const e = _cache[key];
  return (e && Date.now() - e.ts < maxMs) ? e.data : null;
}
function toCache(key, data) { _cache[key] = { data, ts: Date.now() }; }

const heliusRpc = () => `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const hasHelius = () => HELIUS_KEY && HELIUS_KEY !== 'your_helius_api_key_here';

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

// ─── Holder count ─────────────────────────────────────────────────────────────
app.get('/api/holders', async (req, res) => {
  const cached = fromCache('holders', 60_000);
  if (cached) return res.json(cached);

  const addr = TOKEN_ADDR || fromCache('market', 120_000)?.tokenAddress;

  if (addr && hasHelius()) {
    // Helius: paginate all token accounts to get total holder count
    try {
      let cursor = undefined, total = 0;
      for (let page = 0; page < 30; page++) {
        const body = {
          jsonrpc: '2.0', id: `p${page}`,
          method: 'getTokenAccountsByMint',
          params: { mint: addr, limit: 1000, cursor },
        };
        const { data } = await axios.post(heliusRpc(), body, { timeout: 10_000 });
        const items = data?.result?.token_accounts || [];
        total += items.filter(a => parseFloat(a.amount) > 0).length;
        cursor = data?.result?.cursor;
        if (!cursor || items.length < 1000) break;
      }
      if (total > 0) {
        const r = { holders: total };
        toCache('holders', r);
        return res.json(r);
      }
    } catch (_) {}

    // Fallback: getTokenLargestAccounts (gives top 20 only, estimates total)
    try {
      const { data } = await axios.post(heliusRpc(), {
        jsonrpc: '2.0', id: 'la',
        method: 'getTokenLargestAccounts',
        params: [addr, { commitment: 'finalized' }],
      }, { timeout: 8000 });
      if (data?.result?.value?.length) {
        const r = { holders: data.result.value.length, isEstimate: true };
        toCache('holders', r);
        return res.json(r);
      }
    } catch (_) {}
  }

  // Try Solscan public API (no key needed)
  if (addr) {
    try {
      const { data } = await axios.get(
        `https://public-api.solscan.io/token/holders?tokenAddress=${addr}&limit=1&offset=0`,
        { timeout: 6000, headers: { 'Accept': 'application/json' } }
      );
      if (data?.total) {
        const r = { holders: data.total };
        toCache('holders', r);
        return res.json(r);
      }
    } catch (_) {}
  }

  res.json({ holders: 0, needsConfig: true });
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
app.post('/api/generate-post', (req, res) => {
  const { type = 'bullish', length = 'short' } = req.body;
  const market = fromCache('market', 300_000) || {};
  const holders = fromCache('holders', 300_000) || {};

  const price   = market.price    ? `$${formatP(market.price)}`    : 'rapidly growing';
  const change  = market.change24h ? `${market.change24h > 0 ? '+' : ''}${market.change24h.toFixed(1)}%` : '';
  const mcap    = market.marketCap  ? formatBig(market.marketCap)   : '';
  const vol     = market.volume24h  ? formatBig(market.volume24h)   : '';
  const holdCnt = holders.holders   ? holders.holders.toLocaleString() : 'hundreds of thousands of';

  const templates = {
    bullish: [
      `$ANSEM is one of the most underrated plays on Solana right now. ${price} with ${change} in 24 hours, ${holdCnt} holders, and a community that doesn't quit. The 1 million holder milestone is coming. Are you positioned?`,
      `The fundamentals of $ANSEM speak for themselves. Market cap ${mcap}, 24h volume ${vol}, and a holder base growing every single day. This is not a trend. This is a movement.`,
      `I keep coming back to $ANSEM because the conviction here is different. Not a pump and dump. Not a rug. Just consistent growth, a strong community, and a clear path to mass adoption. ${holdCnt} holders already. We're just getting started.`,
      `What $ANSEM is building is rare in this space — a genuinely loyal holder base. ${price} today. The community is targeting 1 million holders. When that hits, the narrative shifts entirely.`,
    ],
    fomo: [
      `You had every chance to buy $ANSEM early. The chart was there. The community was there. It's ${price} right now. Still early compared to where this is going. Don't be the person explaining why you missed it at 10x.`,
      `$ANSEM is ${price} and still going. ${holdCnt} holders and counting toward 1 million. Every day you wait is a day someone else is buying your future bags. DYOR. The numbers don't lie.`,
      `People sleep on $ANSEM then wonder why they missed it. Right now: ${price}, ${change} in 24h, ${holdCnt} holders. This is the accumulation phase. It won't feel this cheap forever.`,
    ],
    data: [
      `$ANSEM on-chain data:\n• Price: ${price} (${change} 24h)\n• Market Cap: ${mcap}\n• 24h Volume: ${vol}\n• Holders: ${holdCnt}\n• Target: 1,000,000 holders\n\nThe numbers are healthy. The community is strong. DYOR.`,
      `Running the numbers on $ANSEM:\n\nPrice: ${price}\n24h Change: ${change}\nMarket Cap: ${mcap}\nVolume: ${vol}\nHolders: ${holdCnt} (Target: 1M)\n\nFor a community-driven token, these metrics are impressive. Watching this closely.`,
    ],
    hodl: [
      `I don't care what $ANSEM does today, this week, or this month. I care where it is when the 1,000,000th holder joins. I'm holding my position. The community is holding. Diamond hands aren't a meme — they're a strategy.`,
      `Been holding $ANSEM through every dip. ${holdCnt} holders strong. The community doesn't panic sell. They buy the dip. They hold. They build. That's why this token is different. Not selling until 1M holders.`,
      `Bought $ANSEM, set a reminder for 1 million holders, and closed the app. ${price} today. Could be 10x by that milestone. Could be more. I'm not here to trade noise. I'm here for the signal.`,
    ],
    degen: [
      `all in $ANSEM and i'm not even sorry. ${price}. ${change} today. ${holdCnt} holders. the chart goes up. the vibes are immaculate. i will not be taking questions at this time.`,
      `normies: "what's your strategy?"\nme: $ANSEM.\nnormies: "but what's the plan?"\nme: ${price}. ${holdCnt} holders. 1 million incoming.\nnormies: "that's not a strategy"\nme: it is now.`,
      `if $ANSEM doesn't make me rich at least i'll have had the best time losing money with the most based community in crypto. ${holdCnt} holders. ${price}. we march to 1M.`,
    ],
  };

  const pool = templates[type] || templates.bullish;
  const post = pool[Math.floor(Math.random() * pool.length)];

  res.json({ post, type, generatedAt: Date.now() });
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
