"use client";

import { useState } from "react";
import type {
  DiscoverApiResponse,
  AnchorResolution,
  RecommendationWithVenue,
} from "../api/discover/route";
import type { RecommendationLabel } from "@/lib/recommend";

type PageState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "done"; data: DiscoverApiResponse }
  | { phase: "error"; message: string };

export default function DiscoverPage() {
  const [state, setState] = useState<PageState>({ phase: "idle" });
  const [showDebug, setShowDebug] = useState(false);

  async function runDiscovery() {
    setState({ phase: "loading" });
    try {
      const res = await fetch("/api/discover", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? `API returned ${res.status}`);
      }
      const data: DiscoverApiResponse = await res.json();
      setState({ phase: "done", data });
    } catch (err) {
      setState({
        phase: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          CultureBridge
        </h1>
        <p className="mt-2 text-foreground/60">
          Berlin Cultural Starter Kit — Mumbai Newcomer Demo
        </p>
      </header>

      {state.phase === "idle" && <IdleView onStart={runDiscovery} />}
      {state.phase === "loading" && <LoadingView />}
      {state.phase === "error" && (
        <ErrorView message={state.message} onRetry={runDiscovery} />
      )}
      {state.phase === "done" && (
        <ResultsView
          data={state.data}
          showDebug={showDebug}
          onToggleDebug={() => setShowDebug((s) => !s)}
        />
      )}
    </main>
  );
}

// --- Sub-views ---

function IdleView({ onStart }: { onStart: () => void }) {
  return (
    <div className="rounded-lg border border-foreground/10 p-6">
      <h2 className="text-lg font-semibold">
        Mumbai Newcomer — Berlin Starter Kit
      </h2>
      <p className="mt-2 text-sm text-foreground/60">
        Discover Berlin venues connected to your cultural tastes: Radiohead,
        Asha Bhosle, Prateek Kuhad, Slumdog Millionaire, and more.
      </p>
      <p className="mt-2 text-sm text-foreground/50">
        Each anchor is resolved through Qloo&apos;s search API. Ambiguous
        anchors (like The Office) are omitted with an explanation — never
        silently chosen.
      </p>
      <button
        onClick={onStart}
        className="mt-4 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-80"
      >
        Run Discovery
      </button>
    </div>
  );
}

function LoadingView() {
  return (
    <div className="flex flex-col items-center gap-4 py-16">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-foreground/20 border-t-foreground" />
      <p className="text-sm text-foreground/60">
        Resolving anchors and querying Qloo&apos;s taste graph…
      </p>
    </div>
  );
}

function ErrorView({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-6">
      <h2 className="font-semibold text-red-600 dark:text-red-400">
        Discovery Failed
      </h2>
      <p className="mt-2 text-sm text-foreground/70">{message}</p>
      <button
        onClick={onRetry}
        className="mt-4 rounded-md border border-foreground/20 px-4 py-2 text-sm transition-colors hover:bg-foreground/5"
      >
        Retry
      </button>
    </div>
  );
}

function ResultsView({
  data,
  showDebug,
  onToggleDebug,
}: {
  data: DiscoverApiResponse;
  showDebug: boolean;
  onToggleDebug: () => void;
}) {
  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-lg font-semibold">Anchor Resolution</h2>
        <ul className="mt-3 space-y-2">
          {data.resolutions.map((r) => (
            <ResolutionRow key={r.query} resolution={r} />
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold">
          Recommendations{" "}
          <span className="text-sm font-normal text-foreground/50">
            ({data.recommendations.length} accepted)
          </span>
        </h2>

        {data.recommendations.length === 0 ? (
          <p className="mt-3 text-sm text-foreground/50">
            No accepted recommendations. This may happen if all anchors failed
            to resolve or Qloo returned no qualifying venues.
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            {data.recommendations.map((rec) => (
              <VenueCard key={rec.entityId} rec={rec} />
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-wrap gap-3 text-sm text-foreground/50">
        <Stat label="Queries used" value={data.budget.queriesUsed} />
        <Stat label="Total candidates" value={data.budget.totalResults} />
        <Stat label="In review" value={data.reviewCount} />
        <Stat label="Rejected" value={data.rejectedCount} />
        {data.failures.length > 0 && (
          <Stat label="Query failures" value={data.failures.length} />
        )}
      </section>

      <button
        onClick={onToggleDebug}
        className="text-sm text-foreground/40 underline underline-offset-2 transition-colors hover:text-foreground/60"
      >
        {showDebug ? "Hide" : "Show"} review/rejected details
      </button>

      {showDebug && <DebugPanel data={data} />}
    </div>
  );
}

// --- Components ---

function ResolutionRow({ resolution: r }: { resolution: AnchorResolution }) {
  const typeShort = r.type.replace("urn:entity:", "");
  return (
    <li className="flex items-start gap-2 text-sm">
      <StatusDot status={r.status} />
      <div>
        <span className="font-medium">{r.query}</span>{" "}
        <span className="text-foreground/40">({typeShort})</span>
        {r.status === "resolved" && r.resolved && (
          <span className="text-foreground/60">
            {" "}
            — resolved as {r.resolved.name}
            {r.resolved.disambiguation
              ? ` (${r.resolved.disambiguation})`
              : ""}
          </span>
        )}
        {r.status === "ambiguous" && (
          <span className="text-amber-600 dark:text-amber-400">
            {" "}
            — omitted: {r.ambiguousCount} ambiguous matches, cannot silently
            choose
          </span>
        )}
        {r.status === "not_found" && (
          <span className="text-foreground/50"> — not found in Qloo</span>
        )}
        {r.status === "error" && (
          <span className="text-red-500"> — error: {r.error}</span>
        )}
      </div>
    </li>
  );
}

function StatusDot({
  status,
}: {
  status: "resolved" | "ambiguous" | "not_found" | "error";
}) {
  const color = {
    resolved: "bg-emerald-500",
    ambiguous: "bg-amber-500",
    not_found: "bg-foreground/30",
    error: "bg-red-500",
  }[status];
  return (
    <span
      className={`mt-1.5 block h-2 w-2 shrink-0 rounded-full ${color}`}
    />
  );
}

const LABEL_STYLES: Record<
  RecommendationLabel,
  { bg: string; text: string; display: string }
> = {
  connection: {
    bg: "bg-emerald-500/10",
    text: "text-emerald-700 dark:text-emerald-400",
    display: "Connection",
  },
  "useful-place": {
    bg: "bg-blue-500/10",
    text: "text-blue-700 dark:text-blue-400",
    display: "Useful place",
  },
  exploratory: {
    bg: "bg-foreground/5",
    text: "text-foreground/60",
    display: "Exploratory",
  },
};

function VenueCard({ rec }: { rec: RecommendationWithVenue }) {
  const style = LABEL_STYLES[rec.label];
  const v = rec.venue;

  return (
    <div className="rounded-lg border border-foreground/10 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold">{rec.name}</h3>
          {v.category && (
            <p className="text-sm text-foreground/50">{v.category}</p>
          )}
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${style.bg} ${style.text}`}
        >
          {style.display}
        </span>
      </div>

      <p className="mt-2 text-sm text-foreground/70">{rec.explanation}</p>

      <VenueDetailsRow
        address={v.address}
        website={v.website}
        neighborhood={v.neighborhood}
        priceLevel={v.priceLevel}
        phone={v.phone}
      />
    </div>
  );
}

function VenueDetailsRow({
  address,
  website,
  neighborhood,
  priceLevel,
  phone,
}: {
  address: string | null;
  website: string | null;
  neighborhood: string | null;
  priceLevel: number | null;
  phone: string | null;
}) {
  const details: string[] = [];
  if (neighborhood) details.push(neighborhood);
  if (address) details.push(address);
  if (phone) details.push(phone);
  if (priceLevel != null && priceLevel > 0)
    details.push("$".repeat(priceLevel));

  if (details.length === 0 && !website) return null;

  return (
    <div className="mt-2 space-y-1 text-sm text-foreground/50">
      {details.length > 0 && <p>{details.join(" · ")}</p>}
      {website && (
        <p className="truncate">
          <a
            href={website}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-foreground/70"
          >
            {website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
          </a>
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-foreground/10 px-3 py-1.5">
      <span className="font-mono">{value}</span> {label}
    </div>
  );
}

function DebugPanel({ data }: { data: DiscoverApiResponse }) {
  return (
    <div className="space-y-4 rounded-lg border border-foreground/10 bg-foreground/[0.02] p-4 text-sm">
      {Object.keys(data.rejectedReasons).length > 0 && (
        <div>
          <h3 className="font-medium">Rejection reasons</h3>
          <ul className="mt-1 space-y-0.5 text-foreground/60">
            {Object.entries(data.rejectedReasons).map(([reason, count]) => (
              <li key={reason}>
                {reason}: {count}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.failures.length > 0 && (
        <div>
          <h3 className="font-medium">Query failures</h3>
          <ul className="mt-1 space-y-0.5 text-foreground/60">
            {data.failures.map((f) => (
              <li key={f.queryId}>
                {f.queryId}: {f.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.reviewCount > 0 && (
        <p className="text-foreground/60">
          {data.reviewCount} candidates are in review (weak category evidence).
          They do not appear in the recommendation list.
        </p>
      )}

      {Object.keys(data.rejectedReasons).length === 0 &&
        data.failures.length === 0 &&
        data.reviewCount === 0 && (
          <p className="text-foreground/50">
            No review, rejected, or failure data to show.
          </p>
        )}
    </div>
  );
}
