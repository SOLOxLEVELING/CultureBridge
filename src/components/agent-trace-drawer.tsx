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
  anchor_verification: "Anchor verification",
  anchor_resolution: "Anchor lookup",
  place_discovery: "Place discovery",
  tag_lookup: "Category tag lookup",
  fallback_step: "Fallback stage",
  output_verification: "Output verification",
  agent_planning: "Agent step",
  completion: "Run boundary",
};

const STEP_STATUS_STYLES: Record<
  PublicSearchStep["status"],
  { badge: string; symbol: string; className: string }
> = {
  ok: {
    badge: "Done",
    symbol: "✓",
    className: "border-cb-confirmed/30 bg-cb-confirmed-soft text-cb-confirmed",
  },
  recovered: {
    badge: "Recovered",
    symbol: "↺",
    className: "border-cb-confirmed/30 bg-cb-confirmed-soft text-cb-confirmed",
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
  return "Fetched live";
}

function formatQueryScope(
  scope: PublicSearchStep["queryScope"],
): string | null {
  if (!scope) return null;
  if (scope === "single-and-blended") return "Single-anchor + blended";
  if (scope === "single-anchor") return "Single-anchor";
  return "Blended profile";
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
      className="rounded-lg border border-cb-border bg-cb-surface/40"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
        <div className="space-y-0.5">
          <h4
            id={headingId}
            className="text-sm font-semibold text-foreground"
          >
            How these suggestions were found
          </h4>
          <p className="text-sm text-cb-muted">{process.outcomeSummary}</p>
        </div>

        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={panelId}
          onClick={onToggle}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-cb-border bg-background px-3.5 py-2 text-sm font-medium text-foreground hover:bg-cb-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent"
        >
          {isOpen ? "Hide" : "Show details"}
          <span className="text-xs text-cb-muted">
            ({process.steps.length} steps)
          </span>
        </button>
      </div>

      {/* Expanded panel */}
      {isOpen && (
        <div
          id={panelId}
          role="region"
          aria-labelledby={headingId}
          className="space-y-4 border-t border-cb-border p-4 text-sm"
        >
          {/* Run overview */}
          <dl className="grid grid-cols-1 gap-3 rounded-lg border border-cb-border bg-background p-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs font-medium text-cb-muted">City</dt>
              <dd className="mt-0.5 font-medium">{process.city}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-cb-muted">Mode</dt>
              <dd className="mt-0.5 font-medium">{process.modeLabel}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-cb-muted">Cache</dt>
              <dd className="mt-0.5 font-mono text-xs">
                {process.cached
                  ? "24h response cache"
                  : formatCacheBadge(process.qlooCacheStatus)}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-cb-muted">Duration</dt>
              <dd className="mt-0.5 font-mono text-xs">
                {process.durationMs} ms
              </dd>
            </div>
          </dl>

          {/* Fallback notice */}
          {process.fallbackTriggered && (
            <div className="rounded-lg border border-cb-border bg-background p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">
                  {process.mode === "deterministic"
                    ? "Deterministic fallback used"
                    : "Category fallback chain executed"}
                </span>
                <span
                  className={`rounded-md px-2 py-0.5 text-xs font-medium ${
                    process.fallbackRecovered
                      ? "bg-cb-confirmed-soft text-cb-confirmed"
                      : "bg-cb-warning-soft text-cb-warning"
                  }`}
                >
                  {process.fallbackRecovered ? "Recovered" : "No recovery"}
                </span>
              </div>
              {process.fallbackReason && (
                <p className="mt-1.5 text-cb-muted">
                  {process.fallbackReason}
                </p>
              )}
            </div>
          )}

          {/* Validator totals */}
          <div className="rounded-lg border border-cb-border bg-background p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">Quality check totals</span>
              <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
                <span className="text-cb-confirmed">
                  Accepted: <strong>{process.totals.accepted}</strong>
                </span>
                <span className="text-cb-muted">
                  Review: <strong>{process.totals.review}</strong>
                </span>
                <span className="text-cb-muted">
                  Rejected: <strong>{process.totals.rejected}</strong>
                </span>
              </div>
            </div>

            {rejectionEntries.length > 0 ? (
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-cb-border pt-2.5">
                <span className="text-xs text-cb-muted">Filtered out:</span>
                {rejectionEntries.map(([reasonKey, count]) => (
                  <span
                    key={reasonKey}
                    className="rounded-md bg-cb-surface px-2 py-0.5 font-mono text-xs text-cb-muted"
                  >
                    {formatRejectionReasonLabel(reasonKey)}: {count}
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-1.5 text-xs text-cb-muted">
                All shown places passed checks for closed venues, hotels,
                transit stations, duplicates, and category conflicts.
              </p>
            )}
          </div>

          {/* Step log */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-medium">Step-by-step log</span>
            </div>

            {process.steps.length === 0 ? (
              <p className="rounded-lg border border-cb-border bg-background p-4 text-cb-muted">
                No step events recorded for this run.
              </p>
            ) : (
              <ol className="divide-y divide-cb-border rounded-lg border border-cb-border bg-background">
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
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="rounded bg-cb-surface px-1.5 py-0.5 font-mono text-xs font-semibold text-cb-muted">
                            #{step.stepNumber}
                          </span>
                          <span className="rounded-md bg-cb-surface px-2 py-0.5 text-xs text-cb-muted">
                            {STEP_KIND_LABELS[step.kind]}
                          </span>
                          {step.attemptNumber > 1 && (
                            <span className="rounded-md bg-cb-surface px-2 py-0.5 text-xs text-cb-muted">
                              Attempt #{step.attemptNumber}
                            </span>
                          )}
                          <span className="font-medium">{step.title}</span>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs">
                          {scopeLabel && (
                            <span className="rounded-md bg-cb-surface px-2 py-0.5 text-xs text-cb-muted">
                              {scopeLabel}
                            </span>
                          )}
                          {stepCacheLabel && (
                            <span className="rounded-md bg-cb-surface px-2 py-0.5 text-xs text-cb-muted">
                              {stepCacheLabel}
                            </span>
                          )}
                          {step.durationMs > 0 && (
                            <span className="text-cb-muted">
                              {step.durationMs} ms
                            </span>
                          )}
                          <span
                            className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium ${statusStyle.className}`}
                          >
                            <span aria-hidden="true">{statusStyle.symbol}</span>
                            {statusStyle.badge}
                          </span>
                        </div>
                      </div>

                      <p className="text-cb-muted leading-relaxed">
                        {step.detail}
                      </p>

                      {step.counts && (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 font-mono text-xs text-cb-muted">
                          <span>Accepted: {step.counts.accepted}</span>
                          <span>Review: {step.counts.review}</span>
                          <span>Rejected: {step.counts.rejected}</span>
                          {stepRejections.map(([rKey, rCount]) => (
                            <span
                              key={rKey}
                              className="rounded bg-cb-surface px-1.5 py-0.5"
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
