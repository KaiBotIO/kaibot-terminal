import { useState } from "react";
import { DataMatrix, EmptyState, Section, type MatrixColumn } from "@kaibot/shared";
import { BarChart2 } from "@/lib/icons";
import type { StrategyScorecard } from "@/components/StrategyScorecard";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { GroupFilterChips } from "@/components/positions/GroupFilterChips";
import {
  isActiveRunStatus,
  readActiveOnly,
  runStatusTier,
  showsUnderActiveOnly,
  writeActiveOnly,
} from "@/lib/bot-status";

const tierOf = (c: StrategyScorecard) => runStatusTier(c.status);
const mutedOf = (c: StrategyScorecard) => (isActiveRunStatus(c.status) ? undefined : "opacity-55");

export function StrategyStatusTable({
  rows,
  metricColumns,
}: {
  rows: StrategyScorecard[];
  metricColumns: MatrixColumn<StrategyScorecard>[];
}) {
  const [activeOnly, setActiveOnly] = useState(readActiveOnly);
  const activeCount = rows.filter((c) => isActiveRunStatus(c.status)).length;
  const shown = rows.filter(showsUnderActiveOnly);
  const visible = activeOnly ? shown : rows;

  const toggle = () => {
    setActiveOnly((on) => {
      writeActiveOnly(!on);
      return !on;
    });
  };

  return (
    <Section
      label="By strategy"
      meta={`same trades, split per bot · ${activeCount} active / ${rows.length} total`}
      actions={
        rows.length > 0 ? (
          <GroupFilterChips
            chips={[{ key: "active", label: "Active only", count: shown.length }]}
            active={activeOnly ? "active" : ""}
            onChange={toggle}
          />
        ) : undefined
      }
      flush
    >
      {rows.length > 0 ? (
        <DataMatrix
          rows={visible}
          rowKey={(c) => c.key}
          defaultSort={{ key: "net", dir: "desc" }}
          sortTier={tierOf}
          rowClassName={mutedOf}
          columns={[
            {
              key: "strategy",
              header: "Strategy",
              sortable: true,
              sortAccessor: (c) => c.strategy,
              cell: (c) => (
                <span className="font-mono text-xs text-[var(--kb-teal)]">{c.strategy}</span>
              ),
            },
            {
              key: "status",
              header: "Status",
              cell: (c) => (
                <span className="inline-flex items-center gap-1.5">
                  <RunStatusBadge status={c.status ?? "unknown"} />
                  {(c.openExecutions ?? 0) > 0 && (
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {c.openExecutions} open
                    </span>
                  )}
                </span>
              ),
            },
            ...metricColumns,
          ]}
        />
      ) : (
        <EmptyState
          className="py-8"
          icon={BarChart2}
          title="No per-strategy split yet"
          description="Each bot gets its own row once one of its positions closes."
        />
      )}
    </Section>
  );
}
