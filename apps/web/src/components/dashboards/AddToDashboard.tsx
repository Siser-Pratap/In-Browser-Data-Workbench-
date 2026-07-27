'use client';

import { useEffect } from 'react';
import { LayoutDashboard } from 'lucide-react';
import { toast } from 'sonner';

import { Menu } from '@/components/ui/Menu';
import type { ChartSpec } from '@/lib/charts/spec';
import { track } from '@/lib/telemetry/telemetry';
import { newId } from '@/lib/utils/id';
import { useDashboardStore } from '@/stores/dashboards';
import { useUiStore } from '@/stores/ui';

/**
 * "Add to dashboard", from any chart.
 *
 * The spec is **copied** with a fresh id rather than referenced. A dashboard
 * tile and the query tab it came from then diverge freely — editing the tab's
 * chart afterwards would otherwise silently rewrite a dashboard the user
 * considers finished.
 */
export function AddToDashboard({ spec }: { spec: ChartSpec }) {
  const dashboards = useDashboardStore((state) => state.dashboards);
  const load = useDashboardStore((state) => state.load);
  const create = useDashboardStore((state) => state.create);
  const addChart = useDashboardStore((state) => state.addChart);
  const setActive = useDashboardStore((state) => state.setActive);
  const setView = useUiStore((state) => state.setView);

  useEffect(() => {
    void load();
  }, [load]);

  async function addTo(dashboardId: string, name: string) {
    track('chart.create');
    await addChart(dashboardId, { ...spec, id: newId('chart') });
    toast.success(`Added to ${name}`, {
      action: {
        label: 'Open',
        onClick: () => {
          setActive(dashboardId);
          setView('dashboards');
        },
      },
    });
  }

  return (
    <Menu
      align="right"
      title="Add this chart to a dashboard"
      label={
        <span className="flex items-center gap-1">
          <LayoutDashboard className="size-3" /> Add to
        </span>
      }
      items={[
        ...dashboards.map((dashboard) => ({
          label: dashboard.name,
          detail: `${dashboard.items.length} chart${dashboard.items.length === 1 ? '' : 's'}`,
          onSelect: () => void addTo(dashboard.id, dashboard.name),
        })),
        {
          label: 'New dashboard…',
          onSelect: async () => {
            const dashboard = await create();
            await addTo(dashboard.id, dashboard.name);
          },
        },
      ]}
    />
  );
}
