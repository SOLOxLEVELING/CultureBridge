"use client";

import { useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { AnchorSearchResponse } from "@/lib/api";
import type { RecommendationLabel } from "@/lib/recommend";
import {
  ANCHOR_TYPE_META,
  CITY_META,
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
  canGenerateKit,
  confirmAnchorCandidate,
  createInitialFlowState,
  deriveFlowPhase,
  formatAnchorType,
  getPresetById,
  removeAnchor,
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
      "Review your verified recommendations below, or adjust your anchors to explore further.",
  },
  empty_recommendations: {
    badge: "No matches found",
    instruction:
      "No verified places met the evidence threshold for this combination. Try adjusting your anchors or destination.",
  },
  generation_error: {
    badge: "Generation failed",
    instruction:
      "Your profile, destination city, and confirmed anchors are preserved. Retry whenever you are ready.",
  },
};

const LABEL_STYLES: Record<
  RecommendationLabel,
  { bg: string; text: string; border: string; display: string }
> = {
  connection: {
    bg: "bg-emerald-500/10",
    text: "text-emerald-700 dark:text-emerald-400",
    border: "border-emerald-500/20",
    display: "Connection",
  },
  "useful-place": {
    bg: "bg-foreground/[0.06]",
    text: "text-foreground/80",
    border: "border-foreground/15",
    display: "Useful place",
  },
  exploratory: {
    bg: "bg-foreground/[0.03]",
    text: "text-foreground/60",
    border: "border-foreground/10",
    display: "Exploratory",
  },
};

export function StarterKitFlow() {
  const [state, setState] = useState<FlowState>(() => createInitialFlowState());
  const [formError, setFormError] = useState<string | null>(null);
  const [isAddRowOpen, setIsAddRowOpen] = useState<boolean>(false);
  const [newQuery, setNewQuery] = useState<string>("");
  const [newType, setNewType] =
    useState<SupportedAnchorType>("urn:entity:artist");

  // Synchronous lock to prevent accidental duplicate /api/kit submissions
  const kitSubmittingRef = useRef<boolean>(false);
  const stateRef = useRef<FlowState>(state);
  stateRef.current = state;

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
      <header className="sticky top-0 z-10 border-b border-foreground/10 bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-6">
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
              Destination: <strong className="font-semibold">{state.city}</strong>
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

      <main className="mx-auto max-w-3xl space-y-8 px-4 py-6 sm:px-6 sm:py-10">
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
                        selected ? "bg-foreground" : "border border-foreground/30"
                      }`}
                      aria-hidden="true"
                    />
                  </div>
                  <p className="mt-1 text-xs text-foreground/60">{meta.note}</p>
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
                    <span className="text-sm font-semibold">{preset.name}</span>
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
          aria-labelledby={`${baseId}-anchors-heading`}
          className="space-y-3"
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

              {state.anchors.length < MAX_TRUSTED_ANCHORS && !isAddRowOpen && (
                <button
                  type="button"
                  disabled={isGenerating}
                  onClick={() => {
                    setFormError(null);
                    setIsAddRowOpen(true);
                  }}
                  className="rounded-md border border-foreground/20 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-foreground/[0.04] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  + Add anchor ({state.anchors.length}/{MAX_TRUSTED_ANCHORS})
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

        {/* Generation Output States: Error, Empty, Partial/Success */}
        {state.generation.status === "error" && (
          <section
            role="alert"
            aria-label="Starter kit generation error"
            className="rounded-lg border border-red-500/30 bg-red-500/5 p-5"
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
                  {confirmedCount === 1 ? "anchor" : "anchors"} are still intact.
                </p>
              </div>
              <button
                type="button"
                onClick={handleGenerateKit}
                disabled={!isReady || isGenerating}
                className="shrink-0 rounded-md border border-foreground/25 bg-background px-4 py-2 text-xs font-medium text-foreground transition-colors hover:bg-foreground/[0.04]"
              >
                Retry generation
              </button>
            </div>
          </section>
        )}

        {state.generation.result && (
          <CompletionView
            completion={state.generation.result}
            onRegenerate={handleGenerateKit}
            isGenerating={isGenerating}
          />
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
      {/* Top row: anchor query, requested type, status badge, row actions */}
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

      {/* State-specific detail body */}
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

function CompletionView({
  completion,
  onRegenerate,
  isGenerating,
}: {
  completion: SafeKitCompletion;
  onRegenerate: () => void;
  isGenerating: boolean;
}) {
  const statusBadge = {
    success: {
      label: "Verified Starter Kit",
      style:
        "border-emerald-500/25 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
    },
    partial: {
      label: "Partial Starter Kit",
      style:
        "border-amber-500/25 bg-amber-500/10 text-amber-800 dark:text-amber-300",
    },
    empty: {
      label: "No Verified Matches",
      style: "border-foreground/20 bg-foreground/5 text-foreground/70",
    },
  }[completion.status];

  return (
    <section
      aria-label="Cultural Starter Kit results"
      className="space-y-4 border-t border-foreground/15 pt-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold tracking-tight">
              {completion.city
                ? `${completion.city} Cultural Starter Kit`
                : "Cultural Starter Kit"}
            </h3>
            <span
              className={`rounded border px-2 py-0.5 font-mono text-xs font-medium ${statusBadge.style}`}
            >
              {statusBadge.label}
            </span>
          </div>
          <p className="mt-1 text-sm text-foreground/65">
            {completion.summary}
          </p>
        </div>

        <span className="font-mono text-xs text-foreground/50">
          {completion.recommendations.length}{" "}
          {completion.recommendations.length === 1 ? "place" : "places"}
        </span>
      </div>

      {completion.recommendations.length === 0 ? (
        <div className="rounded-lg border border-foreground/15 p-6">
          <p className="text-sm font-medium text-foreground/80">
            No recommendations passed verification for this query
          </p>
          <p className="mt-1 text-xs text-foreground/60">
            CultureBridge never pads results with unverified places. Try adding
            another confirmed anchor, choosing a different preset, or switching
            between Berlin and Toronto.
          </p>
          <button
            type="button"
            disabled={isGenerating}
            onClick={onRegenerate}
            className="mt-4 rounded-md border border-foreground/20 px-3.5 py-1.5 text-xs font-medium hover:bg-foreground/[0.04]"
          >
            Try again
          </button>
        </div>
      ) : (
        <div className="space-y-2.5">
          {completion.recommendations.map((rec) => (
            <RecommendationCard key={rec.entityId} rec={rec} />
          ))}
        </div>
      )}
    </section>
  );
}

function RecommendationCard({ rec }: { rec: SafeRecommendationItem }) {
  const style = LABEL_STYLES[rec.label];

  const details: string[] = [];
  if (rec.neighborhood) details.push(rec.neighborhood);
  if (rec.address) details.push(rec.address);
  if (rec.phone) details.push(rec.phone);
  if (rec.priceLevel != null && rec.priceLevel > 0) {
    details.push("$".repeat(Math.min(rec.priceLevel, 4)));
  }

  return (
    <article className="rounded-lg border border-foreground/12 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold">{rec.name}</h4>
          {rec.categories.length > 0 && (
            <p className="text-xs text-foreground/55">
              {rec.categories.join(" · ")}
            </p>
          )}
        </div>
        <span
          className={`shrink-0 rounded border px-2 py-0.5 font-mono text-[11px] font-medium ${style.bg} ${style.text} ${style.border}`}
        >
          {style.display}
        </span>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-foreground/75">
        {rec.explanationText}
      </p>

      {(details.length > 0 || rec.website) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground/50">
          {details.length > 0 && <span>{details.join(" · ")}</span>}
          {rec.website && (
            <a
              href={rec.website}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground/75"
            >
              {rec.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
            </a>
          )}
        </div>
      )}
    </article>
  );
}
