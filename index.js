const express = require('express');
const axios = require('axios');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' }));

const {
  DISCORD_WEBHOOK_URL,
  LOYVERSE_ACCESS_TOKEN,
  PORT = 10000,

  QUICK_UPDATE_DELAY_MS = 3500,
  ADJUSTMENT_FETCH_DELAY_MS = 1500,
  RECEIPT_FETCH_DELAY_MS = 1200,

  RECENT_ADJUSTMENT_TTL_MS = 90000,
  RECENT_SALE_TTL_MS = 90000,
  EVENT_DEDUPE_TTL_MS = 10 * 60 * 1000
} = process.env;

if (!DISCORD_WEBHOOK_URL) throw new Error('Missing DISCORD_WEBHOOK_URL');
if (!LOYVERSE_ACCESS_TOKEN) throw new Error('Missing LOYVERSE_ACCESS_TOKEN');

const SNAPSHOT_FILE = path.join(__dirname, 'stock-snapshots.json');

const variantNameCache = new Map();
const storeNameCache = new Map();
const stockSnapshots = new Map();

/**
 * Recent stock adjustments keyed by `${storeId}:${variantId}`
 */
const recentAdjustments = new Map();

/**
 * Recent sales/receipts keyed by `${storeId}:${variantId}`
 */
const recentSales = new Map();

/**
 * Pending timers for inventory_levels.update
 * Key: `${storeId}:${variantId}:${currentStock}`
 */
const pendingInventoryJobs = new Map();

/**
 * Deduped webhook fingerprints
 */
const processedEvents = new Map();

const loyverse = axios.create({
  baseURL: 'https://api.loyverse.com/v1.0',
  timeout: 15000,
  headers: {
    Authorization: `Bearer ${LOYVERSE_ACCESS_TOKEN}`
  }
});

const discord = axios.create({ timeout: 15000 });

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeField(value, fallback = 'Unknown', max = 1024) {
  const text = String(value ?? fallback).trim() || fallback;
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function safeText(value, fallback = 'Unknown', max = 2048) {
  const text = String(value ?? fallback).trim() || fallback;
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function formatQty(value) {
  if (value === null || value === undefined) return 'Unknown';
  return Number.isInteger(value) ? String(value) : String(value);
}

function formatDelta(value) {
  if (value === null || value === undefined) return 'Unknown';
  return value > 0 ? `+${value}` : String(value);
}

function stockKey(storeId, variantId) {
  return `${storeId}:${variantId}`;
}

function inventoryJobKey(storeId, variantId, currentStock) {
  return `${storeId}:${variantId}:${currentStock === null ? 'null' : currentStock}`;
}

function parseTimeMs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Date.now();
}

function colorForDelta(delta, neutral = 0x95A5A6) {
  if (delta === null || delta === undefined) return neutral;
  if (delta < 0) return 0xE74C3C;
  if (delta > 0) return 0x2ECC71;
  return neutral;
}

function eventType(event) {
  return String(event?.type || '').toLowerCase();
}

function cleanupProcessedEvents() {
  const now = Date.now();
  for (const [key, expiresAt] of processedEvents.entries()) {
    if (expiresAt <= now) processedEvents.delete(key);
  }
}

function cleanupExpiringEntries(map, key) {
  const now = Date.now();

  if (key) {
    const current = map.get(key) || [];
    const filtered = current.filter(entry => entry.expiresAt > now);
    if (filtered.length > 0) map.set(key, filtered);
    else map.delete(key);
    return;
  }

  for (const existingKey of map.keys()) {
    cleanupExpiringEntries(map, existingKey);
  }
}

function cleanupRecentAdjustments(key) {
  cleanupExpiringEntries(recentAdjustments, key);
}

function cleanupRecentSales(key) {
  cleanupExpiringEntries(recentSales, key);
}

function fingerprintEvent(event) {
  if (!event || typeof event !== 'object') return 'empty';

  if (event.type === 'inventory_levels.update') {
    const levels = Array.isArray(event.inventory_levels) ? event.inventory_levels : [];
    const normalized = levels
      .map(level => [
        level.store_id ?? '',
        level.variant_id ?? '',
        level.in_stock ?? '',
        level.updated_at ?? ''
      ].join(':'))
      .sort()
      .join('|');

    return `inventory_levels.update:${event.created_at || ''}:${normalized}`;
  }

  const type = String(event.type || 'unknown');
  const entityId = event.entity_id || event.adjustment_id || event.receipt_id || event.id || '';
  const hash = crypto
    .createHash('sha1')
    .update(JSON.stringify(event))
    .digest('hex')
    .slice(0, 12);

  return `${type}:${entityId}:${event.created_at || ''}:${hash}`;
}

function isDuplicateEvent(event) {
  cleanupProcessedEvents();
  const key = fingerprintEvent(event);

  if (processedEvents.has(key)) return true;

  processedEvents.set(key, Date.now() + Number(EVENT_DEDUPE_TTL_MS));
  return false;
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
      const retryMs = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : (attempt + 1) * 1000;

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

function getStoreDisplayName(storeId) {
  return storeNameCache.get(storeId) || storeId || 'Unknown Store';
}

function isAdjustmentEvent(event) {
  const type = eventType(event);
  return (
    type.includes('adjustment') ||
    type.includes('inventory_adjustment') ||
    type.includes('stock_adjustment')
  );
}

function isReceiptEvent(event) {
  const type = eventType(event);
  return (
    type.startsWith('receipts.') ||
    type.includes('receipt')
  );
}

function getAdjustmentId(event) {
  return event?.entity_id || event?.adjustment_id || event?.id || null;
}

function getReceiptId(event) {
  return event?.entity_id || event?.receipt_id || event?.id || null;
}

function registerRecentAdjustment(match) {
  if (!match?.storeId || !match?.variantId) return;

  const key = stockKey(match.storeId, match.variantId);
  cleanupRecentAdjustments(key);

  const list = recentAdjustments.get(key) || [];
  list.push({
    ...match,
    expiresAt: Date.now() + Number(RECENT_ADJUSTMENT_TTL_MS)
  });

  recentAdjustments.set(key, list);
}

function registerRecentSale(match) {
  if (!match?.storeId || !match?.variantId) return;

  const key = stockKey(match.storeId, match.variantId);
  cleanupRecentSales(key);

  const list = recentSales.get(key) || [];
  list.push({
    ...match,
    expiresAt: Date.now() + Number(RECENT_SALE_TTL_MS)
  });

  recentSales.set(key, list);
}

function consumeMatchingEntry(container, ttlMs, {
  storeId,
  variantId,
  currentStock,
  previousStock,
  eventTime
}) {
  if (!storeId || !variantId) return null;

  const key = stockKey(storeId, variantId);
  cleanupExpiringEntries(container, key);

  const list = container.get(key) || [];
  if (list.length === 0) return null;

  const eventMs = parseTimeMs(eventTime);
  let bestIndex = -1;
  let bestScore = -Infinity;

  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    let score = 0;

    if (currentStock !== null && entry.after !== null) {
      if (currentStock !== entry.after) continue;
      score += 10;
    }

    if (
      previousStock !== null &&
      currentStock !== null &&
      entry.delta !== null &&
      previousStock + entry.delta === currentStock
    ) {
      score += 6;
    }

    if (
      previousStock !== null &&
      currentStock !== null &&
      entry.delta !== null &&
      currentStock - previousStock === entry.delta
    ) {
      score += 4;
    }

    if (previousStock !== null && entry.before !== null && previousStock === entry.before) {
      score += 2;
    }

    const entryMs = parseTimeMs(entry.createdAt);
    const ageDiff = Math.abs(eventMs - entryMs);

    if (ageDiff > Number(ttlMs)) continue;

    score += Math.max(0, 3 - Math.floor(ageDiff / 10000));

    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  if (bestIndex === -1) return null;

  const [match] = list.splice(bestIndex, 1);

  if (list.length > 0) container.set(key, list);
  else container.delete(key);

  return match;
}

function consumeMatchingRecentAdjustment(payload) {
  return consumeMatchingEntry(recentAdjustments, RECENT_ADJUSTMENT_TTL_MS, payload);
}

function consumeMatchingRecentSale(payload) {
  return consumeMatchingEntry(recentSales, RECENT_SALE_TTL_MS, payload);
}

function cancelPendingInventoryJob(storeId, variantId, currentStock) {
  const key = inventoryJobKey(storeId, variantId, currentStock);
  const timer = pendingInventoryJobs.get(key);

  if (timer) {
    clearTimeout(timer);
    pendingInventoryJobs.delete(key);
  }
}

function buildMovementEmbed({
  title,
  color,
  actorLabel,
  actorName,
  productName,
  storeName,
  previousStock,
  delta,
  currentStock,
  reason,
  note,
  footer,
  timestamp
}) {
  const fields = [
    {
      name: 'Product',
      value: safeField(productName),
      inline: true
    },
    {
      name: 'Store',
      value: safeField(storeName),
      inline: true
    },
    {
      name: actorLabel,
      value: safeField(actorName),
      inline: true
    },
    {
      name: 'Before',
      value: safeField(formatQty(previousStock)),
      inline: true
    },
    {
      name: 'Change',
      value: safeField(formatDelta(delta)),
      inline: true
    },
    {
      name: 'After',
      value: safeField(formatQty(currentStock)),
      inline: true
    }
  ];

  if (reason) {
    fields.push({
      name: 'Reason',
      value: safeField(reason),
      inline: true
    });
  }

  if (note) {
    fields.push({
      name: 'Note',
      value: safeField(note),
      inline: false
    });
  }

  return {
    title,
    color,
    fields,
    footer: footer ? { text: safeText(footer) } : undefined,
    timestamp
  };
}

async function handleAdjustmentEvent(event) {
  const adjustmentId = getAdjustmentId(event);
  if (!adjustmentId) {
    console.log('Adjustment-like event without adjustment id:', event?.type);
    return;
  }

  await delay(Number(ADJUSTMENT_FETCH_DELAY_MS));

  const { data } = await loyverseGet(`/inventory/adjustments/${adjustmentId}`);

  const employeeName =
    data.employee_name ||
    data.employee?.name ||
    data.created_by_name ||
    'Unknown';

  const adjustmentReason =
    data.reason ||
    data.reason_name ||
    data.adjustment_reason ||
    null;

  const adjustmentNote =
    data.note ||
    data.notes ||
    null;

  const createdAt = data.created_at || event.created_at || new Date().toISOString();
  const stores = Array.isArray(data.stores) ? data.stores : [];

  for (const store of stores) {
    const storeId = store.store_id || null;
    const storeName = store.store_name || getStoreDisplayName(storeId);

    if (storeId && store.store_name) {
      storeNameCache.set(storeId, store.store_name);
    }

    const lineItems = Array.isArray(store.line_items) ? store.line_items : [];

    for (const line of lineItems) {
      const variantId = line.variant_id || null;
      const delta = toNumber(line.stock_delta);

      const after =
        toNumber(line.post_stock_level) ??
        toNumber(line.in_stock_after) ??
        toNumber(line.stock_after);

      const before =
        toNumber(line.pre_stock_level) ??
        toNumber(line.stock_before) ??
        ((delta !== null && after !== null) ? after - delta : null);

      const productName =
        line.variant_name ||
        line.item_name ||
        (variantId ? await getVariantDisplayName(variantId) : 'Unknown Product');

      if (variantId && storeId && after !== null) {
        rememberSnapshot(storeId, variantId, after);
        cancelPendingInventoryJob(storeId, variantId, after);
      }

      registerRecentAdjustment({
        kind: 'adjustment',
        adjustmentId,
        employeeName,
        productName,
        storeId,
        storeName,
        variantId,
        delta,
        before,
        after,
        reason: adjustmentReason || line.reason || null,
        note: adjustmentNote || line.note || null,
        createdAt
      });

      const embed = buildMovementEmbed({
        title: '🛠️ Stock Adjustment',
        color: colorForDelta(delta, 0xF1C40F),
        actorLabel: 'Changed By',
        actorName: employeeName,
        productName,
        storeName,
        previousStock: before,
        delta,
        currentStock: after,
        reason: adjustmentReason || line.reason || null,
        note: adjustmentNote || line.note || null,
        footer: `Type: Adjustment • ID: ${adjustmentId}`,
        timestamp: createdAt
      });

      await postToDiscord(embed);
    }
  }
}

async function handleReceiptEvent(event) {
  const receiptId = getReceiptId(event);
  if (!receiptId) {
    console.log('Receipt-like event without receipt id:', event?.type);
    return;
  }

  await delay(Number(RECEIPT_FETCH_DELAY_MS));

  const { data } = await loyverseGet(`/receipts/${receiptId}`);

  const createdAt =
    data.created_at ||
    data.updated_at ||
    event.created_at ||
    new Date().toISOString();

  const storeId = data.store_id || data.store?.id || null;
  const storeName =
    data.store_name ||
    data.store?.name ||
    getStoreDisplayName(storeId);

  if (storeId && data.store_name) {
    storeNameCache.set(storeId, data.store_name);
  }

  const cashierName =
    data.cashier_name ||
    data.employee_name ||
    data.employee?.name ||
    data.created_by_name ||
    'Unknown';

  const receiptNumber =
    data.receipt_number ||
    data.receipt_no ||
    data.number ||
    receiptId;

  const receiptType = String(
    data.receipt_type ||
    data.type ||
    ''
  ).toLowerCase();

  const isRefund =
    Boolean(data.is_refund) ||
    receiptType.includes('refund') ||
    receiptType.includes('return');

  const lineItems = Array.isArray(data.line_items)
    ? data.line_items
    : Array.isArray(data.items)
      ? data.items
      : [];

  for (const line of lineItems) {
    const variantId =
      line.variant_id ||
      line.variant?.id ||
      null;

    const quantity = Math.abs(
      toNumber(line.quantity) ??
      toNumber(line.qty) ??
      toNumber(line.item_quantity) ??
      0
    );

    if (!variantId || quantity === 0) continue;

    const productName =
      line.variant_name ||
      line.item_name ||
      line.item?.item_name ||
      await getVariantDisplayName(variantId);

    const delta = isRefund ? quantity : -quantity;
    const previousStock = getPreviousSnapshot(storeId, variantId);
    const after = previousStock !== null ? previousStock + delta : null;

    registerRecentSale({
      kind: 'sale',
      receiptId,
      receiptNumber,
      employeeName: cashierName,
      productName,
      storeId,
      storeName,
      variantId,
      delta,
      before: previousStock,
      after,
      reason: isRefund ? 'Refund / return' : 'Sale',
      note: null,
      createdAt
    });

    const embed = buildMovementEmbed({
      title: isRefund ? '↩️ Refund' : '🛒 Sale',
      color: isRefund ? 0x2ECC71 : 0xE67E22,
      actorLabel: 'Cashier',
      actorName: cashierName,
      productName,
      storeName,
      previousStock,
      delta,
      currentStock: after,
      reason: isRefund ? 'Refund / return' : 'Sale',
      note: null,
      footer: `Type: ${isRefund ? 'Refund' : 'Sale'} • Receipt: ${receiptNumber}`,
      timestamp: createdAt
    });

    await postToDiscord(embed);
  }
}

async function finalizeInventoryLevelUpdate(level, event) {
  const storeId = level.store_id || null;
  const variantId = level.variant_id || null;
  const currentStock = toNumber(level.in_stock);
  const previousStock = getPreviousSnapshot(storeId, variantId);

  let delta = null;
  if (previousStock !== null && currentStock !== null) {
    delta = currentStock - previousStock;
  }

  const eventTime = event.created_at || level.updated_at || new Date().toISOString();

  const matchedAdjustment = consumeMatchingRecentAdjustment({
    storeId,
    variantId,
    currentStock,
    previousStock,
    eventTime
  });

  if (matchedAdjustment) {
    if (currentStock !== null && storeId && variantId) {
      rememberSnapshot(storeId, variantId, currentStock);
    }

    console.log(
      `Suppressed inventory_levels.update for ${storeId}/${variantId} ` +
      `because it matched adjustment ${matchedAdjustment.adjustmentId}`
    );
    return;
  }

  const matchedSale = consumeMatchingRecentSale({
    storeId,
    variantId,
    currentStock,
    previousStock,
    eventTime
  });

  if (matchedSale) {
    if (currentStock !== null && storeId && variantId) {
      rememberSnapshot(storeId, variantId, currentStock);
    }

    console.log(
      `Suppressed inventory_levels.update for ${storeId}/${variantId} ` +
      `because it matched receipt ${matchedSale.receiptId}`
    );
    return;
  }

  if (currentStock !== null && storeId && variantId) {
    rememberSnapshot(storeId, variantId, currentStock);
  }

  if (previousStock !== null && currentStock !== null && previousStock === currentStock) {
    console.log(`Ignored no-op inventory update for ${storeId}/${variantId}`);
    return;
  }

  const productName = variantId
    ? await getVariantDisplayName(variantId)
    : 'Unknown Product';

  const storeName = getStoreDisplayName(storeId);

  const embed = buildMovementEmbed({
    title: '✍️ Manual Stock Change',
    color: colorForDelta(delta, 0x3498DB),
    actorLabel: 'Changed By',
    actorName: 'Unknown',
    productName,
    storeName,
    previousStock: previousStock === null ? 'Unknown (first seen / restarted)' : previousStock,
    delta,
    currentStock,
    reason: 'No matching receipt or adjustment found',
    note: 'Detected from inventory_levels.update only',
    footer: 'Type: Manual change • Source: inventory_levels.update',
    timestamp: eventTime
  });

  await postToDiscord(embed);
}

function scheduleInventoryLevelUpdate(level, event) {
  const currentStock = toNumber(level.in_stock);
  const key = inventoryJobKey(level.store_id, level.variant_id, currentStock);

  const existingTimer = pendingInventoryJobs.get(key);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    pendingInventoryJobs.delete(key);

    void finalizeInventoryLevelUpdate(level, event).catch((err) => {
      console.error(
        'Inventory update processing error:',
        err.response?.data || err.message
      );
    });
  }, Number(QUICK_UPDATE_DELAY_MS));

  pendingInventoryJobs.set(key, timer);
}

async function handleInventoryLevelsUpdate(event) {
  const inventoryLevels = Array.isArray(event.inventory_levels)
    ? event.inventory_levels
    : [];

  for (const level of inventoryLevels) {
    scheduleInventoryLevelUpdate(level, event);
  }
}

async function processWebhook(event) {
  try {
    if (isDuplicateEvent(event)) {
      console.log('Duplicate webhook ignored:', event?.type || 'unknown');
      return;
    }

    if (isAdjustmentEvent(event)) {
      await handleAdjustmentEvent(event);
      return;
    }

    if (isReceiptEvent(event)) {
      await handleReceiptEvent(event);
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
  cleanupProcessedEvents();
  cleanupRecentAdjustments();
  cleanupRecentSales();

  res.status(200).json({
    ok: true,
    cachedVariants: variantNameCache.size,
    cachedStores: storeNameCache.size,
    trackedStocks: stockSnapshots.size,
    recentAdjustmentBuckets: recentAdjustments.size,
    recentSaleBuckets: recentSales.size,
    pendingInventoryJobs: pendingInventoryJobs.size,
    processedWebhookFingerprints: processedEvents.size
  });
});

app.post('/webhook', (req, res) => {
  const event = req.body;

  // Optional hardening:
  // Validate Loyverse signature/header here before trusting payload.

  res.status(200).send('OK');
  void processWebhook(event);
});

async function start() {
  await loadSnapshots();

  app.listen(PORT, () => {
    console.log(`Smart Bridge active on port ${PORT}`);
    console.log(`Quick update delay: ${QUICK_UPDATE_DELAY_MS}ms`);
    console.log(`Adjustment fetch delay: ${ADJUSTMENT_FETCH_DELAY_MS}ms`);
    console.log(`Receipt fetch delay: ${RECEIPT_FETCH_DELAY_MS}ms`);
    console.log(`Recent adjustment TTL: ${RECENT_ADJUSTMENT_TTL_MS}ms`);
    console.log(`Recent sale TTL: ${RECENT_SALE_TTL_MS}ms`);
  });
}

start().catch((err) => {
  console.error('Startup error:', err);
  process.exit(1);
});
