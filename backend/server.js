import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import cors from 'cors';
import cron from 'node-cron';

const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 10;

app.get('/api/items/list', async (req, res) => {
  try {
    const indexUrl = 'https://thebazaar.wiki.gg/wiki/Special:AllPages';
    const { data: html } = await axios.get(indexUrl);
    const $ = cheerio.load(html);
    const items = [];
    $('#mw-content-text li a').each((_, el) => {
      const name = $(el).text().trim();
      if (name) items.push(name);
    });
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: 'Could not load item list' });
  }
});

function extractEnchantments($) {
  const enchantments = [];
  $('h2, h3').each((_, el) => {
    const heading = $(el).text().toLowerCase();
    if (heading.includes('enchantments')) {
      const list = $(el).next('ul');
      if (list.length) {
        list.find('li').each((_, li) => {
          enchantments.push($(li).text().trim());
        });
      }
    }
  });
  return enchantments;
}

async function scrapeItem(name) {
  const formattedName = name.replace(/ /g, '_');
  const url = `https://thebazaar.wiki.gg/wiki/${formattedName}`;
  try {
    const { data: html } = await axios.get(url);
    const $ = cheerio.load(html);
    const description = $('p').first().text().trim() || 'No description available.';
    const type = $('.pi-data[data-source="type"] .pi-data-value').text().trim() || 'Unknown';
    const rarity = $('.pi-data[data-source="rarity"] .pi-data-value').text().trim() || 'Common';
    const enchantments = extractEnchantments($);
    return { name, description, type, rarity, enchantments };
  } catch {
    return {
      name,
      description: 'Unable to fetch item description.',
      type: 'Unknown',
      rarity: 'Unknown',
      enchantments: []
    };
  }
}

app.get('/api/item', async (req, res) => {
  const itemName = req.query.name;
  if (!itemName) return res.status(400).json({ error: 'Missing item name' });

  const cacheKey = itemName.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return res.json(cached.data);
  }

  const itemData = await scrapeItem(itemName);
  cache.set(cacheKey, { data: itemData, timestamp: Date.now() });
  res.json(itemData);
});

app.post('/api/items', async (req, res) => {
  const items = req.body.items;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Missing item list' });
  const results = {};
  await Promise.all(items.map(async (name) => {
    const key = name.toLowerCase();
    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      results[name] = cached.data;
    } else {
      const itemData = await scrapeItem(name);
      cache.set(key, { data: itemData, timestamp: Date.now() });
      results[name] = itemData;
    }
  }));
  res.json(results);
});

app.post('/api/items/refresh', async (req, res) => {
  try {
    const indexRes = await axios.get('http://localhost:3001/api/items/list');
    const itemNames = indexRes.data.items;
    const updated = {};
    await Promise.all(itemNames.map(async (name) => {
      const itemData = await scrapeItem(name);
      cache.set(name.toLowerCase(), { data: itemData, timestamp: Date.now() });
      updated[name] = itemData;
    }));
    res.json({ updated });
  } catch (err) {
    res.status(500).json({ error: 'Refresh failed' });
  }
});

cron.schedule('0 2 * * *', async () => {
  try {
    await axios.post('http://localhost:3001/api/items/refresh');
  } catch (err) {
    console.error('[CRON] Failed to refresh items:', err.message);
  }
});

app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
});
