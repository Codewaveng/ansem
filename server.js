require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const HELIUS_KEY = process.env.HELIUS_API_KEY || '';
const TOKEN_ADDRESS = process.env.ANSEM_TOKEN_ADDRESS || '';
const JOIN_LINK = process.env.JOIN_LINK || 'https://ansem.com';

// Simple in-memory cache
const _cache = {};
function fromCache(key, maxAgeMs) {
  const entry = _cache[key];
  if (entry && Date.now() - entry.ts < maxAgeMs) return entry.data;
  return null;
}
function toCache(key, data) {
  _cache[key] = { data, ts: Date.now() };
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── Market data from DexScreener ───────────────────────────────────────────
app.get('/api/market', async (req, res) => {
  const cached = fromCache('market', 20_000);
  if (cached) return res.json(cached);

  try {
    const { data } = await axios.get(
      'https://api.dexscreener.com/latest/dex/search?q=ANSEM',
      { timeout: 8000 }
    );

    const pairs = (data.pairs || []).filter(
      p => p.chainId === 'solana' &&
           p.baseToken?.symbol?.toUpperCase() === 'ANSEM'
    );
    // pick highest-volume pair = most likely the real one
    pairs.sort((a, b) => (parseFloat(b.volume?.h24) || 0) - (parseFloat(a.volume?.h24) || 0));
    const p = pairs[0];

    if (!p) return res.json({ error: 'Pair not found on DexScreener', price: 0 });

    const result = {
      price:        parseFloat(p.priceUsd)           || 0,
      change5m:     parseFloat(p.priceChange?.m5)    || 0,
      change1h:     parseFloat(p.priceChange?.h1)    || 0,
      change24h:    parseFloat(p.priceChange?.h24)   || 0,
      marketCap:    parseFloat(p.marketCap)           || 0,
      fdv:          parseFloat(p.fdv)                 || 0,
      volume24h:    parseFloat(p.volume?.h24)         || 0,
      liquidity:    parseFloat(p.liquidity?.usd)      || 0,
      tokenAddress: p.baseToken?.address              || TOKEN_ADDRESS,
      pairAddress:  p.pairAddress                     || '',
      dexUrl:       p.url                             || '',
      txns24h:      (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0),
    };

    toCache('market', result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Historical prices from CoinGecko (for Wen Rich calculator) ─────────────
app.get('/api/historical', async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 35, 90);
  const cached = fromCache(`hist_${days}`, 300_000); // 5 min cache
  if (cached) return res.json(cached);

  // Try CoinGecko first
  try {
    const { data } = await axios.get(
      `https://api.coingecko.com/api/v3/coins/ansem/market_chart`,
      { params: { vs_currency: 'usd', days, interval: 'daily' }, timeout: 8000 }
    );
    if (data?.prices?.length) {
      toCache(`hist_${days}`, data);
      return res.json({ source: 'coingecko', ...data });
    }
  } catch (_) {}

  // Fallback: try to search CoinGecko for the right ID
  try {
    const { data: search } = await axios.get(
      'https://api.coingecko.com/api/v3/search?query=ANSEM',
      { timeout: 6000 }
    );
    const coin = (search.coins || []).find(
      c => c.symbol.toUpperCase() === 'ANSEM'
    );
    if (coin) {
      const { data } = await axios.get(
        `https://api.coingecko.com/api/v3/coins/${coin.id}/market_chart`,
        { params: { vs_currency: 'usd', days, interval: 'daily' }, timeout: 8000 }
      );
      if (data?.prices?.length) {
        toCache(`hist_${days}`, data);
        return res.json({ source: 'coingecko', coinId: coin.id, ...data });
      }
    }
  } catch (_) {}

  // Last resort: approximate from current price + DexScreener changes
  try {
    const market = fromCache('market', 60_000) || (await axios.get(
      'https://api.dexscreener.com/latest/dex/search?q=ANSEM', { timeout: 6000 }
    ).then(r => {
      const p = (r.data.pairs || []).filter(x => x.chainId === 'solana' && x.baseToken?.symbol?.toUpperCase() === 'ANSEM')
        .sort((a, b) => (parseFloat(b.volume?.h24) || 0) - (parseFloat(a.volume?.h24) || 0))[0];
      return p ? { price: parseFloat(p.priceUsd), change24h: parseFloat(p.priceChange?.h24) } : null;
    }));

    if (market?.price) {
      const cur = market.price;
      const c24 = (market.change24h || 0) / 100;
      const now = Date.now();
      // Synthetic price history (rough estimate only)
      const prices = Array.from({ length: 32 }, (_, i) => {
        const drift = (Math.random() - 0.5) * 0.05;
        const factor = i === 31 ? 1 : Math.pow(1 / (1 + c24), (31 - i) / 31) * (1 + drift);
        return [now - (31 - i) * 86400_000, cur * factor];
      });
      const result = { source: 'estimated', prices };
      toCache(`hist_${days}`, result);
      return res.json(result);
    }
  } catch (_) {}

  res.status(500).json({ error: 'Could not fetch historical data' });
});

// ─── Holder count ────────────────────────────────────────────────────────────
app.get('/api/holders', async (req, res) => {
  const cached = fromCache('holders', 60_000);
  if (cached) return res.json(cached);

  const addr = TOKEN_ADDRESS;

  // Try Helius token-metadata style: paginate getTokenAccounts
  if (addr && HELIUS_KEY && HELIUS_KEY !== 'your_helius_api_key_here') {
    try {
      let page = 1, total = 0, more = true;
      while (more && page <= 20) {
        const { data } = await axios.post(
          `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`,
          {
            jsonrpc: '2.0', id: `holders-${page}`,
            method: 'getTokenAccountsByOwner',
            params: [
              addr,
              { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
              { encoding: 'jsonParsed', commitment: 'finalized' }
            ]
          },
          { timeout: 10_000 }
        );
        const accounts = data?.result?.value || [];
        total += accounts.length;
        more = accounts.length === 100;
        page++;
      }
      const result = { holders: total, isEstimate: page > 20 };
      toCache('holders', result);
      return res.json(result);
    } catch (_) {}

    // Helius fallback: getTokenLargestAccounts to at least confirm existence
    try {
      const { data } = await axios.post(
        `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`,
        {
          jsonrpc: '2.0', id: 'largest',
          method: 'getTokenLargestAccounts',
          params: [addr, { commitment: 'finalized' }]
        },
        { timeout: 8000 }
      );
      if (data?.result?.value) {
        const result = { holders: data.result.value.length, isEstimate: true };
        toCache('holders', result);
        return res.json(result);
      }
    } catch (_) {}
  }

  res.json({ holders: 0, isEstimate: true, needsConfig: true });
});

// ─── Top holders (Helius getTokenLargestAccounts) ───────────────────────────
app.get('/api/top-holders', async (req, res) => {
  const cached = fromCache('top-holders', 120_000);
  if (cached) return res.json(cached);

  const addr = TOKEN_ADDRESS;

  if (addr && HELIUS_KEY && HELIUS_KEY !== 'your_helius_api_key_here') {
    try {
      const { data } = await axios.post(
        `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`,
        {
          jsonrpc: '2.0', id: 'top-holders',
          method: 'getTokenLargestAccounts',
          params: [addr, { commitment: 'finalized' }]
        },
        { timeout: 10_000 }
      );

      if (data?.result?.value) {
        const holders = data.result.value.map((h, i) => ({
          rank: i + 1,
          address: h.address,
          shortAddress: `${h.address.slice(0, 4)}...${h.address.slice(-4)}`,
          amount: parseFloat(h.uiAmount) || 0,
          decimals: h.decimals,
        }));
        toCache('top-holders', holders);
        return res.json(holders);
      }
    } catch (_) {}
  }

  // Mock leaderboard when API isn't configured
  const mock = [
    { rank: 1,  address: '7xKXTRqbvHgPpnUrX9mPQh45aaSy6wvG',  shortAddress: '7xKX...mPQh', amount: 42_069_000_000, label: '🐋 ANSEM Whale #1',  isMock: true },
    { rank: 2,  address: 'Ans3mHJp1vKeLkzjpQmW8B3FUTy9QRKX',  shortAddress: 'Ans3...QRKX', amount: 31_337_000_000, label: '💎 Diamond Hands',   isMock: true },
    { rank: 3,  address: 'D3gN8qRtFbLpKJXvCWmY5TzHoU2eAsMn',  shortAddress: 'D3gN...AsMn', amount: 28_000_000_000, label: '🦈 Big Fish',         isMock: true },
    { rank: 4,  address: 'MoonS4tKJpXvCRmW8B3FULy9neTzHoU2',  shortAddress: 'Moon...HoU2', amount: 19_420_000_000, label: '🌕 Moon Maxi',        isMock: true },
    { rank: 5,  address: 'WaGm1vKeLkzjpQmW8B3FUTy9QRKXeTzH',  shortAddress: 'WaGm...TzH1', amount: 15_000_000_000, label: '🤙 WAGMI Lord',       isMock: true },
    { rank: 6,  address: 'DeGN4FbLpKJXvCWmY5TzHoU2eAsM9qRt',  shortAddress: 'DeGN...9qRt', amount: 12_500_000_000, label: '🎰 Degen Master',     isMock: true },
    { rank: 7,  address: 'SoLa7vHgPpnUrX9mPQh45aaSy6wvGkzp',  shortAddress: 'SoLa...kzp7', amount: 9_999_000_000,  label: '🟣 Solana Chad',      isMock: true },
    { rank: 8,  address: 'Ape1XjpQmW8B3FUTy9QRKXeTzHoU2vKeL', shortAddress: 'Ape1...vKeL', amount: 8_420_000_000,  label: '🦍 APE IN GANG',      isMock: true },
    { rank: 9,  address: 'HodL9B3FUTy9QRKXeTzHoU2vKeLkzjpQm', shortAddress: 'HodL...pQm9', amount: 7_300_000_000,  label: '💪 HODL Warrior',     isMock: true },
    { rank: 10, address: 'VibeK5TzHoU2eAsM9qRtFbLpKJXvCWmY',  shortAddress: 'Vibe...mY5K', amount: 6_900_000_000,  label: '✨ Good Vibes Only',   isMock: true },
  ];
  res.json(mock);
});

// ─── Community posts (curated famous meme posts) ────────────────────────────
app.get('/api/community', (_req, res) => {
  const posts = [
    {
      id: 1,
      username: 'CryptoBull 🐂',
      handle: '@cryptobull',
      avatar: '🐂',
      content: '$ANSEM is unironically the most based community in ALL of crypto. Not even close. These mfers are gonna hit 1M holders before any other memecoin. WAGMI 🚀🚀🚀',
      likes: 12847,
      retweets: 3891,
      time: '2h ago',
      isVerified: true,
      bgColor: '#0d1117',
    },
    {
      id: 2,
      username: 'Solana Maxi 🟣',
      handle: '@solanamaxi',
      avatar: '🟣',
      content: 'Just converted my entire savings to $ANSEM. My financial advisor is NOT happy. I have never been more at peace. This is the way.',
      likes: 25621,
      retweets: 7337,
      time: '4h ago',
      isVerified: false,
      bgColor: '#0d1117',
    },
    {
      id: 3,
      username: 'DeFi Degen 🎰',
      handle: '@defidegen',
      avatar: '🎰',
      content: 'Wife: "Why are you staring at your phone at 3am?"\nMe: "$ANSEM chart"\nWife: "Is it going up?"\nMe: 📈\nWife: "carry on"',
      likes: 42069,
      retweets: 13456,
      time: '6h ago',
      isVerified: false,
      bgColor: '#0d1117',
    },
    {
      id: 4,
      username: 'Crypto Mom 🌙',
      handle: '@cryptomom',
      avatar: '🌙',
      content: 'I told my son to buy Bitcoin. He bought $ANSEM instead. First I was mad. Then I checked the chart. I am now all-in $ANSEM. Never been more proud 🥹',
      likes: 38921,
      retweets: 12103,
      time: '8h ago',
      isVerified: true,
      bgColor: '#0d1117',
    },
    {
      id: 5,
      username: 'WAGMI King 👑',
      handle: '@wagmiking',
      avatar: '👑',
      content: '"$ANSEM will get to 1 million holders" they said.\n\nI said show me.\n\nThey\'re showing me.\n\nI have never doubted these apes for a single second. WAGMI.',
      likes: 16789,
      retweets: 4902,
      time: '12h ago',
      isVerified: true,
      bgColor: '#0d1117',
    },
    {
      id: 6,
      username: 'Moon Math 📐',
      handle: '@moonmath',
      avatar: '📐',
      content: '$ANSEM at 1M holders = impossible to ignore.\n1M holders = mainstream media coverage.\nMainstream coverage = next 100M people learn about $ANSEM.\nThis is not financial advice. This is just math.',
      likes: 14231,
      retweets: 5987,
      time: '1d ago',
      isVerified: false,
      bgColor: '#0d1117',
    },
    {
      id: 7,
      username: 'Based Anon 😶‍🌫️',
      handle: '@basedanon',
      avatar: '😶‍🌫️',
      content: 'People laughed when I bought $ANSEM.\n\nPeople laughed when I told them to buy $ANSEM.\n\nNobody is laughing now.',
      likes: 31337,
      retweets: 8420,
      time: '2d ago',
      isVerified: false,
      bgColor: '#0d1117',
    },
    {
      id: 8,
      username: 'Solana Sam 🏄',
      handle: '@solanasam',
      avatar: '🏄',
      content: 'The $ANSEM community doesn\'t just hold bags. They hold EACH OTHER. Friendliest degens in the space. Bought for the memes. Staying for the people.',
      likes: 9400,
      retweets: 2810,
      time: '3d ago',
      isVerified: false,
      bgColor: '#0d1117',
    },
  ];
  res.json(posts);
});

// ─── Config (join link etc) ──────────────────────────────────────────────────
app.get('/api/config', (_req, res) => {
  res.json({ joinLink: JOIN_LINK });
});

app.listen(PORT, () => {
  console.log(`\n🚀 $ANSEM website is LIVE at http://localhost:${PORT}\n`);
});
