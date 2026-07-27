/**
 * The workbench file (`.dwb.json`).
 *
 * What someone hands a colleague alongside the data files: the queries they
 * wrote, the charts they built, and the dashboards they arranged — plus enough
 * *metadata* about each dataset to say what the workspace expects.
 *
 * It deliberately contains **no rows**. Shipping the data inside the file would
 * turn a 4 KB artifact into a gigabyte, and would quietly undo the product's one
 * promise the moment someone emailed it. The receiving side re-imports the same
 * files locally and everything reattaches by table name.
 */

import type { Dashboard } from '@/stores/dashboards';
import type { QueryTab } from '@/stores/tabs';
import type { Snippet } from '@/stores/history';
import type { ColumnSchema, SupportedFormat } from '@/lib/engine/types';

export const WORKBENCH_FILE_VERSION = 1;

export interface WorkbenchDatasetRef {
  table: string;
  sourceFilename: string;
  format: SupportedFormat;
  columns: ColumnSchema[];
  rowCount: number;
}

export interface WorkbenchFile {
  kind: 'data-workbench';
  version: number;
  exportedAt: string;
  datasets: WorkbenchDatasetRef[];
  queries: QueryTab[];
  snippets: Snippet[];
  dashboards: Dashboard[];
}

export function buildWorkbenchFile(input: {
  datasets: WorkbenchDatasetRef[];
  queries: QueryTab[];
  snippets: Snippet[];
  dashboards: Dashboard[];
}): WorkbenchFile {
  return {
    kind: 'data-workbench',
    version: WORKBENCH_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    ...input,
  };
}

export class WorkbenchFileError extends Error {}

/**
 * Parse a `.dwb.json`, rejecting anything that isn't one.
 *
 * Validated rather than trusted: this file arrives from outside — an email
 * attachment, a shared drive — and the failure mode of accepting a malformed
 * one is a workspace that half-loads and leaves the user unsure what they have.
 */
export function parseWorkbenchFile(text: string): WorkbenchFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WorkbenchFileError("That file isn't valid JSON.");
  }

  if (!isRecord(parsed) || parsed['kind'] !== 'data-workbench') {
    throw new WorkbenchFileError("That doesn't look like a workbench file.");
  }

  const version = Number(parsed['version']);
  if (!Number.isFinite(version) || version > WORKBENCH_FILE_VERSION) {
    throw new WorkbenchFileError(
      `This file was written by a newer version of the workbench (v${parsed['version']}).`,
    );
  }

  return {
    kind: 'data-workbench',
    version,
    exportedAt: typeof parsed['exportedAt'] === 'string' ? parsed['exportedAt'] : '',
    datasets: asArray<WorkbenchDatasetRef>(parsed['datasets']),
    queries: asArray<QueryTab>(parsed['queries']),
    snippets: asArray<Snippet>(parsed['snippets']),
    dashboards: asArray<Dashboard>(parsed['dashboards']),
  };
}

/**
 * Which of the file's datasets aren't loaded yet.
 *
 * The import flow uses this to tell the user exactly which files to drop in,
 * rather than letting them discover it one broken chart at a time.
 */
export function missingDatasets(
  file: WorkbenchFile,
  loadedTables: string[],
): WorkbenchDatasetRef[] {
  const loaded = new Set(loadedTables);
  return file.datasets.filter((dataset) => !loaded.has(dataset.table));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
