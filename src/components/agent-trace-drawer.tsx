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
    badge: "Completed",
    symbol: "✓",
    className:
      "border-emerald-600/25 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  },
  recovered: {
    badge: "Recovered",
    symbol: "↺",
    className:
      "border-emerald-600/25 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  },
  warning: {
    badge: "0 accepted",
    symbol: "!",
    className:
      "border-amber-600/25 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  },
  skipped: {
    badge: "Skipped",
    symbol: "–",
    className: "border-foreground/15 bg-foreground/[0.04] text-foreground/65",
  },
  failed: {
    badge: "Blocked / Failed",
    symbol: "×",
    className:
      "border-red-600/25 bg-red-500/10 text-red-800 dark:text-red-300",
  },
};

function formatCacheBadge(
  status: PublicSearchProcess["qlooCacheStatus"] | null,
): string | null {
  if (!status) return null;
  if (status === "cached") return "Cached (24h TTL)";
  if (status === "mixed") return "Live + cached";
  return "Fetched live";
}

function formatQueryScope(
  scope: PublicSearchStep["queryScope"],
): string | null {
  if (!scope) return null;
  if (scope === "single-and-blended") return "Single-anchor + blended queries";
  if (scope === "single-anchor") return "Single-anchor query";
  return "Blended profile query";
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
      className="rounded-lg border border-foreground/15 bg-foreground/[0.015]"
    >
      {/* Collapsible Trigger Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4
              id={headingId}
              className="text-xs font-semibold tracking-tight text-foreground"
            >
              How CultureBridge arrived at these recommendations
            </h4>
            <span className="rounded border border-foreground/15 bg-background px-1.5 py-0.5 font-mono text-[11px] text-foreground/75">
              {process.mode === "deterministic"
                ? "Deterministic fallback"
                : "Agent-assisted"}
            </span>
            <span className="rounded border border-foreground/15 bg-background px-1.5 py-0.5 font-mono text-[11px] text-foreground/65">
              {process.cached
                ? "Kit cached"
                : formatCacheBadge(process.qlooCacheStatus)}
            </span>
            <span className="font-mono text-[11px] text-foreground/55">
              {process.durationMs} ms
            </span>
          </div>
          <p className="text-xs text-foreground/65">{process.outcomeSummary}</p>
        </div>

        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={panelId}
          onClick={onToggle}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-foreground/20 bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-foreground/[0.04] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
        >
          <span>{isOpen ? "Hide search process" : "Inspect search process"}</span>
          <span className="font-mono text-[11px] text-foreground/55">
            ({process.steps.length})
          </span>
        </button>
      </div>

      {/* Collapsible Body */}
      {isOpen && (
        <div
          id={panelId}
          role="region"
          aria-labelledby={headingId}
          className="space-y-4 border-t border-foreground/10 p-4 text-xs"
        >
          {/* 1. Run Overview Grid */}
          <dl className="grid grid-cols-1 gap-2.5 rounded-md border border-foreground/12 bg-background p-3.5 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-[11px] text-foreground/55">
                Destination &amp; Taste Graph
              </dt>
              <dd className="mt-0.5 font-medium text-foreground">
                {process.city} ·{" "}
                {process.qlooGrounded
                  ? "Qloo taste graph (/search, /v2/insights)"
                  : "Qloo"}
              </dd>
            </div>

            <div>
              <dt className="text-[11px] text-foreground/55">Execution Mode</dt>
              <dd className="mt-0.5 font-medium text-foreground">
                {process.modeLabel}
              </dd>
            </div>

            <div>
              <dt className="text-[11px] text-foreground/55">
                Cache &amp; Timing
              </dt>
              <dd className="mt-0.5 font-mono text-foreground">
                {process.cached
                  ? "Served from 24h response cache"
                  : formatCacheBadge(process.qlooCacheStatus)}{" "}
                · {process.durationMs} ms
              </dd>
            </div>

            <div>
              <dt className="text-[11px] text-foreground/55">Final Outcome</dt>
              <dd className="mt-0.5 font-medium text-foreground capitalize">
                {process.outcome}
              </dd>
            </div>
          </dl>

          {/* 2. Fallback Summary Banner (when fallback occurred) */}
          {process.fallbackTriggered && (
            <div className="rounded-md border border-foreground/15 bg-background p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-foreground">
                  {process.mode === "deterministic"
                    ? "Deterministic Discovery Fallback Used"
                    : "Category Fallback Chain Executed"}
                </span>
                <span
                  className={`rounded border px-1.5 py-0.5 font-mono text-[11px] ${
                    process.fallbackRecovered
                      ? "border-emerald-600/25 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"
                      : "border-amber-600/25 bg-amber-500/10 text-amber-800 dark:text-amber-300"
                  }`}
                >
                  {process.fallbackRecovered
                    ? "Recovered accepted places"
                    : "0 places recovered"}
                </span>
              </div>
              {process.fallbackReason && (
                <p className="mt-1 text-foreground/70">
                  {process.fallbackReason}
                </p>
              )}
            </div>
          )}

          {/* 3. Deterministic Validation Funnel Counts */}
          <div className="rounded-md border border-foreground/12 bg-background p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-foreground">
                Deterministic Validator Totals
              </span>
              <div className="flex flex-wrap items-center gap-3 font-mono text-[11px]">
                <span className="text-emerald-800 dark:text-emerald-300">
                  Accepted: <strong>{process.totals.accepted}</strong>
                </span>
                <span className="text-foreground/70">
                  Held for review: <strong>{process.totals.review}</strong>
                </span>
                <span className="text-foreground/70">
                  Rejected: <strong>{process.totals.rejected}</strong>
                </span>
              </div>
            </div>

            {rejectionEntries.length > 0 ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5 pt-2 border-t border-foreground/10">
                <span className="text-[11px] text-foreground/55">
                  Filtered out by validator:
                </span>
                {rejectionEntries.map(([reasonKey, count]) => (
                  <span
                    key={reasonKey}
                    className="rounded border border-foreground/15 bg-foreground/[0.03] px-2 py-0.5 font-mono text-[11px] text-foreground/75"
                  >
                    {formatRejectionReasonLabel(reasonKey)}: {count}
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-[11px] text-foreground/55">
                Every shown place passed deterministic checks against closed
                venues, hotels/accommodations, transit stations, duplicates, and
                category conflicts.
              </p>
            )}
          </div>

          {/* 4. Sequential Step-by-Step Log */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-foreground/85">
                Step-by-step search &amp; verification log
              </span>
              <span className="text-[11px] text-foreground/50">
                Repeated attempts are numbered distinctly
              </span>
            </div>

            {process.steps.length === 0 ? (
              <p className="rounded-md border border-foreground/12 bg-background p-3 text-foreground/60">
                No individual step events were recorded for this run.
              </p>
            ) : (
              <ol className="divide-y divide-foreground/10 rounded-md border border-foreground/12 bg-background">
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
                    <li key={step.stepNumber} className="space-y-1.5 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[11px] font-semibold text-foreground/80">
                            #{step.stepNumber}
                          </span>
                          <span className="rounded border border-foreground/15 px-1.5 py-0.5 font-mono text-[10px] text-foreground/65">
                            {STEP_KIND_LABELS[step.kind]}
                          </span>
                          {step.attemptNumber > 1 && (
                            <span className="rounded border border-foreground/20 bg-foreground/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-foreground/75">
                              Attempt #{step.attemptNumber}
                            </span>
                          )}
                          <span className="font-semibold text-foreground">
                            {step.title}
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
                          {scopeLabel && (
                            <span className="rounded border border-foreground/12 px-1.5 py-0.5 text-[10px] text-foreground/60">
                              {scopeLabel}
                            </span>
                          )}
                          {stepCacheLabel && (
                            <span className="rounded border border-foreground/12 px-1.5 py-0.5 text-[10px] text-foreground/60">
                              {stepCacheLabel}
                            </span>
                          )}
                          {step.durationMs > 0 && (
                            <span className="text-foreground/50">
                              {step.durationMs} ms
                            </span>
                          )}
                          <span
                            className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${statusStyle.className}`}
                          >
                            <span aria-hidden="true">{statusStyle.symbol}</span>
                            <span>{statusStyle.badge}</span>
                          </span>
                        </div>
                      </div>

                      <p className="text-foreground/70 leading-relaxed">
                        {step.detail}
                      </p>

                      {step.counts && (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5 font-mono text-[11px] text-foreground/60">
                          <span>Accepted: {step.counts.accepted}</span>
                          <span>Review: {step.counts.review}</span>
                          <span>Rejected: {step.counts.rejected}</span>
                          {stepRejections.map(([rKey, rCount]) => (
                            <span
                              key={rKey}
                              className="rounded bg-foreground/[0.04] px-1.5 py-0.5 text-[10px]"
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
