/**
 * Generate the bundled sample datasets.
 *
 * Committed output, not a build step: the samples are fixtures for the E2E suite
 * as well as the "try it with sample data" onboarding path, and tests that
 * regenerate their own input can't detect a regression in it. Re-run by hand
 * (`node scripts/make-samples.mjs`) if the shape ever needs to change.
 *
 * The data is deliberately imperfect — a few nulls, a couple of returns with
 * negative quantities, one duplicated customer id — because a workbench demo
 * where every column is clean teaches nothing about what the tool is for.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'samples');

/** Deterministic PRNG so regenerating produces the same files. */
function mulberry32(seed) {
  return function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(20240727);

const pick = (items) => items[Math.floor(random() * items.length)];
const between = (low, high) => low + Math.floor(random() * (high - low + 1));

const REGIONS = ['North', 'South', 'East', 'West'];
const COUNTRIES = ['United Kingdom', 'Germany', 'France', 'Spain', 'Netherlands', 'Poland'];
const SEGMENTS = ['SMB', 'Mid-market', 'Enterprise'];
const CATEGORIES = ['Hardware', 'Software', 'Services', 'Support'];
const FIRST = ['Ada', 'Grace', 'Alan', 'Katherine', 'Linus', 'Barbara', 'Edsger', 'Radia', 'Tim', 'Margaret'];
const LAST = ['Lovelace', 'Hopper', 'Turing', 'Johnson', 'Torvalds', 'Liskov', 'Dijkstra', 'Perlman', 'Berners-Lee', 'Hamilton'];

function csv(rows) {
  return rows
    .map((row) =>
      row
        .map((value) => {
          const text = value === null || value === undefined ? '' : String(value);
          return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(','),
    )
    .join('\n');
}

function isoDate(daysFromStart) {
  const date = new Date(Date.UTC(2024, 0, 1));
  date.setUTCDate(date.getUTCDate() + daysFromStart);
  return date.toISOString().slice(0, 10);
}

// --- customers ---------------------------------------------------------------

const CUSTOMER_COUNT = 200;
const customers = [['customer_id', 'name', 'country', 'segment', 'signed_up']];

for (let i = 1; i <= CUSTOMER_COUNT; i++) {
  customers.push([
    i,
    `${pick(FIRST)} ${pick(LAST)}`,
    pick(COUNTRIES),
    pick(SEGMENTS),
    isoDate(between(-540, 300)),
  ]);
}
// One id appears twice: a join that silently fans out is the classic data bug,
// and it should be discoverable in the sample data.
customers.push([42, 'Ada Lovelace', 'United Kingdom', 'Enterprise', '2023-11-02']);

// --- orders ------------------------------------------------------------------

const ORDER_COUNT = 1500;
const orders = [
  ['order_id', 'order_date', 'customer_id', 'region', 'category', 'quantity', 'unit_price'],
];

for (let i = 1; i <= ORDER_COUNT; i++) {
  const category = pick(CATEGORIES);
  const isReturn = random() < 0.02;
  orders.push([
    i,
    isoDate(between(0, 545)),
    // A handful of orders reference a customer who isn't in the file, so a LEFT
    // JOIN and an INNER JOIN give visibly different answers.
    random() < 0.01 ? between(CUSTOMER_COUNT + 1, CUSTOMER_COUNT + 20) : between(1, CUSTOMER_COUNT),
    pick(REGIONS),
    category,
    isReturn ? -between(1, 3) : between(1, 40),
    // Some prices are missing entirely, so aggregates have to reckon with nulls.
    random() < 0.03 ? null : (between(1500, 90000) / 100).toFixed(2),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'customers.csv'), `${csv(customers)}\n`);
writeFileSync(join(OUT_DIR, 'orders.csv'), `${csv(orders)}\n`);

console.log(`Wrote ${customers.length - 1} customers and ${orders.length - 1} orders to ${OUT_DIR}`);
