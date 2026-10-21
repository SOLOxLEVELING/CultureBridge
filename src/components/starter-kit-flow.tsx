"use client";

import dynamic from "next/dynamic";
import { useId, useMemo, useRef, useState } from "react";
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
  getPresetById,
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
      className="flex h-60 w-full items-center justify-center rounded-lg border border-foreground/15 bg-foreground/[0.02] p-6 text-xs text-foreground/60 sm:h-72 lg:h-80"
    >
      Loading OpenStreetMap view…
    </div>
  ),
});

const FLOW_PHASE_LABELS: Record<
  FlowPhase,
  { badge: string; instruction: string }
> = {
  initial_profile: {
    badge: "Profile selected",
    instruction:
      "Search Qloo for your profile's anchors and confirm each entity before generating.",
  },
  editing_anchors: {
    badge: "Editing anchors",
    instruction:
      "Add up to five cultural anchors, then search and confirm each match in Qloo.",
  },
  searching_matches: {
    badge: "Searching Qloo",
    instruction: "Looking up candidate entities in Qloo's taste graph…",
  },
  waiting_for_confirmation: {
    badge: "Confirmation needed",
    instruction:
      "Select the exact Qloo entity for each anchor below. Matches are never auto-confirmed.",
  },
  lookup_failure: {
    badge: "Action needed",
    instruction:
      "One or more anchors could not be resolved. Edit the query, retry, or remove the anchor to continue.",
  },
  ready_to_generate: {
    badge: "Ready to generate",
    instruction:
      "All active anchors are confirmed. Generate your Cultural Starter Kit when ready.",
  },
  generating: {
    badge: "Generating kit",
    instruction:
      "Verifying anchors and discovering places grounded in your cultural profile…",
  },
  success: {
    badge: "Starter Kit ready",
    instruction:
      "Review your recommendations, map pins, and search process below, or edit your anchors to revise the kit.",
  },
  empty_recommendations: {
    badge: "No matches found",
    instruction:
      "No places met the deterministic screening criteria for this combination. Try adjusting your anchors or destination.",
  },
  generation_error: {
    badge: "Generation failed",
    instruction:
      "Your profile, destination city, and confirmed anchors are preserved. Retry whenever you are ready.",
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

  // Synchronous lock to prevent accidental duplicate /api/kit submissions
  const kitSubmittingRef = useRef<boolean>(false);
  const stateRef = useRef<FlowState>(state);
  stateRef.current = state;

  const anchorsSectionRef = useRef<HTMLElement | null>(null);
  const resultsSectionRef = useRef<HTMLElement | null>(null);

  const baseId = useId();
  const phase = deriveFlowPhase(state);
  const phaseMeta = FLOW_PHASE_LABELS[phase];
  const currentPreset = getPresetById(state.selectedPresetId);
  const isGenerating = state.generation.status === "loading";

  const confirmedCount = state.anchors.filter(
    (a) => a.status === "confirmed" && a.confirmedEntity !== null,
  ).length;
  const unsearchedAnchors = state.anchors.filter(
    (a) => a.status === "unsearched",
  );
  const isReady = canGenerateKit(state);

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
        "Confirm or remove all pending anchors before generating your starter kit.",
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
      {/* Persistent Top Workspace Bar */}
      <header className="sticky top-0 z-20 border-b border-foreground/10 bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-6">
          <div className="flex items-center gap-3">
            <h1 className="text-base font-semibold tracking-tight">
              CultureBridge
            </h1>
            <span
              className="hidden h-3.5 w-px bg-foreground/15 sm:inline-block"
              aria-hidden="true"
            />
            <span className="hidden text-xs text-foreground/60 sm:inline">
              Cultural Starter Kit
            </span>
          </div>

          <div className="flex items-center gap-2.5 text-xs">
            <span className="rounded border border-foreground/15 bg-foreground/[0.03] px-2 py-1 font-mono text-foreground/80">
              Destination:{" "}
              <strong className="font-semibold">{state.city}</strong>
            </span>
            <span
              role="status"
              aria-live="polite"
              className="rounded border border-foreground/10 px-2 py-1 font-mono text-foreground/65"
            >
              {confirmedCount}/{state.anchors.length} confirmed
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-4 py-6 sm:px-6 sm:py-10">
        {/* Input Workspace Container */}
        <div className="mx-auto max-w-3xl space-y-8">
          {/* Intro & Live Workflow Status Banner */}
          <section aria-label="Workflow overview" className="space-y-3">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
              <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
                Discover places in {state.city} through what you already know
              </h2>
              <span className="inline-flex w-fit items-center gap-1.5 rounded border border-foreground/15 px-2 py-0.5 font-mono text-xs text-foreground/70">
                <PhaseIndicatorDot phase={phase} />
                {phaseMeta.badge}
              </span>
            </div>
            <p className="text-sm text-foreground/65" aria-live="polite">
              {phaseMeta.instruction}
            </p>
          </section>

          {/* Step 1: Destination City Selector */}
          <section
            aria-labelledby={`${baseId}-city-heading`}
            className="space-y-3"
          >
            <div className="flex items-baseline justify-between">
              <h3
                id={`${baseId}-city-heading`}
                className="text-sm font-medium text-foreground"
              >
                1. Destination city
              </h3>
              <span className="text-xs text-foreground/50">
                Tested Qloo locality coverage
              </span>
            </div>

            <div
              role="group"
              aria-labelledby={`${baseId}-city-heading`}
              className="grid grid-cols-1 gap-2.5 sm:grid-cols-2"
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
                    className={`flex flex-col items-start rounded-lg border p-3.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:cursor-not-allowed disabled:opacity-50 ${
                      selected
                        ? "border-foreground bg-foreground/[0.04]"
                        : "border-foreground/12 hover:border-foreground/30 hover:bg-foreground/[0.015]"
                    }`}
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <span className="text-sm font-semibold">
                        {meta.name}{" "}
                        <span className="font-normal text-foreground/50">
                          · {meta.country}
                        </span>
                      </span>
                      <span
                        className={`h-2 w-2 rounded-full ${
                          selected
                            ? "bg-foreground"
                            : "border border-foreground/30"
                        }`}
                        aria-hidden="true"
                      />
                    </div>
                    <p className="mt-1 text-xs text-foreground/60">
                      {meta.note}
                    </p>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Step 2: Persona Preset Selector */}
          <section
            aria-labelledby={`${baseId}-persona-heading`}
            className="space-y-3"
          >
            <div className="flex items-baseline justify-between">
              <h3
                id={`${baseId}-persona-heading`}
                className="text-sm font-medium text-foreground"
              >
                2. Starting taste profile
              </h3>
              <span className="text-xs text-foreground/50">
                Select a preset or build a custom list
              </span>
            </div>

            <div
              role="group"
              aria-labelledby={`${baseId}-persona-heading`}
              className="grid grid-cols-1 gap-2 sm:grid-cols-2"
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
                    className={`flex flex-col items-start rounded-lg border p-3.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:cursor-not-allowed disabled:opacity-50 ${
                      selected
                        ? "border-foreground bg-foreground/[0.04]"
                        : "border-foreground/12 hover:border-foreground/30 hover:bg-foreground/[0.015]"
                    }`}
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <span className="text-sm font-semibold">
                        {preset.name}
                      </span>
                      {preset.anchors.length > 0 ? (
                        <span className="font-mono text-xs text-foreground/50">
                          {preset.anchors.length} anchors
                        </span>
                      ) : (
                        <span className="font-mono text-xs text-foreground/50">
                          Blank
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-foreground/60">
                      {preset.description}
                    </p>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Step 3: Cultural Anchors & Explicit Qloo Entity Confirmation */}
          <section
            ref={anchorsSectionRef}
            aria-labelledby={`${baseId}-anchors-heading`}
            className="scroll-mt-20 space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3
                  id={`${baseId}-anchors-heading`}
                  className="text-sm font-medium text-foreground"
                >
                  3. Cultural anchors &amp; Qloo entity confirmation
                </h3>
                <p className="mt-0.5 text-xs text-foreground/60">
                  Up to {MAX_TRUSTED_ANCHORS} anchors. Every anchor is searched
                  against Qloo and requires your explicit confirmation.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {unsearchedAnchors.length > 0 && (
                  <button
                    type="button"
                    disabled={isGenerating}
                    onClick={lookupAllUnsearched}
                    className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Search Qloo for{" "}
                    {unsearchedAnchors.length === 1
                      ? "1 unsearched anchor"
                      : `all ${unsearchedAnchors.length} anchors`}
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
                      className="rounded-md border border-foreground/20 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-foreground/[0.04] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      + Add anchor ({state.anchors.length}/{MAX_TRUSTED_ANCHORS}
                      )
                    </button>
                  )}
              </div>
            </div>

            {formError && (
              <div
                role="alert"
                className="rounded-md border border-red-500/30 bg-red-500/5 px-3.5 py-2.5 text-xs text-red-700 dark:text-red-300"
              >
                {formError}
              </div>
            )}

            {/* Anchor Rows */}
            <div className="divide-y divide-foreground/10 rounded-lg border border-foreground/15">
              {state.anchors.length === 0 && !isAddRowOpen && (
                <div className="p-6 text-center">
                  <p className="text-sm font-medium text-foreground/80">
                    No cultural anchors in {currentPreset.name}
                  </p>
                  <p className="mt-1 text-xs text-foreground/55">
                    Add at least one artist, TV show, movie, brand, or person to
                    discover connected places in {state.city}.
                  </p>
                  <button
                    type="button"
                    disabled={isGenerating}
                    onClick={() => setIsAddRowOpen(true)}
                    className="mt-3 rounded-md bg-foreground px-3.5 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90"
                  >
                    Add your first anchor
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

              {/* Inline Add Anchor Form */}
              {isAddRowOpen && state.anchors.length < MAX_TRUSTED_ANCHORS && (
                <form
                  onSubmit={handleAddAnchorSubmit}
                  className="bg-foreground/[0.015] p-4"
                >
                  <div className="mb-2.5 flex items-center justify-between">
                    <span className="text-xs font-medium text-foreground/80">
                      Add cultural anchor ({state.anchors.length + 1} of{" "}
                      {MAX_TRUSTED_ANCHORS})
                    </span>
                    {state.anchors.length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          setIsAddRowOpen(false);
                          setFormError(null);
                        }}
                        className="text-xs text-foreground/50 hover:text-foreground/80"
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
                        Anchor name
                      </label>
                      <input
                        id={`${baseId}-new-anchor-query`}
                        type="text"
                        value={newQuery}
                        onChange={(e) => setNewQuery(e.target.value)}
                        placeholder={ANCHOR_TYPE_META[newType].placeholder}
                        maxLength={200}
                        disabled={isGenerating}
                        className="w-full rounded-md border border-foreground/20 bg-background px-3 py-2 text-sm text-foreground placeholder:text-foreground/40 focus:border-foreground focus:outline-none"
                      />
                    </div>

                    <div className="sm:w-40">
                      <label
                        htmlFor={`${baseId}-new-anchor-type`}
                        className="sr-only"
                      >
                        Entity type
                      </label>
                      <select
                        id={`${baseId}-new-anchor-type`}
                        value={newType}
                        onChange={(e) =>
                          setNewType(e.target.value as SupportedAnchorType)
                        }
                        disabled={isGenerating}
                        className="w-full rounded-md border border-foreground/20 bg-background px-3 py-2 text-sm text-foreground focus:border-foreground focus:outline-none"
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
                      className="rounded-md bg-foreground px-4 py-2 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Search Qloo
                    </button>
                  </div>
                </form>
              )}
            </div>
          </section>

          {/* Step 4: Generate Starter Kit Action Panel */}
          <section
            aria-label="Generate Cultural Starter Kit"
            className="rounded-lg border border-foreground/15 bg-foreground/[0.02] p-4 sm:p-5"
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span>Destination: {state.city}</span>
                  <span className="text-foreground/30">·</span>
                  <span className="font-mono text-xs text-foreground/70">
                    {confirmedCount} of {state.anchors.length} confirmed
                  </span>
                </div>
                <p className="text-xs text-foreground/60">
                  {isGenerating
                    ? `Querying Qloo and verifying recommendations for ${state.city}…`
                    : isReady
                      ? `Ready to generate your ${state.city} Cultural Starter Kit with ${confirmedCount} confirmed ${confirmedCount === 1 ? "anchor" : "anchors"}.`
                      : state.anchors.length === 0
                        ? "Add and confirm at least one cultural anchor to enable generation."
                        : "Search and explicitly confirm every anchor in your list (or remove unconfirmed ones) before generating."}
                </p>
              </div>

              <button
                type="button"
                onClick={handleGenerateKit}
                disabled={!isReady || isGenerating}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isGenerating && (
                  <span
                    className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-background/30 border-t-background"
                    aria-hidden="true"
                  />
                )}
                {isGenerating
                  ? `Generating for ${state.city}…`
                  : `Generate ${state.city} Starter Kit`}
              </button>
            </div>
          </section>

          {/* Generation Error State — never retains stale results */}
          {state.generation.status === "error" && (
            <section
              role="alert"
              aria-label="Starter kit generation error"
              className="space-y-4 rounded-lg border border-red-500/30 bg-red-500/5 p-5"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-red-700 dark:text-red-300">
                    Starter Kit generation could not complete
                  </h3>
                  <p className="mt-1 text-xs text-foreground/75">
                    {state.generation.errorMessage ??
                      "An unexpected error occurred while generating your kit."}
                  </p>
                  <p className="mt-1 text-xs text-foreground/55">
                    Your selected destination ({state.city}) and{" "}
                    {confirmedCount} confirmed{" "}
                    {confirmedCount === 1 ? "anchor" : "anchors"} are preserved.
                    No stale or unverified results are shown.
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={focusAnchorsEditor}
                    className="rounded-md border border-foreground/20 bg-background px-3.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-foreground/[0.04]"
                  >
                    Edit anchors
                  </button>
                  <button
                    type="button"
                    onClick={handleGenerateKit}
                    disabled={!isReady || isGenerating}
                    className="rounded-md bg-foreground px-4 py-2 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-40"
                  >
                    Retry generation
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

        {/* Full Cultural Starter Kit Results, Map, and Agent Trace */}
        {state.generation.result && (
          <section
            ref={resultsSectionRef}
            aria-label="Cultural Starter Kit results"
            className="scroll-mt-20 border-t border-foreground/15 pt-8"
          >
            <StarterKitResultsView
              key={`${state.generation.result.city}-${state.generation.result.status}-${state.generation.result.mode}-${state.generation.result.recommendations.map((r) => r.entityId).join(",")}`}
              completion={state.generation.result}
              fallbackCity={state.city}
              confirmedAnchorsSummary={state.anchors
                .filter((a) => a.status === "confirmed" && a.confirmedEntity)
                .map((a) => a.confirmedEntity!.name)}
              onRegenerate={handleGenerateKit}
              onEditAnchors={focusAnchorsEditor}
              isGenerating={isGenerating}
            />
          </section>
        )}
      </main>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────

function PhaseIndicatorDot({ phase }: { phase: FlowPhase }) {
  const colorClass =
    phase === "ready_to_generate" || phase === "success"
      ? "bg-emerald-500"
      : phase === "lookup_failure" || phase === "generation_error"
        ? "bg-red-500"
        : phase === "waiting_for_confirmation" ||
            phase === "empty_recommendations"
          ? "bg-amber-500"
          : phase === "searching_matches" || phase === "generating"
            ? "bg-foreground animate-pulse"
            : "bg-foreground/40";

  return (
    <span
      className={`inline-block h-1.5 w-1.5 rounded-full ${colorClass}`}
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
          <span className="text-xs font-medium text-foreground/70">
            Edit cultural anchor
          </span>
          <button
            type="button"
            onClick={onCancelEdit}
            className="text-xs text-foreground/50 hover:text-foreground/80"
          >
            Cancel
          </button>
        </div>

        <div className="flex flex-col gap-2.5 sm:flex-row">
          <div className="flex-1">
            <label htmlFor={`${rowId}-query`} className="sr-only">
              Anchor query
            </label>
            <input
              id={`${rowId}-query`}
              type="text"
              value={editQuery}
              onChange={(e) => setEditQuery(e.target.value)}
              maxLength={200}
              disabled={disabled}
              className="w-full rounded-md border border-foreground/20 bg-background px-3 py-1.5 text-sm text-foreground focus:border-foreground focus:outline-none"
            />
          </div>

          <div className="sm:w-40">
            <label htmlFor={`${rowId}-type`} className="sr-only">
              Entity type
            </label>
            <select
              id={`${rowId}-type`}
              value={editType}
              onChange={(e) =>
                setEditType(e.target.value as SupportedAnchorType)
              }
              disabled={disabled}
              className="w-full rounded-md border border-foreground/20 bg-background px-3 py-1.5 text-sm text-foreground focus:border-foreground focus:outline-none"
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
            className="rounded-md bg-foreground px-3.5 py-1.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-40"
          >
            Save &amp; search
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <AnchorStatusDot status={anchor.status} />
          <span className="text-sm font-medium">{anchor.query}</span>
          <span className="rounded border border-foreground/15 px-1.5 py-0.5 font-mono text-[11px] text-foreground/60">
            {formatAnchorType(anchor.type)}
          </span>
        </div>

        <div className="flex items-center gap-2 text-xs">
          {anchor.status === "unsearched" && (
            <button
              type="button"
              disabled={disabled}
              onClick={onLookup}
              className="rounded border border-foreground/25 bg-foreground/[0.04] px-2.5 py-1 font-medium text-foreground transition-colors hover:bg-foreground/10 disabled:opacity-40"
            >
              Find match
            </button>
          )}
          {anchor.status === "confirmed" && (
            <button
              type="button"
              disabled={disabled}
              onClick={onUnconfirm}
              className="rounded border border-foreground/15 px-2.5 py-1 text-foreground/70 transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-40"
            >
              Change
            </button>
          )}
          <button
            type="button"
            disabled={disabled || anchor.status === "searching"}
            onClick={openEdit}
            className="rounded px-2 py-1 text-foreground/55 transition-colors hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-40"
          >
            Edit
          </button>
          <button
            type="button"
            disabled={disabled || anchor.status === "searching"}
            onClick={onRemove}
            aria-label={`Remove ${anchor.query}`}
            className="rounded px-2 py-1 text-foreground/55 transition-colors hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40"
          >
            Remove
          </button>
        </div>
      </div>

      {anchor.status === "unsearched" && (
        <p className="mt-1.5 pl-4 text-xs text-foreground/50">
          Not yet searched in Qloo. Click <strong>Find match</strong> to look up
          candidate entities.
        </p>
      )}

      {anchor.status === "searching" && (
        <div
          role="status"
          aria-live="polite"
          className="mt-2 flex items-center gap-2 pl-4 text-xs text-foreground/60"
        >
          <span
            className="h-3 w-3 animate-spin rounded-full border-2 border-foreground/20 border-t-foreground"
            aria-hidden="true"
          />
          Searching Qloo for &ldquo;{anchor.query}&rdquo; (
          {formatAnchorType(anchor.type)})…
        </div>
      )}

      {anchor.status === "confirmed" && anchor.confirmedEntity && (
        <div className="mt-2 ml-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-500/25 bg-emerald-500/[0.06] px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-emerald-800 dark:text-emerald-300">
              Confirmed:
            </span>
            <span className="font-semibold text-foreground">
              {anchor.confirmedEntity.name}
            </span>
            {anchor.confirmedEntity.disambiguation && (
              <span className="text-foreground/65">
                ({anchor.confirmedEntity.disambiguation})
              </span>
            )}
            <span className="font-mono text-[11px] text-foreground/50">
              [{anchor.confirmedEntity.types.map(formatAnchorType).join(", ")}]
            </span>
          </div>
          <span className="font-mono text-[11px] text-foreground/45">
            ID: {anchor.confirmedEntity.entityId.slice(0, 8)}…
          </span>
        </div>
      )}

      {anchor.status === "candidates" && anchor.candidates.length > 0 && (
        <div className="mt-3 ml-4 space-y-2">
          <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
            {anchor.candidates.length === 1
              ? "1 matching Qloo entity found — confirm to include in your profile:"
              : `${anchor.candidates.length} matching Qloo entities found — select the exact one you mean:`}
          </p>

          <div
            role="group"
            aria-label={`Candidate matches for ${anchor.query}`}
            className="space-y-1.5"
          >
            {anchor.candidates.map((cand) => (
              <div
                key={cand.entityId}
                className="flex flex-col justify-between gap-2 rounded-md border border-foreground/15 bg-foreground/[0.02] p-2.5 sm:flex-row sm:items-center"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="font-semibold text-foreground">
                      {cand.name}
                    </span>
                    {cand.disambiguation && (
                      <span className="rounded bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-foreground/75">
                        {cand.disambiguation}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-foreground/50">
                    <span>
                      Types: {cand.types.map(formatAnchorType).join(", ")}
                    </span>
                    <span>·</span>
                    <span>Qloo ID: {cand.entityId.slice(0, 12)}…</span>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onConfirm(cand.entityId)}
                  className="shrink-0 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:opacity-40"
                >
                  Confirm entity
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {anchor.status === "no_matches" && (
        <div
          role="status"
          className="mt-2.5 ml-4 flex flex-col justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs sm:flex-row sm:items-center"
        >
          <p className="text-foreground/75">
            No Qloo entity of type{" "}
            <strong className="font-medium">
              {formatAnchorType(anchor.type)}
            </strong>{" "}
            matched &ldquo;{anchor.query}&rdquo;. Edit the name/type or remove
            this anchor to continue.
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={openEdit}
              className="rounded border border-foreground/20 bg-background px-2.5 py-1 font-medium text-foreground hover:bg-foreground/[0.04]"
            >
              Edit anchor
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={onRemove}
              className="rounded border border-red-500/30 px-2.5 py-1 font-medium text-red-700 dark:text-red-300 hover:bg-red-500/10"
            >
              Remove
            </button>
          </div>
        </div>
      )}

      {anchor.status === "lookup_error" && (
        <div
          role="alert"
          className="mt-2.5 ml-4 flex flex-col justify-between gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-xs sm:flex-row sm:items-center"
        >
          <p className="text-foreground/75">
            {anchor.errorMessage ??
              "Lookup failed for this anchor. You can retry, edit, or remove it."}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={onLookup}
              className="rounded border border-foreground/20 bg-background px-2.5 py-1 font-medium text-foreground hover:bg-foreground/[0.04]"
            >
              Retry lookup
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={openEdit}
              className="rounded border border-foreground/20 bg-background px-2.5 py-1 font-medium text-foreground hover:bg-foreground/[0.04]"
            >
              Edit anchor
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={onRemove}
              className="rounded border border-red-500/30 px-2.5 py-1 font-medium text-red-700 dark:text-red-300 hover:bg-red-500/10"
            >
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AnchorStatusDot({ status }: { status: AnchorItem["status"] }) {
  const color = {
    unsearched: "bg-foreground/25",
    searching: "bg-foreground animate-pulse",
    candidates: "bg-amber-500",
    confirmed: "bg-emerald-500",
    no_matches: "bg-amber-500",
    lookup_error: "bg-red-500",
  }[status];

  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`}
      aria-hidden="true"
    />
  );
}

// ── Cultural Starter Kit Results View ────────────────────────

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

  const visibleGroups = useMemo(() => {
    if (activeCategoryFilter === "__all__") return groups;
    return groups.filter((g) => g.key === activeCategoryFilter);
  }, [groups, activeCategoryFilter]);

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
    // If a category filter hid the selected card, reset to show all categories
    if (activeCategoryFilter !== "__all__") {
      const inCurrentGroup = visibleGroups.some((g) =>
        g.items.some((i) => i.entityId === entityId),
      );
      if (!inCurrentGroup) {
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

  const unmappedCount = Math.max(
    0,
    completion.recommendations.length - markers.length,
  );

  return (
    <div className="space-y-6">
      {/* 1. Top Kit Summary & Action Header */}
      <div className="rounded-lg border border-foreground/15 bg-foreground/[0.02] p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xl font-semibold tracking-tight">
                {displayCity} Cultural Starter Kit
              </h3>
              <span
                className={`rounded border px-2 py-0.5 font-mono text-xs font-medium ${statusPresentation.badgeClassName}`}
              >
                {statusPresentation.badgeText}
              </span>
              <span className="rounded border border-foreground/15 bg-background px-2 py-0.5 font-mono text-xs text-foreground/75">
                {completion.mode === "deterministic"
                  ? "Deterministic Qloo fallback"
                  : "Agent-assisted (Bedrock + Qloo)"}
              </span>
              {completion.cached && (
                <span className="rounded border border-foreground/15 bg-background px-2 py-0.5 font-mono text-xs text-foreground/65">
                  Cached response
                </span>
              )}
            </div>

            <p className="text-sm text-foreground/75">{completion.summary}</p>
            <p className="text-xs text-foreground/60">
              {statusPresentation.scopeNote}
            </p>

            {/* Profile & Evidence Context Bar */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground/60">
              <span>
                <strong>Places found:</strong>{" "}
                {completion.recommendations.length} accepted{" "}
                {completion.recommendations.length === 1 ? "place" : "places"}{" "}
                across {groups.length} Qloo{" "}
                {groups.length === 1 ? "category group" : "category groups"}
              </span>
              <span>·</span>
              <span>
                <strong>Mapped:</strong> {markers.length} of{" "}
                {completion.recommendations.length}
                {unmappedCount > 0
                  ? ` (${unmappedCount} in list without coordinates)`
                  : ""}
              </span>
              {confirmedAnchorsSummary.length > 0 && (
                <>
                  <span>·</span>
                  <span>
                    <strong>Confirmed anchors:</strong>{" "}
                    {confirmedAnchorsSummary.join(", ")}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onEditAnchors}
              disabled={isGenerating}
              className="rounded-md border border-foreground/20 bg-background px-3.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-foreground/[0.04] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:opacity-40"
            >
              Edit anchors &amp; revise kit
            </button>
            <button
              type="button"
              onClick={() => setIsTraceOpen((prev) => !prev)}
              aria-expanded={isTraceOpen}
              className="rounded-md border border-foreground/20 bg-background px-3.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-foreground/[0.04] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
            >
              {isTraceOpen ? "Hide search process" : "How this kit was built"}
            </button>
          </div>
        </div>

        {/* Partial or Deterministic Fallback Honest Notice */}
        {(completion.status === "partial" ||
          completion.mode === "deterministic") && (
          <div className="mt-4 flex flex-col gap-1 rounded-md border border-foreground/15 bg-background px-3.5 py-2.5 text-xs text-foreground/75">
            {completion.status === "partial" && (
              <p>
                <strong>Partial result notice:</strong>{" "}
                {completion.filteredInvalidCount > 0
                  ? `${completion.filteredInvalidCount} candidate ${
                      completion.filteredInvalidCount === 1
                        ? "ID was"
                        : "IDs were"
                    } excluded because ${
                      completion.filteredInvalidCount === 1
                        ? "it was"
                        : "they were"
                    } not in the deterministic validator's accepted set.`
                  : "Only recommendations that passed every deterministic validation check are included."}{" "}
                CultureBridge never pads results to reach a target count.
              </p>
            )}
            {completion.mode === "deterministic" && (
              <p>
                <strong>Deterministic fallback mode:</strong>{" "}
                {completion.searchProcess.fallbackReason ??
                  "Results were generated directly from Qloo taste queries and deterministic screening without LLM synthesis."}
              </p>
            )}
          </div>
        )}

        {/* Deterministic Evidence Label Key */}
        <div
          aria-label="Evidence label key"
          className="mt-4 grid grid-cols-1 gap-2 border-t border-foreground/10 pt-3.5 sm:grid-cols-3"
        >
          {(
            ["connection", "useful-place", "exploratory"] as const
          ).map((labelKey) => {
            const info = LABEL_PRESENTATION[labelKey];
            const count = completion.recommendations.filter(
              (r) => r.label === labelKey,
            ).length;
            return (
              <div
                key={labelKey}
                className="flex items-start gap-2 rounded border border-foreground/10 bg-background p-2.5 text-xs"
              >
                <span
                  className={`mt-0.5 inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] font-medium ${info.badgeClassName}`}
                >
                  <span aria-hidden="true">{info.symbol}</span>
                  <span>{info.badgeText}</span>
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-medium text-foreground/85">
                      {info.shortTitle}
                    </span>
                    <span className="font-mono text-[11px] text-foreground/55">
                      {count}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-snug text-foreground/60">
                    {info.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 2. Collapsible Agent Trace Drawer */}
      <AgentTraceDrawer
        process={completion.searchProcess}
        isOpen={isTraceOpen}
        onToggle={() => setIsTraceOpen((prev) => !prev)}
      />

      {/* 3. Empty vs Populated Results Experience */}
      {completion.recommendations.length === 0 ? (
        <div className="rounded-lg border border-foreground/15 bg-foreground/[0.015] p-6">
          <h4 className="text-base font-semibold text-foreground/90">
            No places passed deterministic screening for this query
          </h4>
          <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-foreground/65">
            CultureBridge never pads a starter kit with excluded hotels,
            transit hubs, closed listings, or fabricated matches. You can
            inspect the search process above to see how Qloo was queried and why
            candidates were filtered, or adjust your anchors to try a different
            combination.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={onEditAnchors}
              disabled={isGenerating}
              className="rounded-md bg-foreground px-4 py-2 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              Edit cultural anchors
            </button>
            <button
              type="button"
              disabled={isGenerating}
              onClick={onRegenerate}
              className="rounded-md border border-foreground/20 bg-background px-4 py-2 text-xs font-medium text-foreground hover:bg-foreground/[0.04] disabled:opacity-40"
            >
              Retry generation
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-start">
          {/* Map Column — shown above list on mobile, sticky right column on desktop */}
          <div className="order-1 lg:order-2 lg:col-span-5 lg:sticky lg:top-20">
            <ResultsMap
              city={displayCity}
              recommendations={completion.recommendations}
              selectedEntityId={selection.selectedEntityId}
              onSelectEntity={handleSelectFromMap}
              onJumpToCard={handleJumpToCard}
            />
          </div>

          {/* Grouped Recommendations Column */}
          <div className="order-2 space-y-5 lg:order-1 lg:col-span-7">
            {/* Category Filter / Jump Bar */}
            {groups.length > 1 && (
              <nav
                aria-label="Filter recommendations by Qloo category"
                className="flex flex-wrap items-center gap-1.5 rounded-lg border border-foreground/12 bg-foreground/[0.015] p-2.5"
              >
                <button
                  type="button"
                  aria-pressed={activeCategoryFilter === "__all__"}
                  onClick={() => setActiveCategoryFilter("__all__")}
                  className={`rounded border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground ${
                    activeCategoryFilter === "__all__"
                      ? "border-foreground bg-foreground text-background"
                      : "border-foreground/15 bg-background text-foreground/75 hover:border-foreground/35"
                  }`}
                >
                  All categories ({completion.recommendations.length})
                </button>
                {groups.map((group) => {
                  const active = activeCategoryFilter === group.key;
                  return (
                    <button
                      key={group.key}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setActiveCategoryFilter(group.key)}
                      className={`rounded border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground ${
                        active
                          ? "border-foreground bg-foreground text-background"
                          : "border-foreground/15 bg-background text-foreground/75 hover:border-foreground/35"
                      }`}
                    >
                      {group.title} ({group.items.length})
                    </button>
                  );
                })}
              </nav>
            )}

            {/* Category Group Sections */}
            <div className="space-y-6">
              {visibleGroups.map((group) => (
                <section
                  key={group.key}
                  aria-label={`${group.title} recommendations`}
                  className="space-y-3"
                >
                  <div className="flex items-baseline justify-between border-b border-foreground/12 pb-2">
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-semibold tracking-tight text-foreground">
                        {group.title}
                      </h4>
                      {group.isUncategorized && (
                        <span className="text-xs text-foreground/55">
                          · No specific place-category tag in Qloo
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-xs text-foreground/55">
                      {group.items.length}{" "}
                      {group.items.length === 1 ? "place" : "places"}
                    </span>
                  </div>

                  <div className="space-y-3">
                    {group.items.map((rec) => (
                      <RecommendationCard
                        key={rec.entityId}
                        rec={rec}
                        pinOrderIndex={markerOrderById.get(rec.entityId) ?? null}
                        isSelected={selection.selectedEntityId === rec.entityId}
                        onSelect={() => setSelectedEntityId(rec.entityId)}
                      />
                    ))}
                  </div>
                </section>
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
  const labelInfo = getLabelPresentation(rec.label);
  const categoryInfo = useMemo(() => describeCategoryEvidence(rec), [rec]);
  const provenance = useMemo(() => formatRecommendationProvenance(rec), [rec]);
  const practical = useMemo(() => buildPracticalDetailsView(rec), [rec]);

  return (
    <article
      id={`rec-card-${rec.entityId}`}
      tabIndex={-1}
      aria-label={`${rec.name} — ${labelInfo.badgeText}`}
      className={`rounded-lg border p-4 transition-colors focus:outline-none ${
        isSelected
          ? "border-foreground bg-foreground/[0.03] ring-1 ring-foreground"
          : "border-foreground/15 bg-background hover:border-foreground/30"
      }`}
    >
      {/* 1. Card Header: Pin badge, Name, Categories, Evidence Label */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {practical.mappable && pinOrderIndex !== null ? (
              <span
                title={`Map pin #${pinOrderIndex}`}
                className={`inline-flex items-center gap-0.5 rounded-full border px-2 py-0.5 font-mono text-[11px] font-semibold ${
                  isSelected
                    ? "border-foreground bg-foreground text-background"
                    : "border-foreground/30 bg-foreground/[0.05] text-foreground"
                }`}
              >
                <span aria-hidden="true">{labelInfo.symbol}</span>
                <span>{pinOrderIndex}</span>
              </span>
            ) : (
              <span
                title="No valid map coordinates in Qloo"
                className="inline-flex items-center rounded border border-foreground/15 bg-foreground/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-foreground/60"
              >
                Not on map
              </span>
            )}

            <h5 className="text-base font-semibold tracking-tight text-foreground">
              {rec.name}
            </h5>
          </div>

          <p className="text-xs text-foreground/65">
            {categoryInfo.qlooCategories.length > 0 ? (
              <>
                <span className="font-medium text-foreground/80">
                  {categoryInfo.qlooCategoryLabel}:
                </span>{" "}
                {categoryInfo.qlooCategories.join(" · ")}
              </>
            ) : (
              <span className="italic text-foreground/55">
                Category not specified in Qloo output
              </span>
            )}
          </p>
        </div>

        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded border px-2.5 py-1 font-mono text-xs font-medium ${labelInfo.badgeClassName}`}
        >
          <span aria-hidden="true">{labelInfo.symbol}</span>
          <span>{labelInfo.badgeText}</span>
        </span>
      </div>

      {/* 2. Verified Explanation */}
      <p className="mt-3 text-sm leading-relaxed text-foreground/85">
        {rec.explanationText}
      </p>

      {/* 3. Grounded Query Provenance & Evidence Box */}
      <div className="mt-3 space-y-1 rounded-md border border-foreground/12 bg-foreground/[0.02] p-3 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold text-foreground/90">
            {provenance.headline}
          </span>
          {provenance.categoryMatchLabel && (
            <span className="rounded border border-foreground/15 bg-background px-1.5 py-0.5 font-mono text-[10px] text-foreground/65">
              {provenance.categoryMatchLabel}
            </span>
          )}
        </div>
        <p className="text-foreground/70">{provenance.detail}</p>
        {provenance.honestyDisclaimer && (
          <p className="pt-0.5 text-[11px] text-foreground/55">
            {provenance.honestyDisclaimer}
          </p>
        )}
      </div>

      {/* 4. Supporting Qloo Tags (when present) */}
      {practical.supportingTags.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium text-foreground/55">
            Qloo tags:
          </span>
          {practical.supportingTags.map((tag) => (
            <span
              key={tag}
              className="rounded border border-foreground/12 bg-foreground/[0.025] px-2 py-0.5 font-mono text-[11px] text-foreground/70"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* 5. Practical Venue Details & Explicit Unknowns */}
      <dl className="mt-3 grid grid-cols-1 gap-2 border-t border-foreground/10 pt-3 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-[11px] font-medium text-foreground/55">
            Neighborhood &amp; address
          </dt>
          <dd className="mt-0.5 text-foreground/85">
            {practical.locationLine ?? (
              <span className="text-foreground/50">
                Address &amp; neighborhood unavailable in Qloo
              </span>
            )}
          </dd>
        </div>

        <div>
          <dt className="text-[11px] font-medium text-foreground/55">
            Website &amp; contact
          </dt>
          <dd className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-foreground/85">
            {practical.websiteUrl && practical.websiteDisplay ? (
              <a
                href={practical.websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
              >
                {practical.websiteDisplay}
              </a>
            ) : (
              <span className="text-foreground/50">Website unavailable</span>
            )}
            {practical.phone && (
              <>
                <span className="text-foreground/30">·</span>
                <span className="font-mono text-[11px]">{practical.phone}</span>
              </>
            )}
          </dd>
        </div>

        <div>
          <dt className="text-[11px] font-medium text-foreground/55">
            Price &amp; practical details
          </dt>
          <dd className="mt-0.5 text-foreground/85">
            {practical.priceTier ? (
              <span>
                Price tier:{" "}
                <strong className="font-mono">{practical.priceTier}</strong>
              </span>
            ) : (
              <span className="text-foreground/50">Price tier: Unknown</span>
            )}
            <span className="text-foreground/30"> · </span>
            <span className="text-foreground/50">
              Hours &amp; ratings: Not provided
            </span>
          </dd>
        </div>

        <div>
          <dt className="text-[11px] font-medium text-foreground/55">
            Unavailable in Qloo output
          </dt>
          <dd className="mt-0.5 text-[11px] text-foreground/55">
            {practical.unavailableFields.join(", ")}
          </dd>
        </div>
      </dl>

      {/* 6. Card Footer: Map Coordination & Selection */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-foreground/10 pt-2.5 text-xs">
        {practical.mappable && practical.coordinates ? (
          <span className="font-mono text-[11px] text-foreground/55">
            Coordinates: {practical.coordinates.lat.toFixed(4)},{" "}
            {practical.coordinates.lon.toFixed(4)}
          </span>
        ) : (
          <span className="text-[11px] text-foreground/55">
            Cannot be shown on map — no valid coordinates in Qloo output
          </span>
        )}

        <button
          type="button"
          aria-pressed={isSelected}
          onClick={onSelect}
          className={`rounded border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground ${
            isSelected
              ? "border-foreground bg-foreground text-background"
              : "border-foreground/20 bg-background text-foreground hover:bg-foreground/[0.04]"
          }`}
        >
          {practical.mappable
            ? isSelected
              ? "Focused on map"
              : "Focus on map"
            : isSelected
              ? "Selected in list"
              : "Select place"}
        </button>
      </div>
    </article>
  );
}
