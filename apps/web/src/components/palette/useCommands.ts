'use client';

import { useMemo } from 'react';

import type { Command } from '@/components/palette/CommandPalette';
import { identifier } from '@/lib/sql/completion';
import { formatSql } from '@/lib/sql/format';
import { useDatasetStore } from '@/stores/datasets';
import { useHistoryStore } from '@/stores/history';
import { useTabsStore } from '@/stores/tabs';
import { useUiStore } from '@/stores/ui';

interface Actions {
  /** Opens the OS file picker — owned by the page, which holds the input. */
  onAddData: () => void;
}

/**
 * Everything the palette can do.
 *
 * Assembled from the stores rather than declared as a static list, so datasets,
 * tabs and snippets are addressable by name the moment they exist. That's what
 * makes the palette worth reaching for on a workspace with fifteen tables — it's
 * a search over the user's own workspace, not just over the app's menus.
 */
export function useCommands({ onAddData }: Actions): Command[] {
  const datasets = useDatasetStore((state) => state.datasets);
  const setActiveTable = useDatasetStore((state) => state.setActiveTable);
  const tabs = useTabsStore((state) => state.tabs);
  const activeId = useTabsStore((state) => state.activeId);
  const setActive = useTabsStore((state) => state.setActive);
  const openTab = useTabsStore((state) => state.openTab);
  const setSql = useTabsStore((state) => state.setSql);
  const runTab = useTabsStore((state) => state.runTab);
  const snippets = useHistoryStore((state) => state.snippets);
  const ui = useUiStore();

  return useMemo(() => {
    const commands: Command[] = [
      {
        id: 'view-data',
        group: 'Go to',
        label: 'Data preview',
        run: () => ui.setView('data'),
      },
      { id: 'view-sql', group: 'Go to', label: 'SQL editor', run: () => ui.setView('sql') },
      {
        id: 'view-dashboards',
        group: 'Go to',
        label: 'Dashboards',
        run: () => ui.setView('dashboards'),
      },

      { id: 'add-data', group: 'Workspace', label: 'Import a file…', run: onAddData },
      {
        id: 'new-tab',
        group: 'Workspace',
        label: 'New query tab',
        run: () => {
          ui.setView('sql');
          openTab();
        },
      },
      {
        id: 'toggle-sidebar',
        group: 'Workspace',
        label: ui.sidebarOpen ? 'Hide the tables sidebar' : 'Show the tables sidebar',
        run: ui.toggleSidebar,
      },
      {
        id: 'toggle-history',
        group: 'Workspace',
        label: ui.historyOpen ? 'Hide query history' : 'Show query history',
        run: ui.toggleHistory,
      },
      {
        id: 'toggle-theme',
        group: 'Workspace',
        label: `Switch to the ${ui.theme === 'dark' ? 'light' : 'dark'} theme`,
        run: ui.toggleTheme,
      },
    ];

    for (const dataset of datasets) {
      commands.push({
        id: `dataset-${dataset.table}`,
        group: 'Tables',
        label: `Preview ${dataset.table}`,
        keywords: dataset.sourceFilename,
        hint: `${dataset.columns.length} cols`,
        run: () => {
          setActiveTable(dataset.table);
          ui.setView('data');
        },
      });
      commands.push({
        id: `query-${dataset.table}`,
        group: 'Tables',
        label: `Query ${dataset.table}`,
        keywords: dataset.sourceFilename,
        run: () => {
          ui.setView('sql');
          openTab({
            name: dataset.table,
            sql: `SELECT *\nFROM ${identifier(dataset.table)}\nLIMIT 100`,
            run: true,
          });
        },
      });
    }

    for (const tab of tabs) {
      if (tab.id === activeId) continue;
      commands.push({
        id: `tab-${tab.id}`,
        group: 'Query tabs',
        label: `Open ${tab.name}`,
        keywords: tab.sql,
        run: () => {
          ui.setView('sql');
          setActive(tab.id);
        },
      });
    }

    for (const snippet of snippets) {
      commands.push({
        id: `snippet-${snippet.id}`,
        group: 'Snippets',
        label: `Run “${snippet.name}”`,
        keywords: snippet.sql,
        run: () => {
          ui.setView('sql');
          openTab({ name: snippet.name, sql: snippet.sql, run: true });
        },
      });
    }

    if (activeId) {
      commands.push(
        {
          id: 'run-active',
          group: 'Current query',
          label: 'Run the current query',
          hint: '⌘↵',
          run: () => void runTab(activeId),
        },
        {
          id: 'format-active',
          group: 'Current query',
          label: 'Format the current query',
          hint: '⇧⌥F',
          run: () => {
            const tab = useTabsStore.getState().tabs.find((item) => item.id === activeId);
            if (tab) setSql(activeId, formatSql(tab.sql));
          },
        },
      );
    }

    return commands;
  }, [
    datasets,
    tabs,
    activeId,
    snippets,
    ui,
    onAddData,
    openTab,
    setActive,
    setActiveTable,
    setSql,
    runTab,
  ]);
}
