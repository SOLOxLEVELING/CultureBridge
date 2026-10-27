"use client";

import dynamic from "next/dynamic";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { AnchorSearchResponse } from "@/lib/api";
import {
  ANCHOR_TYPE_META,
  CITY_META,
  LABEL_PRESENTATION,
  MAX_TRUSTED_ANCHORS,
  PERSONA_PRESETS,
  SUPPORTED_ANCHOR_TYPES,
  TESTED_CITIES,
  addAnchor,
  applyAnchorLookupFailure,
  applyAnchorLookupResult,
  applyKitGenerationError,
  applyKitGenerationResponse,
  buildKitRequestPayload,
  buildPracticalDetailsView,
  canGenerateKit,
  confirmAnchorCandidate,
  createInitialFlowState,
  deriveFlowPhase,
  describeCategoryEvidence,
  extractMapMarkers,
  formatAnchorType,
  formatRecommendationProvenance,
  getKitStatusPresentation,
  getLabelPresentation,
  groupRecommendationsByCategory,
  removeAnchor,
  resolveSelectionState,
  selectCity,
  selectPreset,
  setAnchorEditing,
  startAnchorLookup,
  startKitGeneration,
  unconfirmAnchor,
  updateAnchor,
} from "@/lib/input";
import type {
  AnchorItem,
  FlowPhase,
  FlowState,
  PresetId,
  SafeKitCompletion,
  SafeRecommendationItem,
  SupportedAnchorType,
} from "@/lib/input";
import { AgentTraceDrawer } from "./agent-trace-drawer";

const ResultsMap = dynamic(() => import("./results-map"), {
  ssr: false,
  loading: () => (
    <div
      role="status"
      aria-live="polite"
      className="flex h-64 w-full items-center justify-center rounded-lg border border-cb-border bg-cb-surface text-sm text-cb-muted sm:h-80 lg:h-96"
    >
      Loading map…
    </div>
  ),
});

const FLOW_PHASE_LABELS: Record<
  FlowPhase,
  { badge: string; instruction: string }
> = {
  initial_profile: {
    badge: "Getting started",
    instruction:
      "Find matches for your interests below, then confirm each one is correct.",
  },
  editing_anchors: {
    badge: "Adding interests",
    instruction:
      "Add up to five interests, then find and confirm matches for each.",
  },
  searching_matches: {
    badge: "Searching",
    instruction: "Looking for matches…",
  },
  waiting_for_confirmation: {
    badge: "Pick the right matches",
    instruction:
      "We found possible matches — pick the correct one for each interest.",
  },
  lookup_failure: {
    badge: "Needs attention",
    instruction:
      "Some interests couldn't be matched. Edit, retry, or remove them to continue.",
  },
  ready_to_generate: {
    badge: "Ready",
    instruction:
      "All your interests are confirmed. Build your guide when you're ready.",
  },
  generating: {
    badge: "Building your guide",
    instruction: "Finding places that match your taste…",
  },
  success: {
    badge: "Your guide is ready",
    instruction:
      "Explore your recommendations below, or edit your interests to get a different set.",
  },
  empty_recommendations: {
    badge: "No places found",
    instruction:
      "No places met our quality checks for this combination. Try different interests or a different city.",
  },
  generation_error: {
    badge: "Something went wrong",
    instruction:
      "Your city and confirmed interests are saved. You can try again whenever you're ready.",
  },
};

export function StarterKitFlow() {
  const [state, setState] = useState<FlowState>(() => createInitialFlowState());
  const [formError, setFormError] = useState<string | null>(null);
  const [isAddRowOpen, setIsAddRowOpen] = useState<boolean>(false);
  const [newQuery, setNewQuery] = useState<string>("");
  const [newType, setNewType] =
    useState<SupportedAnchorType>("urn:entity:artist");
  const [isErrorTraceOpen, setIsErrorTraceOpen] = useState<boolean>(false);
  const [view, setView] = useState<"setup" | "results">("setup");

  const kitSubmittingRef = useRef<boolean>(false);
  const stateRef = useRef<FlowState>(state);
  stateRef.current = state;

  const anchorsSectionRef = useRef<HTMLElement | null>(null);

  const baseId = useId();
  const phase = deriveFlowPhase(state);
  const phaseMeta = FLOW_PHASE_LABELS[phase];
  const isGenerating = state.generation.status === "loading";

  const confirmedCount = state.anchors.filter(
    (a) => a.status === "confirmed" && a.confirmedEntity !== null,
  ).length;
  const unsearchedAnchors = state.anchors.filter(
    (a) => a.status === "unsearched",
  );
  const isReady = canGenerateKit(state);

  // Transition to results view when generation produces a response
  useEffect(() => {
    const s = state.generation.status;
    if (s === "success" || s === "partial" || s === "empty") {
      setView("results");
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [state.generation.status]);

  function handleEditInterests() {
    setView("setup");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function focusAnchorsEditor() {
    anchorsSectionRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }

  // ── Lookup actions ─────────────────────────────────────────

  async function lookupSingleAnchor(
    anchorId: string,
    query: string,
    type: SupportedAnchorType,
  ): Promise<void> {
    setFormError(null);
    setState((prev) => startAnchorLookup(prev, anchorId));

    try {
      const res = await fetch("/api/anchors/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, type }),
      });
      const data: AnchorSearchResponse = await res.json();
      setState((prev) => applyAnchorLookupResult(prev, anchorId, data));
    } catch (err) {
      setState((prev) => applyAnchorLookupFailure(prev, anchorId, err));
    }
  }

  async function lookupAllUnsearched(): Promise<void> {
    const targets = stateRef.current.anchors.filter(
      (a) => a.status === "unsearched" || a.status === "lookup_error",
    );
    if (targets.length === 0) return;
    setFormError(null);

    await Promise.allSettled(
      targets.map((anchor) =>
        lookupSingleAnchor(anchor.id, anchor.query, anchor.type),
      ),
    );
  }

  // ── Profile & City actions ─────────────────────────────────

  function handleSelectPreset(presetId: PresetId) {
    setFormError(null);
    const transition = selectPreset(stateRef.current, presetId);
    if (!transition.ok) {
      setFormError(transition.error);
      return;
    }
    setState(transition.state);
    setIsAddRowOpen(presetId === "custom");
    setNewQuery("");
  }

  function handleSelectCity(city: string) {
    setFormError(null);
    const transition = selectCity(stateRef.current, city);
    if (!transition.ok) {
      setFormError(transition.error);
      return;
    }
    setState(transition.state);
  }

  // ── Anchor CRUD actions ────────────────────────────────────

  async function handleAddAnchorSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const transition = addAnchor(stateRef.current, newQuery, newType);
    if (!transition.ok) {
      setFormError(transition.error);
      return;
    }

    const addedAnchor =
      transition.state.anchors[transition.state.anchors.length - 1];
    setState(transition.state);
    setNewQuery("");
    if (transition.state.anchors.length >= MAX_TRUSTED_ANCHORS) {
      setIsAddRowOpen(false);
    }

    if (addedAnchor) {
      await lookupSingleAnchor(
        addedAnchor.id,
        addedAnchor.query,
        addedAnchor.type,
      );
    }
  }

  async function handleUpdateAnchor(
    anchorId: string,
    query: string,
    type: SupportedAnchorType,
  ) {
    setFormError(null);
    const prevAnchor = stateRef.current.anchors.find((a) => a.id === anchorId);
    const transition = updateAnchor(stateRef.current, anchorId, query, type);
    if (!transition.ok) {
      setFormError(transition.error);
      return;
    }

    setState(transition.state);
    const updated = transition.state.anchors.find((a) => a.id === anchorId);
    const didChange =
      !prevAnchor ||
      prevAnchor.query.trim().toLowerCase() !== query.trim().toLowerCase() ||
      prevAnchor.type !== type ||
      updated?.status === "unsearched";

    if (updated && didChange) {
      await lookupSingleAnchor(updated.id, updated.query, updated.type);
    }
  }

  function handleRemoveAnchor(anchorId: string) {
    setFormError(null);
    const transition = removeAnchor(stateRef.current, anchorId);
    if (!transition.ok) {
      setFormError(transition.error);
      return;
    }
    setState(transition.state);
    if (transition.state.anchors.length === 0) {
      setIsAddRowOpen(true);
    }
  }

  function handleConfirmCandidate(anchorId: string, entityId: string) {
    setFormError(null);
    const transition = confirmAnchorCandidate(
      stateRef.current,
      anchorId,
      entityId,
    );
    if (!transition.ok) {
      setFormError(transition.error);
      return;
    }
    setState(transition.state);
  }

  function handleUnconfirmAnchor(anchorId: string) {
    setFormError(null);
    const transition = unconfirmAnchor(stateRef.current, anchorId);
    if (!transition.ok) {
      setFormError(transition.error);
      return;
    }
    setState(transition.state);
  }

  // ── Kit Generation (`/api/kit`) ────────────────────────────

  async function handleGenerateKit() {
    if (kitSubmittingRef.current) return;

    const current = stateRef.current;
    const payload = buildKitRequestPayload(current);
    if (!payload) {
      setFormError(
        "Confirm or remove all pending interests before building your guide.",
      );
      return;
    }

    const started = startKitGeneration(current);
    if (!started.ok) {
      setFormError(started.error);
      return;
    }

    kitSubmittingRef.current = true;
    setFormError(null);
    setIsErrorTraceOpen(false);
    setState(started.state);

    try {
      const res = await fetch("/api/kit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body: unknown = await res.json().catch(() => null);
      setState((prev) => applyKitGenerationResponse(prev, body, res.status));
    } catch (err) {
      setState((prev) => applyKitGenerationError(prev, err));
    } finally {
      kitSubmittingRef.current = false;
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-cb-border bg-background/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-3.5 sm:px-8">
          <span className="text-lg font-semibold tracking-tight">
            CultureBridge
          </span>
          <div className="flex items-center gap-3 text-sm text-cb-muted">
            <span>{state.city}</span>
            {view === "setup" && state.anchors.length > 0 && (
              <>
                <span className="text-cb-border" aria-hidden="true">|</span>
                <span>
                  {confirmedCount} of {state.anchors.length} confirmed
                </span>
              </>
            )}
            {view === "results" && (
              <button
                type="button"
                onClick={handleEditInterests}
                className="rounded-lg border border-cb-border px-3 py-1 text-xs font-medium text-foreground hover:bg-cb-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent"
              >
                Edit interests
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-8 sm:px-8 sm:py-12">
        {/* Setup workspace — only shown before generation */}
        {view === "setup" && (
        <div className="mx-auto max-w-2xl space-y-10">
          {/* Hero introduction */}
          <section aria-label="Introduction" className="space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Discover {state.city} through what you already love
            </h1>
            <p className="max-w-lg text-base text-cb-muted">
              Tell us about your favorite artists, shows, films, and brands.
              We&rsquo;ll find places that match your taste.
            </p>
            <p
              className="text-sm text-cb-muted"
              role="status"
              aria-live="polite"
            >
              {phaseMeta.instruction}
            </p>
          </section>

          {/* City selector */}
          <section
            aria-labelledby={`${baseId}-city-heading`}
            className="space-y-3"
          >
            <h2
              id={`${baseId}-city-heading`}
              className="text-base font-semibold"
            >
              Where are you headed?
            </h2>

            <div
              role="group"
              aria-labelledby={`${baseId}-city-heading`}
              className="grid grid-cols-2 gap-3"
            >
              {TESTED_CITIES.map((cityOption) => {
                const selected = state.city === cityOption;
                const meta = CITY_META[cityOption];
                return (
                  <button
                    key={cityOption}
                    type="button"
                    aria-pressed={selected}
                    disabled={isGenerating}
                    onClick={() => handleSelectCity(cityOption)}
                    className={`flex flex-col items-start rounded-lg border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent disabled:cursor-not-allowed disabled:opacity-50 ${
                      selected
                        ? "border-cb-accent bg-cb-accent-soft"
                        : "border-cb-border hover:border-foreground/30 hover:bg-cb-surface"
                    }`}
                  >
                    <div className="flex w-full items-center justify-between">
                      <span className="text-sm font-semibold">
                        {meta.name}
                      </span>
                      <span
                        className={`h-2.5 w-2.5 rounded-full border-2 transition-colors ${
                          selected
                            ? "border-cb-accent bg-cb-accent"
                            : "border-cb-border bg-transparent"
                        }`}
                        aria-hidden="true"
                      />
                    </div>
                    <span className="mt-0.5 text-sm text-cb-muted">
                      {meta.country}
                    </span>
                    <p className="mt-1.5 text-xs text-cb-muted leading-relaxed">
                      {meta.note}
                    </p>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Profile selector */}
          <section
            aria-labelledby={`${baseId}-persona-heading`}
            className="space-y-3"
          >
            <h2
              id={`${baseId}-persona-heading`}
              className="text-base font-semibold"
            >
              Start with a taste profile
            </h2>

            <div
              role="group"
              aria-labelledby={`${baseId}-persona-heading`}
              className="grid grid-cols-1 gap-2.5 sm:grid-cols-2"
            >
              {PERSONA_PRESETS.map((preset) => {
                const selected = state.selectedPresetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    aria-pressed={selected}
                    disabled={isGenerating}
                    onClick={() => handleSelectPreset(preset.id)}
                    className={`flex flex-col items-start rounded-lg border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent disabled:cursor-not-allowed disabled:opacity-50 ${
                      selected
                        ? "border-cb-accent bg-cb-accent-soft"
                        : "border-cb-border hover:border-foreground/30 hover:bg-cb-surface"
                    }`}
                  >
                    <div className="flex w-full items-center justify-between">
                      <span className="text-sm font-semibold">
                        {preset.name}
                      </span>
                      <span className="text-xs text-cb-muted">
                        {preset.anchors.length > 0
                          ? `${preset.anchors.length} interests`
                          : "Blank"}
                      </span>
                    </div>
                    <p className="mt-1.5 text-xs text-cb-muted leading-relaxed">
                      {preset.description}
                    </p>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Interests editor */}
          <section
            ref={anchorsSectionRef}
            aria-labelledby={`${baseId}-anchors-heading`}
            className="scroll-mt-20 space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2
                  id={`${baseId}-anchors-heading`}
                  className="text-base font-semibold"
                >
                  Your interests
                </h2>
                <p className="mt-0.5 text-sm text-cb-muted">
                  We&rsquo;ll match each one to make sure we find the right
                  thing.
                </p>
              </div>

              <div className="flex items-center gap-2">
                {unsearchedAnchors.length > 0 && (
                  <button
                    type="button"
                    disabled={isGenerating}
                    onClick={lookupAllUnsearched}
                    className="rounded-lg bg-cb-accent px-3.5 py-2 text-sm font-medium text-cb-accent-fg transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Find matches for{" "}
                    {unsearchedAnchors.length === 1
                      ? "1 interest"
                      : `all ${unsearchedAnchors.length}`}
                  </button>
                )}

                {state.anchors.length < MAX_TRUSTED_ANCHORS &&
                  !isAddRowOpen && (
                    <button
                      type="button"
                      disabled={isGenerating}
                      onClick={() => {
                        setFormError(null);
                        setIsAddRowOpen(true);
                      }}
                      className="rounded-lg border border-cb-border px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-cb-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Add another
                    </button>
                  )}
              </div>
            </div>

            {formError && (
              <div
                role="alert"
                className="rounded-lg border border-cb-error/30 bg-cb-error-soft px-4 py-3 text-sm text-cb-error"
              >
                {formError}
              </div>
            )}

            {/* Interest rows */}
            <div className="divide-y divide-cb-border rounded-lg border border-cb-border">
              {state.anchors.length === 0 && !isAddRowOpen && (
                <div className="p-8 text-center">
                  <p className="text-sm font-medium text-foreground">
                    No interests yet
                  </p>
                  <p className="mt-1 text-sm text-cb-muted">
                    Add an artist, TV show, movie, brand, or person to discover
                    places in {state.city}.
                  </p>
                  <button
                    type="button"
                    disabled={isGenerating}
                    onClick={() => setIsAddRowOpen(true)}
                    className="mt-4 rounded-lg bg-cb-accent px-4 py-2 text-sm font-medium text-cb-accent-fg transition-opacity hover:opacity-90"
                  >
                    Add your first interest
                  </button>
                </div>
              )}

              {state.anchors.map((anchor) => (
                <AnchorRow
                  key={anchor.id}
                  anchor={anchor}
                  disabled={isGenerating}
                  onLookup={() =>
                    lookupSingleAnchor(anchor.id, anchor.query, anchor.type)
                  }
                  onStartEdit={() =>
                    setState((prev) => setAnchorEditing(prev, anchor.id, true))
                  }
                  onCancelEdit={() =>
                    setState((prev) => setAnchorEditing(prev, anchor.id, false))
                  }
                  onSaveEdit={(query, type) =>
                    handleUpdateAnchor(anchor.id, query, type)
                  }
                  onRemove={() => handleRemoveAnchor(anchor.id)}
                  onConfirm={(entityId) =>
                    handleConfirmCandidate(anchor.id, entityId)
                  }
                  onUnconfirm={() => handleUnconfirmAnchor(anchor.id)}
                />
              ))}

              {/* Add interest form */}
              {isAddRowOpen && state.anchors.length < MAX_TRUSTED_ANCHORS && (
                <form
                  onSubmit={handleAddAnchorSubmit}
                  className="bg-cb-surface/50 p-4"
                >
                  <div className="mb-3 flex items-center justify-between">
                    <span className="text-sm font-medium text-cb-muted">
                      Add interest ({state.anchors.length + 1} of{" "}
                      {MAX_TRUSTED_ANCHORS})
                    </span>
                    {state.anchors.length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          setIsAddRowOpen(false);
                          setFormError(null);
                        }}
                        className="text-sm text-cb-muted hover:text-foreground"
                      >
                        Cancel
                      </button>
                    )}
                  </div>

                  <div className="flex flex-col gap-2.5 sm:flex-row">
                    <div className="flex-1">
                      <label
                        htmlFor={`${baseId}-new-anchor-query`}
                        className="sr-only"
                      >
                        Name
                      </label>
                      <input
                        id={`${baseId}-new-anchor-query`}
                        type="text"
                        value={newQuery}
                        onChange={(e) => setNewQuery(e.target.value)}
                        placeholder={ANCHOR_TYPE_META[newType].placeholder}
                        maxLength={200}
                        disabled={isGenerating}
                        className="w-full rounded-lg border border-cb-border bg-background px-3.5 py-2.5 text-sm text-foreground placeholder:text-cb-muted focus:border-cb-accent focus:outline-none focus:ring-1 focus:ring-cb-accent"
                      />
                    </div>

                    <div className="sm:w-36">
                      <label
                        htmlFor={`${baseId}-new-anchor-type`}
                        className="sr-only"
                      >
                        Type
                      </label>
                      <select
                        id={`${baseId}-new-anchor-type`}
                        value={newType}
                        onChange={(e) =>
                          setNewType(e.target.value as SupportedAnchorType)
                        }
                        disabled={isGenerating}
                        className="w-full rounded-lg border border-cb-border bg-background px-3 py-2.5 text-sm text-foreground focus:border-cb-accent focus:outline-none focus:ring-1 focus:ring-cb-accent"
                      >
                        {SUPPORTED_ANCHOR_TYPES.map((typeOption) => (
                          <option key={typeOption} value={typeOption}>
                            {ANCHOR_TYPE_META[typeOption].label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <button
                      type="submit"
                      disabled={isGenerating || newQuery.trim().length === 0}
                      className="rounded-lg bg-cb-accent px-4 py-2.5 text-sm font-medium text-cb-accent-fg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Find matches
                    </button>
                  </div>
                </form>
              )}
            </div>
          </section>

          {/* Generate action */}
          <section
            aria-label="Build city guide"
            className="rounded-lg border border-cb-border bg-cb-surface/50 p-5"
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {state.city} guide with {confirmedCount} of{" "}
                  {state.anchors.length} interests confirmed
                </p>
                <p className="text-sm text-cb-muted">
                  {isGenerating
                    ? `Finding places in ${state.city} that match your taste…`
                    : isReady
                      ? "Ready to build your guide."
                      : state.anchors.length === 0
                        ? "Add and confirm at least one interest to get started."
                        : "Find matches and confirm every interest first, or remove ones you don't need."}
                </p>
              </div>

              <button
                type="button"
                onClick={handleGenerateKit}
                disabled={!isReady || isGenerating}
                className="inline-flex shrink-0 items-center justify-center gap-2.5 rounded-lg bg-cb-accent px-6 py-3 text-sm font-semibold text-cb-accent-fg transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isGenerating && (
                  <span
                    className="h-4 w-4 animate-spin rounded-full border-2 border-cb-accent-fg/30 border-t-cb-accent-fg"
                    aria-hidden="true"
                  />
                )}
                {isGenerating
                  ? "Building your guide…"
                  : `Build my ${state.city} guide`}
              </button>
            </div>
          </section>

          {/* Error state */}
          {state.generation.status === "error" && (
            <section
              role="alert"
              aria-label="Generation error"
              className="space-y-4 rounded-lg border border-cb-error/30 bg-cb-error-soft p-5"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-cb-error">
                    Couldn&rsquo;t build your guide
                  </h3>
                  <p className="mt-1 text-sm text-foreground/80">
                    {state.generation.errorMessage ??
                      "An unexpected error occurred."}
                  </p>
                  <p className="mt-1 text-sm text-cb-muted">
                    Your city ({state.city}) and {confirmedCount} confirmed{" "}
                    {confirmedCount === 1 ? "interest" : "interests"} are saved.
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={focusAnchorsEditor}
                    className="rounded-lg border border-cb-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-cb-surface"
                  >
                    Edit interests
                  </button>
                  <button
                    type="button"
                    onClick={handleGenerateKit}
                    disabled={!isReady || isGenerating}
                    className="rounded-lg bg-cb-accent px-4 py-2 text-sm font-medium text-cb-accent-fg hover:opacity-90 disabled:opacity-40"
                  >
                    Try again
                  </button>
                </div>
              </div>

              {state.generation.errorProcess && (
                <AgentTraceDrawer
                  process={state.generation.errorProcess}
                  isOpen={isErrorTraceOpen}
                  onToggle={() => setIsErrorTraceOpen((prev) => !prev)}
                />
              )}
            </section>
          )}
        </div>
        )} {/* end setup view */}

        {/* Results view — shown after successful generation */}
        {view === "results" && state.generation.result && (
          <section
            aria-label="Your city guide"
            className="scroll-mt-4"
          >
            <StarterKitResultsView
              key={`${state.generation.result.city}-${state.generation.result.status}-${state.generation.result.mode}-${state.generation.result.recommendations.map((r) => r.entityId).join(",")}`}
              completion={state.generation.result}
              fallbackCity={state.city}
              confirmedAnchorsSummary={state.anchors
                .filter((a) => a.status === "confirmed" && a.confirmedEntity)
                .map((a) => a.confirmedEntity!.name)}
              onRegenerate={handleGenerateKit}
              onEditAnchors={handleEditInterests}
              isGenerating={isGenerating}
            />
          </section>
        )}
      </main>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────

function StatusDot({ status }: { status: AnchorItem["status"] }) {
  const cls = {
    unsearched: "bg-cb-border",
    searching: "bg-foreground animate-pulse",
    candidates: "bg-cb-warning",
    confirmed: "bg-cb-confirmed",
    no_matches: "bg-cb-warning",
    lookup_error: "bg-cb-error",
  }[status];

  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${cls}`}
      aria-hidden="true"
    />
  );
}

interface AnchorRowProps {
  anchor: AnchorItem;
  disabled: boolean;
  onLookup: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (query: string, type: SupportedAnchorType) => void;
  onRemove: () => void;
  onConfirm: (entityId: string) => void;
  onUnconfirm: () => void;
}

function AnchorRow({
  anchor,
  disabled,
  onLookup,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onRemove,
  onConfirm,
  onUnconfirm,
}: AnchorRowProps) {
  const rowId = useId();
  const [editQuery, setEditQuery] = useState(anchor.query);
  const [editType, setEditType] = useState<SupportedAnchorType>(anchor.type);

  function openEdit() {
    setEditQuery(anchor.query);
    setEditType(anchor.type);
    onStartEdit();
  }

  function handleEditSubmit(e: FormEvent) {
    e.preventDefault();
    onSaveEdit(editQuery, editType);
  }

  if (anchor.isEditing) {
    return (
      <form onSubmit={handleEditSubmit} className="space-y-3 p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-cb-muted">
            Edit interest
          </span>
          <button
            type="button"
            onClick={onCancelEdit}
            className="text-sm text-cb-muted hover:text-foreground"
          >
            Cancel
          </button>
        </div>

        <div className="flex flex-col gap-2.5 sm:flex-row">
          <div className="flex-1">
            <label htmlFor={`${rowId}-query`} className="sr-only">
              Name
            </label>
            <input
              id={`${rowId}-query`}
              type="text"
              value={editQuery}
              onChange={(e) => setEditQuery(e.target.value)}
              maxLength={200}
              disabled={disabled}
              className="w-full rounded-lg border border-cb-border bg-background px-3.5 py-2 text-sm text-foreground focus:border-cb-accent focus:outline-none focus:ring-1 focus:ring-cb-accent"
            />
          </div>

          <div className="sm:w-36">
            <label htmlFor={`${rowId}-type`} className="sr-only">
              Type
            </label>
            <select
              id={`${rowId}-type`}
              value={editType}
              onChange={(e) =>
                setEditType(e.target.value as SupportedAnchorType)
              }
              disabled={disabled}
              className="w-full rounded-lg border border-cb-border bg-background px-3 py-2 text-sm text-foreground focus:border-cb-accent focus:outline-none focus:ring-1 focus:ring-cb-accent"
            >
              {SUPPORTED_ANCHOR_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ANCHOR_TYPE_META[t].label}
                </option>
              ))}
            </select>
          </div>

          <button
            type="submit"
            disabled={disabled || editQuery.trim().length === 0}
            className="rounded-lg bg-cb-accent px-4 py-2 text-sm font-medium text-cb-accent-fg hover:opacity-90 disabled:opacity-40"
          >
            Save and search
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="px-4 py-3.5">
      {/* Main row */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <StatusDot status={anchor.status} />
          <span className="text-sm font-medium">{anchor.query}</span>
          <span className="rounded-md bg-cb-surface px-2 py-0.5 text-xs text-cb-muted">
            {formatAnchorType(anchor.type)}
          </span>
        </div>

        <div className="flex items-center gap-1.5 text-sm">
          {anchor.status === "unsearched" && (
            <button
              type="button"
              disabled={disabled}
              onClick={onLookup}
              className="rounded-lg border border-cb-border px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-cb-surface disabled:opacity-40"
            >
              Find matches
            </button>
          )}
          {anchor.status === "confirmed" && (
            <button
              type="button"
              disabled={disabled}
              onClick={onUnconfirm}
              className="rounded-lg px-2.5 py-1.5 text-cb-muted hover:bg-cb-surface hover:text-foreground disabled:opacity-40"
            >
              Change
            </button>
          )}
          <button
            type="button"
            disabled={disabled || anchor.status === "searching"}
            onClick={openEdit}
            className="rounded-lg px-2.5 py-1.5 text-cb-muted hover:bg-cb-surface hover:text-foreground disabled:opacity-40"
          >
            Edit
          </button>
          <button
            type="button"
            disabled={disabled || anchor.status === "searching"}
            onClick={onRemove}
            aria-label={`Remove ${anchor.query}`}
            className="rounded-lg px-2.5 py-1.5 text-cb-muted hover:bg-cb-error-soft hover:text-cb-error disabled:opacity-40"
          >
            Remove
          </button>
        </div>
      </div>

      {/* Searching state */}
      {anchor.status === "searching" && (
        <div
          role="status"
          aria-live="polite"
          className="mt-2.5 flex items-center gap-2 pl-[18px] text-sm text-cb-muted"
        >
          <span
            className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-cb-border border-t-foreground"
            aria-hidden="true"
          />
          Searching for &ldquo;{anchor.query}&rdquo;…
        </div>
      )}

      {/* Confirmed entity */}
      {anchor.status === "confirmed" && anchor.confirmedEntity && (
        <div className="mt-2.5 ml-[18px] flex items-center gap-2 rounded-lg border border-cb-confirmed/20 bg-cb-confirmed-soft px-3.5 py-2.5 text-sm">
          <svg
            className="h-4 w-4 shrink-0 text-cb-confirmed"
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M8 16A8 8 0 108 0a8 8 0 000 16zm3.78-9.72a.75.75 0 00-1.06-1.06L7 8.94 5.28 7.22a.75.75 0 00-1.06 1.06l2.25 2.25a.75.75 0 001.06 0l4.25-4.25z" />
          </svg>
          <span className="font-medium">
            {anchor.confirmedEntity.name}
          </span>
          {anchor.confirmedEntity.disambiguation &&
            anchor.confirmedEntity.disambiguation.toLowerCase() !==
              anchor.confirmedEntity.name.toLowerCase() && (
            <span className="text-cb-muted">
              ({anchor.confirmedEntity.disambiguation})
            </span>
          )}
        </div>
      )}

      {/* Candidate matches */}
      {anchor.status === "candidates" && anchor.candidates.length > 0 && (
        <div className="mt-3 ml-[18px] space-y-2">
          <p className="text-sm font-medium text-cb-warning">
            {anchor.candidates.length === 1
              ? "We found a match — is this the right one?"
              : `We found ${anchor.candidates.length} possible matches — which one did you mean?`}
          </p>

          <div
            role="group"
            aria-label={`Matches for ${anchor.query}`}
            className="space-y-1.5"
          >
            {anchor.candidates.map((cand) => (
              <div
                key={cand.entityId}
                className="flex flex-col justify-between gap-2 rounded-lg border border-cb-border bg-background p-3 sm:flex-row sm:items-center"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-semibold">{cand.name}</span>
                    {cand.disambiguation &&
                      cand.disambiguation.toLowerCase() !==
                        cand.name.toLowerCase() && (
                      <span className="text-cb-muted">
                        {cand.disambiguation}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-cb-muted">
                    {cand.types.map(formatAnchorType).join(", ")}
                  </p>
                </div>

                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onConfirm(cand.entityId)}
                  className="shrink-0 rounded-lg bg-cb-accent px-4 py-2 text-sm font-medium text-cb-accent-fg transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent disabled:opacity-40"
                >
                  That&rsquo;s the one
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* No matches */}
      {anchor.status === "no_matches" && (
        <div
          role="status"
          className="mt-2.5 ml-[18px] flex flex-col justify-between gap-2 rounded-lg border border-cb-warning/30 bg-cb-warning-soft p-3 text-sm sm:flex-row sm:items-center"
        >
          <p className="text-foreground/80">
            No matches found for &ldquo;{anchor.query}&rdquo; as{" "}
            {formatAnchorType(anchor.type).toLowerCase()}. Try editing the name
            or type.
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={openEdit}
              className="rounded-lg border border-cb-border bg-background px-3 py-1.5 font-medium text-foreground hover:bg-cb-surface"
            >
              Edit
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={onRemove}
              className="rounded-lg border border-cb-error/30 px-3 py-1.5 font-medium text-cb-error hover:bg-cb-error-soft"
            >
              Remove
            </button>
          </div>
        </div>
      )}

      {/* Lookup error */}
      {anchor.status === "lookup_error" && (
        <div
          role="alert"
          className="mt-2.5 ml-[18px] flex flex-col justify-between gap-2 rounded-lg border border-cb-error/30 bg-cb-error-soft p-3 text-sm sm:flex-row sm:items-center"
        >
          <p className="text-foreground/80">
            {anchor.errorMessage ?? "Search failed. You can retry or edit this interest."}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={onLookup}
              className="rounded-lg border border-cb-border bg-background px-3 py-1.5 font-medium text-foreground hover:bg-cb-surface"
            >
              Retry
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={openEdit}
              className="rounded-lg border border-cb-border bg-background px-3 py-1.5 font-medium text-foreground hover:bg-cb-surface"
            >
              Edit
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={onRemove}
              className="rounded-lg border border-cb-error/30 px-3 py-1.5 font-medium text-cb-error hover:bg-cb-error-soft"
            >
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Results View ─────────────────────────────────────────────

interface StarterKitResultsViewProps {
  completion: SafeKitCompletion;
  fallbackCity: string;
  confirmedAnchorsSummary: string[];
  onRegenerate: () => void;
  onEditAnchors: () => void;
  isGenerating: boolean;
}

function StarterKitResultsView({
  completion,
  fallbackCity,
  confirmedAnchorsSummary,
  onRegenerate,
  onEditAnchors,
  isGenerating,
}: StarterKitResultsViewProps) {
  const displayCity = completion.city || fallbackCity;

  const groups = useMemo(
    () => groupRecommendationsByCategory(completion.recommendations),
    [completion.recommendations],
  );
  const markers = useMemo(
    () => extractMapMarkers(completion.recommendations),
    [completion.recommendations],
  );
  const markerOrderById = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of markers) {
      map.set(m.entityId, m.orderIndex);
    }
    return map;
  }, [markers]);

  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [activeCategoryFilter, setActiveCategoryFilter] =
    useState<string>("__all__");
  const [isTraceOpen, setIsTraceOpen] = useState<boolean>(
    () => completion.status !== "success" || completion.mode === "deterministic",
  );

  // Flat list of visible recommendations, respecting the active category filter
  const visibleItems = useMemo(() => {
    if (activeCategoryFilter === "__all__") return completion.recommendations;
    const activeGroup = groups.find((g) => g.key === activeCategoryFilter);
    return activeGroup ? activeGroup.items : [];
  }, [completion.recommendations, groups, activeCategoryFilter]);

  const effectiveSelectedId =
    selectedEntityId &&
    completion.recommendations.some((r) => r.entityId === selectedEntityId)
      ? selectedEntityId
      : null;

  const selection = useMemo(
    () =>
      resolveSelectionState(completion.recommendations, effectiveSelectedId),
    [completion.recommendations, effectiveSelectedId],
  );

  function handleSelectFromMap(entityId: string) {
    setSelectedEntityId(entityId);
    if (activeCategoryFilter !== "__all__") {
      const activeGroup = groups.find((g) => g.key === activeCategoryFilter);
      const inCurrentFilter =
        activeGroup?.items.some((i) => i.entityId === entityId) ?? false;
      if (!inCurrentFilter) {
        setActiveCategoryFilter("__all__");
      }
    }
  }

  function handleJumpToCard(entityId: string) {
    handleSelectFromMap(entityId);
    requestAnimationFrame(() => {
      const el = document.getElementById(`rec-card-${entityId}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "nearest" });
        el.focus({ preventScroll: true });
      }
    });
  }

  const statusPresentation = getKitStatusPresentation(completion.status);

  return (
    <div className="space-y-8">
      {/* Results header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Your {displayCity} guide
            </h2>
            <span
              className={`rounded-md px-2.5 py-1 text-xs font-medium ${statusPresentation.badgeClassName}`}
            >
              {statusPresentation.badgeText}
            </span>
          </div>
          <p className="text-sm text-cb-muted">
            {completion.recommendations.length > 0 ? (
              <>
                {completion.recommendations.length}{" "}
                {completion.recommendations.length === 1 ? "place" : "places"}{" "}
                found in {displayCity}
                {confirmedAnchorsSummary.length > 0 && (
                  <> based on {confirmedAnchorsSummary.join(", ")}</>
                )}
              </>
            ) : (
              completion.summary
            )}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onEditAnchors}
            disabled={isGenerating}
            className="rounded-lg border border-cb-border px-3.5 py-2 text-sm font-medium text-foreground hover:bg-cb-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent disabled:opacity-40"
          >
            Edit interests
          </button>
          <button
            type="button"
            onClick={() => setIsTraceOpen((prev) => !prev)}
            aria-expanded={isTraceOpen}
            className="rounded-lg border border-cb-border px-3.5 py-2 text-sm font-medium text-foreground hover:bg-cb-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent"
          >
            {isTraceOpen ? "Hide details" : "How it works"}
          </button>
        </div>
      </div>

      {/* Fallback/partial notices */}
      {(completion.status === "partial" ||
        completion.mode === "deterministic") && (
        <div className="rounded-lg border border-cb-border bg-cb-surface/50 px-4 py-3 text-sm text-cb-muted">
          {completion.status === "partial" && (
            <p>
              <strong className="text-foreground">Partial results:</strong>{" "}
              {completion.filteredInvalidCount > 0
                ? `${completion.filteredInvalidCount} candidate${
                    completion.filteredInvalidCount === 1 ? " was" : "s were"
                  } excluded because ${
                    completion.filteredInvalidCount === 1 ? "it" : "they"
                  } didn't pass quality checks.`
                : "Only recommendations that passed every quality check are shown."}{" "}
              CultureBridge never pads results.
            </p>
          )}
          {completion.mode === "deterministic" && (
            <p>
              <strong className="text-foreground">How these were found:</strong>{" "}
              {completion.searchProcess.fallbackReason ??
                "Results were generated directly from taste data without AI synthesis."}
            </p>
          )}
        </div>
      )}

      {/* Evidence label key — compact inline */}
      {completion.recommendations.length > 0 && (
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-cb-muted">
          {(["connection", "useful-place", "exploratory"] as const).map(
            (labelKey) => {
              const info = LABEL_PRESENTATION[labelKey];
              const count = completion.recommendations.filter(
                (r) => r.label === labelKey,
              ).length;
              if (count === 0) return null;
              const hasMultipleLabelTypes =
                count < completion.recommendations.length;
              return (
                <span key={labelKey} className="flex items-center gap-1.5">
                  <span
                    className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${info.badgeClassName}`}
                  >
                    <span aria-hidden="true">{info.symbol}</span>
                    {info.badgeText}
                  </span>
                  <span>
                    {info.shortTitle}
                    {hasMultipleLabelTypes ? ` (${count})` : ""}
                  </span>
                </span>
              );
            },
          )}
        </div>
      )}

      {/* Agent trace drawer */}
      <AgentTraceDrawer
        process={completion.searchProcess}
        isOpen={isTraceOpen}
        onToggle={() => setIsTraceOpen((prev) => !prev)}
      />

      {/* Empty vs populated results */}
      {completion.recommendations.length === 0 ? (
        <div className="rounded-lg border border-cb-border bg-cb-surface/50 p-8">
          <h3 className="text-lg font-semibold">
            No places matched your interests
          </h3>
          <p className="mt-2 max-w-lg text-sm text-cb-muted leading-relaxed">
            CultureBridge never shows unverified or low-quality matches. You can
            check the search details above to see what was tried, or adjust your
            interests.
          </p>
          <div className="mt-5 flex flex-wrap gap-2.5">
            <button
              type="button"
              onClick={onEditAnchors}
              disabled={isGenerating}
              className="rounded-lg bg-cb-accent px-4 py-2.5 text-sm font-medium text-cb-accent-fg hover:opacity-90 disabled:opacity-40"
            >
              Edit interests
            </button>
            <button
              type="button"
              disabled={isGenerating}
              onClick={onRegenerate}
              className="rounded-lg border border-cb-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-cb-surface disabled:opacity-40"
            >
              Try again
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12 lg:items-start">
          {/* Map — above list on mobile, sticky right column on desktop */}
          <div className="order-1 lg:order-2 lg:col-span-5 lg:sticky lg:top-16">
            <ResultsMap
              city={displayCity}
              recommendations={completion.recommendations}
              selectedEntityId={selection.selectedEntityId}
              onSelectEntity={handleSelectFromMap}
              onJumpToCard={handleJumpToCard}
            />
          </div>

          {/* Recommendation list */}
          <div className="order-2 space-y-6 lg:order-1 lg:col-span-7">
            {/* Category filter tabs */}
            {groups.length > 1 && (
              <nav
                aria-label="Filter by category"
                className="flex flex-wrap gap-1.5"
              >
                <button
                  type="button"
                  aria-pressed={activeCategoryFilter === "__all__"}
                  onClick={() => setActiveCategoryFilter("__all__")}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent ${
                    activeCategoryFilter === "__all__"
                      ? "bg-cb-accent text-cb-accent-fg"
                      : "bg-cb-surface text-foreground hover:bg-cb-border"
                  }`}
                >
                  All ({completion.recommendations.length})
                </button>
                {groups.map((group) => {
                  const active = activeCategoryFilter === group.key;
                  return (
                    <button
                      key={group.key}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setActiveCategoryFilter(group.key)}
                      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent ${
                        active
                          ? "bg-cb-accent text-cb-accent-fg"
                          : "bg-cb-surface text-foreground hover:bg-cb-border"
                      }`}
                    >
                      {group.title} ({group.items.length})
                    </button>
                  );
                })}
              </nav>
            )}

            {/* Unified flat recommendation list */}
            <div className="divide-y divide-cb-border rounded-lg border border-cb-border">
              {visibleItems.map((rec) => (
                <RecommendationCard
                  key={rec.entityId}
                  rec={rec}
                  pinOrderIndex={
                    markerOrderById.get(rec.entityId) ?? null
                  }
                  isSelected={
                    selection.selectedEntityId === rec.entityId
                  }
                  onSelect={() => setSelectedEntityId(rec.entityId)}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Recommendation Card ──────────────────────────────────────

interface RecommendationCardProps {
  rec: SafeRecommendationItem;
  pinOrderIndex: number | null;
  isSelected: boolean;
  onSelect: () => void;
}

function RecommendationCard({
  rec,
  pinOrderIndex,
  isSelected,
  onSelect,
}: RecommendationCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const labelInfo = getLabelPresentation(rec.label);
  const categoryInfo = useMemo(() => describeCategoryEvidence(rec), [rec]);
  const provenance = useMemo(() => formatRecommendationProvenance(rec), [rec]);
  const practical = useMemo(() => buildPracticalDetailsView(rec), [rec]);

  return (
    <article
      id={`rec-card-${rec.entityId}`}
      tabIndex={-1}
      aria-label={`${rec.name} — ${labelInfo.badgeText}`}
      className={`px-4 py-4 transition-colors focus:outline-none ${
        isSelected ? "bg-cb-accent-soft" : "hover:bg-cb-surface/50"
      }`}
    >
      {/* Header row */}
      <div className="flex items-start gap-3">
        {/* Pin badge */}
        {practical.mappable && pinOrderIndex !== null ? (
          <button
            type="button"
            onClick={onSelect}
            title="Show on map"
            className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
              isSelected
                ? "bg-cb-accent text-cb-accent-fg"
                : "border border-cb-border bg-background text-foreground hover:border-cb-accent hover:text-cb-accent"
            }`}
          >
            {pinOrderIndex}
          </button>
        ) : (
          <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-dashed border-cb-border text-xs text-cb-muted">
            —
          </span>
        )}

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-base font-semibold tracking-tight">
              {rec.name}
            </h4>
            <span
              className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${labelInfo.badgeClassName}`}
            >
              <span aria-hidden="true">{labelInfo.symbol}</span>
              {labelInfo.badgeText}
            </span>
          </div>

          {/* Category + location */}
          <p className="mt-0.5 text-sm text-cb-muted">
            {[
              categoryInfo.qlooCategories[0],
              practical.locationLine,
            ]
              .filter(Boolean)
              .join(" · ") || "Location not available"}
          </p>

          {/* Explanation */}
          <p className="mt-2 text-sm leading-relaxed text-foreground/90">
            {rec.explanationText}
          </p>

          {/* Action row */}
          <div className="mt-2.5 flex items-center gap-3">
            <button
              type="button"
              onClick={() => setIsExpanded(!isExpanded)}
              className="text-sm font-medium text-cb-accent hover:underline"
            >
              {isExpanded ? "Less" : "Details"}
            </button>
            {practical.mappable && (
              <button
                type="button"
                onClick={onSelect}
                className={`text-sm font-medium ${
                  isSelected
                    ? "text-cb-accent"
                    : "text-cb-muted hover:text-cb-accent"
                }`}
              >
                {isSelected ? "Shown on map" : "Show on map"}
              </button>
            )}
          </div>

          {/* Expanded details */}
          {isExpanded && (
            <div className="mt-4 space-y-4 border-t border-cb-border pt-4 text-sm">
              {/* Practical details */}
              {practical.hasAnyPracticalDetail && (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {practical.locationLine && (
                    <div>
                      <dt className="text-xs font-medium text-cb-muted">
                        Location
                      </dt>
                      <dd className="mt-0.5">{practical.locationLine}</dd>
                    </div>
                  )}
                  {practical.websiteUrl && practical.websiteDisplay && (
                    <div>
                      <dt className="text-xs font-medium text-cb-muted">
                        Website
                      </dt>
                      <dd className="mt-0.5">
                        <a
                          href={practical.websiteUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-cb-accent underline underline-offset-2 hover:opacity-80"
                        >
                          {practical.websiteDisplay}
                        </a>
                      </dd>
                    </div>
                  )}
                  {practical.phone && (
                    <div>
                      <dt className="text-xs font-medium text-cb-muted">
                        Phone
                      </dt>
                      <dd className="mt-0.5">{practical.phone}</dd>
                    </div>
                  )}
                  {practical.priceTier && (
                    <div>
                      <dt className="text-xs font-medium text-cb-muted">
                        Price
                      </dt>
                      <dd className="mt-0.5">{practical.priceTier}</dd>
                    </div>
                  )}
                </div>
              )}

              {/* Categories */}
              {categoryInfo.qlooCategories.length > 0 && (
                <div>
                  <span className="text-xs font-medium text-cb-muted">
                    {categoryInfo.qlooCategoryLabel}:
                  </span>{" "}
                  <span className="text-sm">
                    {categoryInfo.qlooCategories.join(", ")}
                  </span>
                </div>
              )}

              {/* Tags */}
              {practical.supportingTags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {practical.supportingTags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-md bg-cb-surface px-2 py-0.5 text-xs text-cb-muted"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              {/* Provenance — why this was suggested */}
              <div className="rounded-lg border border-cb-border bg-cb-surface/50 p-3">
                <p className="text-xs font-medium text-cb-muted">
                  Why this was suggested
                </p>
                <p className="mt-1 text-sm font-medium">
                  {provenance.headline}
                </p>
                <p className="mt-0.5 text-sm text-cb-muted">
                  {provenance.detail}
                </p>
                {provenance.honestyDisclaimer && (
                  <p className="mt-1.5 text-xs text-cb-muted">
                    {provenance.honestyDisclaimer}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
