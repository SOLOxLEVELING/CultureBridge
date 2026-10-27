"use client";

import { useId } from "react";
import type { KeyboardEvent } from "react";
import { formatRejectionReasonLabel } from "@/lib/output";
import type { PublicSearchProcess, PublicSearchStep } from "@/lib/output";

export interface AgentTraceDrawerProps {
  process: PublicSearchProcess;
  isOpen: boolean;
  onToggle: () => void;
}

const STEP_KIND_LABELS: Record<PublicSearchStep["kind"], string> = {
  anchor_verification: "Interest verification",
  anchor_resolution: "Interest lookup",
  place_discovery: "Place discovery",
  tag_lookup: "Category lookup",
  fallback_step: "Fallback stage",
  output_verification: "Quality screening",
  agent_planning: "Discovery step",
  completion: "Summary",
};

const STEP_STATUS_STYLES: Record<
  PublicSearchStep["status"],
  { badge: string; symbol: string; className: string }
> = {
  ok: {
    badge: "Done",
    symbol: "✓",
    className: "border-cb-confirmed/25 bg-cb-confirmed-soft text-cb-confirmed",
  },
  recovered: {
    badge: "Recovered",
    symbol: "↺",
    className: "border-cb-confirmed/25 bg-cb-confirmed-soft text-cb-confirmed",
  },
  warning: {
    badge: "0 accepted",
    symbol: "!",
    className: "border-cb-warning/30 bg-cb-warning-soft text-cb-warning",
  },
  skipped: {
    badge: "Skipped",
    symbol: "–",
    className: "border-cb-border bg-cb-surface text-cb-muted",
  },
  failed: {
    badge: "Failed",
    symbol: "×",
    className: "border-cb-error/30 bg-cb-error-soft text-cb-error",
  },
};

function formatCacheBadge(
  status: PublicSearchProcess["qlooCacheStatus"] | null,
): string | null {
  if (!status) return null;
  if (status === "cached") return "Cached (24h)";
  if (status === "mixed") return "Live + cached";
  return "Live search";
}

function formatQueryScope(
  scope: PublicSearchStep["queryScope"],
): string | null {
  if (!scope) return null;
  if (scope === "single-and-blended") return "Single-interest + combined";
  if (scope === "single-anchor") return "Single-interest";
  return "Combined profile";
}

export function AgentTraceDrawer({
  process,
  isOpen,
  onToggle,
}: AgentTraceDrawerProps) {
  const panelId = useId();
  const headingId = useId();

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" && isOpen) {
      e.stopPropagation();
      onToggle();
    }
  }

  const rejectionEntries = Object.entries(
    process.totals.rejectedReasons ?? {},
  ).filter(([, count]) => count > 0);

  return (
    <section
      aria-labelledby={headingId}
      onKeyDown={handleKeyDown}
      className="overflow-hidden rounded-2xl border border-cb-border bg-cb-card/80 transition-colors"
    >
      {/* Compact bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <h3
            id={headingId}
            className="text-sm font-semibold text-foreground"
          >
            How these suggestions were found
          </h3>
          <span className="hidden text-cb-border-strong sm:inline" aria-hidden="true">
            ·
          </span>
          <p className="text-xs text-cb-muted sm:text-sm">
            {process.outcomeSummary}
          </p>
        </div>

        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={panelId}
          onClick={onToggle}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-cb-border bg-background px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-cb-border-strong hover:bg-cb-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent"
        >
          <span>{isOpen ? "Hide details" : "Show details"}</span>
          <span className="text-cb-muted">({process.steps.length})</span>
        </button>
      </div>

      {/* Expanded transparency sheet */}
      {isOpen && (
        <div
          id={panelId}
          role="region"
          aria-labelledby={headingId}
          className="space-y-4 border-t border-cb-border bg-background/50 p-4 text-sm sm:p-5"
        >
          {/* Overview metadata */}
          <dl className="grid grid-cols-2 gap-3 rounded-xl border border-cb-border bg-cb-card p-3.5 sm:grid-cols-4">
            <div>
              <dt className="text-xs text-cb-muted">Destination</dt>
              <dd className="mt-0.5 font-medium text-foreground">
                {process.city}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-cb-muted">Discovery method</dt>
              <dd className="mt-0.5 font-medium text-foreground">
                {process.modeLabel}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-cb-muted">Data source</dt>
              <dd className="mt-0.5 text-xs font-medium text-foreground">
                {process.cached
                  ? "24h response cache"
                  : formatCacheBadge(process.qlooCacheStatus)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-cb-muted">Search time</dt>
              <dd className="mt-0.5 text-xs font-medium text-foreground">
                {process.durationMs} ms
              </dd>
            </div>
          </dl>

          {/* Fallback notice */}
          {process.fallbackTriggered && (
            <div className="rounded-xl border border-cb-border bg-cb-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-foreground">
                  {process.mode === "deterministic"
                    ? "Direct taste-graph fallback used"
                    : "Broader category search used"}
                </span>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    process.fallbackRecovered
                      ? "bg-cb-confirmed-soft text-cb-confirmed"
                      : "bg-cb-warning-soft text-cb-warning"
                  }`}
                >
                  {process.fallbackRecovered ? "Recovered" : "No recovery"}
                </span>
              </div>
              {process.fallbackReason && (
                <p className="mt-1.5 text-xs text-cb-muted leading-relaxed">
                  {process.fallbackReason}
                </p>
              )}
            </div>
          )}

          {/* Quality screening summary */}
          <div className="rounded-xl border border-cb-border bg-cb-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-foreground">
                Venue quality screening
              </span>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <span className="font-medium text-cb-confirmed">
                  Accepted: <strong>{process.totals.accepted}</strong>
                </span>
                <span className="text-cb-muted">
                  Held for review: <strong>{process.totals.review}</strong>
                </span>
                <span className="text-cb-muted">
                  Filtered out: <strong>{process.totals.rejected}</strong>
                </span>
              </div>
            </div>

            {rejectionEntries.length > 0 ? (
              <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-cb-border pt-2.5">
                <span className="text-xs text-cb-muted">
                  Excluded during screening:
                </span>
                {rejectionEntries.map(([reasonKey, count]) => (
                  <span
                    key={reasonKey}
                    className="rounded-full bg-cb-surface px-2.5 py-0.5 text-xs text-cb-muted"
                  >
                    {formatRejectionReasonLabel(reasonKey)}: {count}
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-1.5 text-xs text-cb-muted leading-relaxed">
                Every place shown passed checks excluding hotels, transit hubs,
                closed venues, duplicates, and category mismatches.
              </p>
            )}
          </div>

          {/* Step-by-step discovery log */}
          <div className="space-y-2">
            <span className="text-xs font-medium text-cb-muted">
              Discovery steps
            </span>

            {process.steps.length === 0 ? (
              <p className="rounded-xl border border-cb-border bg-cb-card p-4 text-xs text-cb-muted">
                No step events recorded for this run.
              </p>
            ) : (
              <ol className="divide-y divide-cb-border rounded-xl border border-cb-border bg-cb-card">
                {process.steps.map((step) => {
                  const statusStyle = STEP_STATUS_STYLES[step.status];
                  const scopeLabel = formatQueryScope(step.queryScope);
                  const stepCacheLabel = formatCacheBadge(step.cacheStatus);
                  const stepRejections = step.counts
                    ? Object.entries(step.counts.rejectedReasons).filter(
                        ([, c]) => c > 0,
                      )
                    : [];

                  return (
                    <li key={step.stepNumber} className="space-y-1.5 p-3.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-cb-surface px-1.5 text-xs font-semibold text-cb-muted">
                            {step.stepNumber}
                          </span>
                          <span className="font-medium text-foreground">
                            {step.title}
                          </span>
                          <span className="rounded-full bg-cb-surface px-2.5 py-0.5 text-xs text-cb-muted">
                            {STEP_KIND_LABELS[step.kind]}
                          </span>
                          {step.attemptNumber > 1 && (
                            <span className="rounded-full bg-cb-surface px-2.5 py-0.5 text-xs text-cb-muted">
                              Attempt #{step.attemptNumber}
                            </span>
                          )}
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5 text-xs">
                          {scopeLabel && (
                            <span className="rounded-full bg-cb-surface px-2.5 py-0.5 text-cb-muted">
                              {scopeLabel}
                            </span>
                          )}
                          {stepCacheLabel && (
                            <span className="rounded-full bg-cb-surface px-2.5 py-0.5 text-cb-muted">
                              {stepCacheLabel}
                            </span>
                          )}
                          {step.durationMs > 0 && (
                            <span className="text-cb-muted">
                              {step.durationMs} ms
                            </span>
                          )}
                          <span
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${statusStyle.className}`}
                          >
                            <span aria-hidden="true">{statusStyle.symbol}</span>
                            {statusStyle.badge}
                          </span>
                        </div>
                      </div>

                      <p className="pl-7 text-xs text-cb-muted leading-relaxed">
                        {step.detail}
                      </p>

                      {step.counts && (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-7 pt-0.5 text-xs text-cb-muted">
                          <span>Accepted: {step.counts.accepted}</span>
                          <span>Review: {step.counts.review}</span>
                          <span>Filtered: {step.counts.rejected}</span>
                          {stepRejections.map(([rKey, rCount]) => (
                            <span
                              key={rKey}
                              className="rounded-full bg-cb-surface px-2 py-0.5"
                            >
                              {formatRejectionReasonLabel(rKey)}: {rCount}
                            </span>
                          ))}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
