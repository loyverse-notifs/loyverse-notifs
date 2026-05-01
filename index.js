const express = require('express');
const axios = require('axios');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));

const {
  DISCORD_WEBHOOK_URL,
  LOYVERSE_ACCESS_TOKEN,
  PORT = 10000
} = process.env;

if (!DISCORD_WEBHOOK_URL) {
  throw new Error('Missing DISCORD_WEBHOOK_URL');
}

if (!LOYVERSE_ACCESS_TOKEN) {
  throw new Error('Missing LOYVERSE_ACCESS_TOKEN');
}

const SNAPSHOT_FILE = path.join(__dirname, 'stock-snapshots.json');
const variantNameCache = new Map();
const stockSnapshots = new Map();

const loyverse = axios.create({
  baseURL: 'https://api.loyverse.com/v1.0',
  timeout: 15000,
  headers: {
    Authorization: `Bearer ${LOYVERSE_ACCESS_TOKEN}`
  }
});

const discord = axios.create({
  timeout: 15000
});

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatQty(value) {
  if (value === null || value === undefined) return 'Unknown';
  return Number.isInteger(value) ? String(value) : String(value);
}

function formatDelta(value) {
  if (value === null || value === undefined) return 'Unknown';
  return value > 0 ? `+${value}` : String(value);
}

function safeField(value, fallback = 'Unknown') {
  const text = String(value ?? fallback).trim() || fallback;
  return text.length > 1024 ? `${text.slice(0, 1021)}...` : text;
}

function stockKey(storeId, variantId) {
  return `${storeId}:${variantId}`;
}

async function loadSnapshots() {
  try {
    if (!fs.existsSync(SNAPSHOT_FILE)) return;

    const raw = await fsp.readFile(SNAPSHOT_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    for (const [key, value] of Object.entries(parsed)) {
      const qty = toNumber(value);
      if (qty !== null) stockSnapshots.set(key, qty);
    }

    console.log(`Loaded ${stockSnapshots.size} stock snapshots`);
  } catch (err) {
    console.warn('Could not load stock snapshots:', err.message);
  }
}

let saveTimer = null;

function scheduleSnapshotSave() {
  clearTimeout(saveTimer);

  saveTimer = setTimeout(async () => {
    try {
      await fsp.writeFile(
        SNAPSHOT_FILE,
        JSON.stringify(Object.fromEntries(stockSnapshots), null, 2),
        'utf8'
      );
    } catch (err) {
      console.error('Failed to save stock snapshots:', err.message);
    }
  }, 300);
}

function rememberSnapshot(storeId, variantId, qty) {
  const parsedQty = toNumber(qty);
  if (!storeId || !variantId || parsedQty === null) return;

  stockSnapshots.set(stockKey(storeId, variantId), parsedQty);
  scheduleSnapshotSave();
}

function getPreviousSnapshot(storeId, variantId) {
  const key = stockKey(storeId, variantId);
  return stockSnapshots.has(key) ? stockSnapshots.get(key) : null;
}

async function loyverseGet(url, attempt = 0) {
  try {
    return await loyverse.get(url);
  } catch (err) {
    const status = err.response?.status;

    if ((status === 429 || status >= 500) && attempt < 2) {
      const retryAfterHeader = err.response?.headers?.['retry-after'];
      const retryMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : (attempt + 1) * 1000;
      await delay(retryMs);
      return loyverseGet(url, attempt + 1);
    }

    throw err;
  }
}

async function postToDiscord(embed) {
  await discord.post(DISCORD_WEBHOOK_URL, {
    embeds: [embed]
  });
}

async function getVariantDisplayName(variantId) {
  if (!variantId) return 'Unknown Product';
  if (variantNameCache.has(variantId)) return variantNameCache.get(variantId);

  const { data: variant } = await loyverseGet(`/variants/${variantId}`);

  let name = (variant.variant_name || '').trim();

  if (!name && variant.item_id) {
    const { data: item } = await loyverseGet(`/items/${variant.item_id}`);
    name = (item.item_name || '').trim();
  }

  const finalName = name || 'Unknown Product';
  variantNameCache.set(variantId, finalName);
  return finalName;
}

function isAdjustmentEvent(event) {
  const type = String(event?.type || '').toLowerCase();

  return (
    type.includes('adjustment') ||
    (!!event?.entity_id && type !== 'inventory_levels.update')
  );
}

function getAdjustmentId(event) {
  return event?.entity_id || event?.adjustment_id || event?.id || null;
}

async function handleAdjustmentEvent(event) {
  const adjustmentId = getAdjustmentId(event);
  if (!adjustmentId) return;

  // Small delay in case Loyverse writes the adjustment slightly after webhook delivery
  await delay(1500);

  const { data } = await loyverseGet(`/inventory/adjustments/${adjustmentId}`);
  const employeeName =
    data.employee_name ||
    data.employee?.name ||
    data.created_by_name ||
    'Unknown';

  const stores = Array.isArray(data.stores) ? data.stores : [];

  for (const store of stores) {
    const lineItems = Array.isArray(store.line_items) ? store.line_items : [];

    for (const line of lineItems) {
      const delta = toNumber(line.stock_delta);
      const after = toNumber(line.post_stock_level);
      const before = (delta !== null && after !== null) ? after - delta : null;

      const productName =
        line.variant_name ||
        line.item_name ||
        (line.variant_id ? await getVariantDisplayName(line.variant_id) : 'Unknown Product');

      if (line.variant_id && store.store_id && after !== null) {
        rememberSnapshot(store.store_id, line.variant_id, after);
      }

      const embed = {
        title: 'Stock Adjustment',
        color: delta !== null && delta < 0 ? 0xE74C3C : 0x2ECC71,
        fields: [
          {
            name: 'Changed By',
            value: safeField(employeeName),
            inline: true
          },
          {
            name: 'Product',
            value: safeField(productName),
            inline: true
          },
          {
            name: 'Store',
            value: safeField(store.store_name || store.store_id),
            inline: true
          },
          {
            name: 'Previous Stock',
            value: safeField(formatQty(before)),
            inline: true
          },
          {
            name: 'Change',
            value: safeField(formatDelta(delta)),
            inline: true
          },
          {
            name: 'New Stock',
            value: safeField(formatQty(after)),
            inline: true
          }
        ],
        footer: {
          text: `Adjustment ID: ${adjustmentId}`
        },
        timestamp: data.created_at || new Date().toISOString()
      };

      await postToDiscord(embed);
    }
  }
}

async function handleInventoryLevelsUpdate(event) {
  const inventoryLevels = Array.isArray(event.inventory_levels)
    ? event.inventory_levels
    : [];

  for (const level of inventoryLevels) {
    const productName = await getVariantDisplayName(level.variant_id);
    const currentStock = toNumber(level.in_stock);
    const previousStock = getPreviousSnapshot(level.store_id, level.variant_id);

    let delta = null;
    if (previousStock !== null && currentStock !== null) {
      delta = currentStock - previousStock;
    }

    if (currentStock !== null) {
      rememberSnapshot(level.store_id, level.variant_id, currentStock);
    }

    const embed = {
      title: 'Quick Stock Update',
      color: 0x3498DB,
      fields: [
        {
          name: 'Changed By',
          value: 'Unknown (not provided by inventory_levels.update webhook)',
          inline: false
        },
        {
          name: 'Product',
          value: safeField(productName),
          inline: true
        },
        {
          name: 'Store',
          value: safeField(level.store_id),
          inline: true
        },
        {
          name: 'Previous Stock',
          value: previousStock === null
            ? 'Unknown (first seen or server restarted)'
            : safeField(formatQty(previousStock)),
          inline: true
        },
        {
          name: 'Change',
          value: safeField(formatDelta(delta)),
          inline: true
        },
        {
          name: 'New Stock',
          value: safeField(formatQty(currentStock)),
          inline: true
        }
      ],
      footer: {
        text: 'For exact user info, use stock adjustments or keep your own audit trail.'
      },
      timestamp: event.created_at || level.updated_at || new Date().toISOString()
    };

    await postToDiscord(embed);
  }
}

async function processWebhook(event) {
  try {
    if (isAdjustmentEvent(event)) {
      await handleAdjustmentEvent(event);
      return;
    }

    if (event?.type === 'inventory_levels.update') {
      await handleInventoryLevelsUpdate(event);
      return;
    }

    console.log('Ignored event:', event?.type || 'unknown');
  } catch (err) {
    console.error(
      'Webhook processing error:',
      err.response?.data || err.message
    );
  }
}

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    cachedVariants: variantNameCache.size,
    trackedStocks: stockSnapshots.size
  });
});

app.post('/webhook', (req, res) => {
  const event = req.body;

  // Optional hardening:
  // Validate X-Loyverse-Signature here before trusting the payload.

  res.status(200).send('OK');
  void processWebhook(event);
});

async function start() {
  await loadSnapshots();

  app.listen(PORT, () => {
    console.log(`Smart Bridge active on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Startup error:', err);
  process.exit(1);
});
