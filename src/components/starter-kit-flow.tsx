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
  getPresetById,
  groupRecommendationsByCategory,
  isTestedCity,
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
      className="flex h-80 w-full items-center justify-center rounded-2xl border border-cb-border bg-cb-card text-sm text-cb-muted sm:h-96 lg:h-[520px]"
    >
      Loading city map…
    </div>
  ),
});

export function StarterKitFlow() {
  const [state, setState] = useState<FlowState>(() => createInitialFlowState());
  const [formError, setFormError] = useState<string | null>(null);
  const [isAddRowOpen, setIsAddRowOpen] = useState<boolean>(false);
  const [newQuery, setNewQuery] = useState<string>("");
  const [newType, setNewType] =
    useState<SupportedAnchorType>("urn:entity:artist");
  const [isErrorTraceOpen, setIsErrorTraceOpen] = useState<boolean>(false);
  const [view, setView] = useState<"setup" | "results">("setup");
  const [setupStep, setSetupStep] = useState<"start" | "interests">("start");
  const [theme, setTheme] = useState<"light" | "dark">("light");

  const kitSubmittingRef = useRef<boolean>(false);
  const stateRef = useRef<FlowState>(state);
  stateRef.current = state;

  const anchorsSectionRef = useRef<HTMLElement | null>(null);

  const baseId = useId();
  const phase = deriveFlowPhase(state);
  const isGenerating = state.generation.status === "loading";

  const confirmedCount = state.anchors.filter(
    (a) => a.status === "confirmed" && a.confirmedEntity !== null,
  ).length;
  const unsearchedAnchors = state.anchors.filter(
    (a) => a.status === "unsearched",
  );
  const pendingAnchors = state.anchors.filter(
    (a) => a.status !== "confirmed" || a.confirmedEntity === null,
  );
  const isReady = canGenerateKit(state);
  const activePreset = getPresetById(state.selectedPresetId);
  const activeCityMeta = isTestedCity(state.city)
    ? CITY_META[state.city]
    : { name: state.city, country: "", note: "" };

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Transition to results view when generation produces a response
  useEffect(() => {
    const s = state.generation.status;
    if (s === "success" || s === "partial" || s === "empty") {
      setView("results");
      window.scrollTo({ top: 0, behavior: "instant" });
    }
  }, [state.generation.status]);

  function handleEditInterests() {
    setView("setup");
    setSetupStep("interests");
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function handleContinueToInterests() {
    setFormError(null);
    if (state.selectedPresetId === "custom" && state.anchors.length === 0) {
      setIsAddRowOpen(true);
    }
    setSetupStep("interests");
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function handleBackToStart() {
    setFormError(null);
    setSetupStep("start");
    window.scrollTo({ top: 0, behavior: "instant" });
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
    // Preserve existing confirmations if clicking the already-selected preset without custom edits
    if (
      presetId === stateRef.current.selectedPresetId &&
      !stateRef.current.hasEditedAnchors
    ) {
      return;
    }
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
      {/* Editorial Masthead */}
      <header className="border-b border-cb-border bg-background">
        <div
          className={`mx-auto flex items-center justify-between px-5 py-4 sm:px-8 ${
            view === "results" ? "max-w-[1360px]" : "max-w-6xl"
          }`}
        >
          <div className="flex items-center gap-2.5">
            <span className="text-base font-semibold tracking-tight text-foreground sm:text-lg">
              CultureBridge
            </span>
            <span className="text-cb-border-strong" aria-hidden="true">
              /
            </span>
            <span className="text-sm font-medium text-cb-muted">
              {state.city}
            </span>
          </div>

          <div className="flex items-center gap-2.5">
            {view === "results" && (
              <button
                type="button"
                onClick={handleEditInterests}
                className="rounded-full border border-cb-border bg-cb-card px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-cb-border-strong hover:bg-cb-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent"
              >
                Edit interests
              </button>
            )}

            <button
              type="button"
              onClick={() =>
                setTheme((prev) => (prev === "light" ? "dark" : "light"))
              }
              aria-label={
                theme === "light"
                  ? "Switch to dark theme"
                  : "Switch to light theme"
              }
              title={
                theme === "light"
                  ? "Switch to dark theme"
                  : "Switch to light theme"
              }
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-cb-border bg-cb-card text-cb-muted transition-colors hover:border-cb-border-strong hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent"
            >
              {theme === "light" ? (
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
                </svg>
              ) : (
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
            </button>
          </div>
        </div>
      </header>

      <main
        className={`mx-auto px-5 py-8 sm:px-8 sm:py-12 ${
          view === "results" ? "max-w-[1360px]" : "max-w-6xl"
        }`}
      >
        {/* ── SETUP VIEW: TWO-STAGE GUIDED EXPERIENCE ─────────── */}
        {view === "setup" && setupStep === "start" && (
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-12 lg:grid-rows-[auto_1fr] lg:gap-x-12 lg:gap-y-8 lg:items-start xl:gap-x-16">
            {/* Element 1 (Left Top): Editorial Introduction */}
            <section
              aria-label="Introduction"
              className="space-y-3.5 lg:col-span-5 lg:col-start-1 lg:row-start-1"
            >
              <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-5xl lg:text-[3.1rem] lg:leading-[1.06]">
                Find your kind of {state.city}.
              </h1>
              <p className="max-w-md text-base text-cb-muted sm:text-lg leading-relaxed">
                The music, shows and brands you love can be a starting point for
                exploring somewhere new.
              </p>
            </section>

            {/* Element 2 (Right Column): Curated City & Taste Profile Choices */}
            <div className="space-y-8 lg:col-span-7 lg:col-start-6 lg:row-start-1 lg:row-span-2">
              {/* Decision 1: Destination City */}
              <section
                aria-labelledby={`${baseId}-city-heading`}
                className="space-y-3"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h2
                    id={`${baseId}-city-heading`}
                    className="text-base font-semibold text-foreground"
                  >
                    Destination
                  </h2>
                </div>

                <div
                  role="group"
                  aria-labelledby={`${baseId}-city-heading`}
                  className="grid grid-cols-1 gap-3 sm:grid-cols-2"
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
                        className={`group relative flex flex-col items-start rounded-2xl border p-5 text-left transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent disabled:cursor-not-allowed disabled:opacity-50 ${
                          selected
                            ? "border-cb-accent bg-cb-card shadow-[0_6px_22px_rgba(35,34,30,0.06)] ring-1 ring-cb-accent/25"
                            : "border-cb-border bg-cb-card/60 hover:border-cb-border-strong hover:bg-cb-card"
                        }`}
                      >
                        <div className="flex w-full items-center justify-between gap-2">
                          <div className="flex items-baseline gap-2">
                            <span className="text-lg font-semibold tracking-tight text-foreground">
                              {meta.name}
                            </span>
                            <span className="text-xs font-medium text-cb-muted">
                              {meta.country}
                            </span>
                          </div>
                          <span
                            className={`inline-flex h-5 w-5 items-center justify-center rounded-full border transition-colors ${
                              selected
                                ? "border-cb-accent bg-cb-accent text-cb-accent-fg"
                                : "border-cb-border-strong bg-transparent"
                            }`}
                            aria-hidden="true"
                          >
                            {selected && (
                              <span className="h-2 w-2 rounded-full bg-cb-accent-fg" />
                            )}
                          </span>
                        </div>
                        <p className="mt-2 text-xs text-cb-muted leading-relaxed">
                          {meta.note}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* Decision 2: Starting Taste Profile (Editorial Ledger List) */}
              <section
                aria-labelledby={`${baseId}-persona-heading`}
                className="space-y-3"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h2
                    id={`${baseId}-persona-heading`}
                    className="text-base font-semibold text-foreground"
                  >
                    Starting taste profile
                  </h2>
                </div>

                <div
                  role="group"
                  aria-labelledby={`${baseId}-persona-heading`}
                  className="overflow-hidden rounded-2xl border border-cb-border bg-cb-card shadow-[0_2px_16px_rgba(35,34,30,0.035)] divide-y divide-cb-border"
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
                        className={`flex w-full items-start gap-3.5 p-4 text-left transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-cb-accent disabled:cursor-not-allowed disabled:opacity-50 sm:px-5 sm:py-4.5 ${
                          selected
                            ? "bg-cb-accent-soft/50"
                            : "bg-cb-card hover:bg-cb-surface/40"
                        }`}
                      >
                        <span
                          className={`mt-1 inline-flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border transition-colors ${
                            selected
                              ? "border-cb-accent bg-cb-accent text-cb-accent-fg"
                              : "border-cb-border-strong bg-background"
                          }`}
                          aria-hidden="true"
                        >
                          {selected && (
                            <span className="h-1.5 w-1.5 rounded-full bg-cb-accent-fg" />
                          )}
                        </span>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-sm font-semibold text-foreground sm:text-base">
                              {preset.name}
                            </span>
                            <span
                              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                                selected
                                  ? "bg-cb-accent/12 text-cb-accent"
                                  : "bg-cb-surface text-cb-muted"
                              }`}
                            >
                              {preset.anchors.length > 0
                                ? `${preset.anchors.length} interests`
                                : "Blank slate"}
                            </span>
                          </div>

                          <p className="mt-1 text-xs text-cb-muted leading-relaxed sm:text-sm">
                            {preset.description}
                          </p>

                          {preset.anchors.length > 0 && (
                            <p className="mt-2 text-xs font-medium text-foreground/75">
                              {preset.anchors.map((s) => s.query).join(" · ")}
                            </p>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            </div>

            {/* Element 3 (Left Bottom on Desktop, Bottom on Mobile): Selected Profile Preview & Continue Action */}
            <aside
              aria-label="Selected starting point"
              className="rounded-2xl border border-cb-border bg-cb-card p-5 shadow-[0_4px_20px_rgba(35,34,30,0.04)] sm:p-6 lg:col-span-5 lg:col-start-1 lg:row-start-2 lg:self-start"
            >
              <div className="flex items-baseline justify-between gap-2 border-b border-cb-border pb-3.5">
                <div>
                  <p className="text-xs font-medium text-cb-muted">
                    Selected starting point
                  </p>
                  <h3 className="mt-0.5 text-base font-semibold text-foreground">
                    {activeCityMeta.name}
                    {activeCityMeta.country
                      ? `, ${activeCityMeta.country}`
                      : ""}{" "}
                    · {activePreset.name}
                  </h3>
                </div>
                {confirmedCount > 0 && (
                  <span className="shrink-0 text-xs font-medium text-cb-confirmed">
                    {confirmedCount} of {state.anchors.length} confirmed
                  </span>
                )}
              </div>

              {/* Compact preview of the selected profile's interests */}
              <div className="py-4">
                {state.anchors.length > 0 ? (
                  <div className="space-y-3">
                    <ul className="divide-y divide-cb-border/70">
                      {state.anchors.map((item) => {
                        const isItemConfirmed =
                          item.status === "confirmed" &&
                          item.confirmedEntity !== null;
                        return (
                          <li
                            key={item.id}
                            className="flex items-center justify-between gap-2 py-2 text-xs first:pt-0 last:pb-0 sm:text-sm"
                          >
                            <div className="flex min-w-0 items-center gap-2.5">
                              {isItemConfirmed ? (
                                <span
                                  className="text-cb-confirmed"
                                  title="Confirmed"
                                  aria-hidden="true"
                                >
                                  ✓
                                </span>
                              ) : (
                                <span
                                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-cb-accent/75"
                                  aria-hidden="true"
                                />
                              )}
                              <span className="truncate font-medium text-foreground">
                                {isItemConfirmed
                                  ? item.confirmedEntity!.name
                                  : item.query}
                              </span>
                            </div>
                            <span className="shrink-0 text-xs text-cb-muted">
                              {formatAnchorType(item.type)}
                            </span>
                          </li>
                        );
                      })}
                    </ul>

                    <p className="border-t border-cb-border pt-3 text-xs text-cb-muted leading-relaxed">
                      Review and confirm each match in the next step.
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-cb-muted leading-relaxed">
                    Start with a blank slate and add up to five artists, shows,
                    films, brands, or people in the next step.
                  </p>
                )}
              </div>

              <button
                type="button"
                disabled={isGenerating}
                onClick={handleContinueToInterests}
                className="inline-flex w-full items-center justify-center rounded-full bg-cb-accent px-6 py-3.5 text-sm font-semibold text-cb-accent-fg shadow-xs transition-colors hover:bg-cb-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent disabled:cursor-not-allowed disabled:opacity-40"
              >
                {state.anchors.length > 0
                  ? "Continue to your interests"
                  : "Add your interests"}
              </button>
            </aside>
          </div>
        )}

        {/* ── STAGE 2: CONFIRM YOUR INTERESTS ─────────────────── */}
        {view === "setup" && setupStep === "interests" && (
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-12 lg:grid-rows-[auto_1fr] lg:gap-x-12 lg:gap-y-6 lg:items-start xl:gap-x-16">
            {/* Element 1 (Left Top): Stage 2 Context & Back Control */}
            <section
              aria-label="Confirm your interests"
              className="space-y-4 lg:col-span-5 lg:col-start-1 lg:row-start-1"
            >
              <button
                type="button"
                disabled={isGenerating}
                onClick={handleBackToStart}
                className="inline-flex items-center gap-1.5 rounded-full border border-cb-border bg-cb-card px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-cb-border-strong hover:bg-cb-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent disabled:opacity-40"
              >
                <span aria-hidden="true">←</span>
                <span>Back to city &amp; profile</span>
              </button>

              <div className="space-y-2.5">
                <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl lg:leading-[1.1]">
                  Confirm your interests for {state.city}.
                </h1>
                <p className="text-sm text-cb-muted leading-relaxed sm:text-base">
                  Match each pick so your guide reflects the exact artist, show,
                  film, or brand you have in mind.
                </p>
              </div>
            </section>

            {/* Element 2 (Right Column): Interests Collection & Candidate Confirmation */}
            <section
              ref={anchorsSectionRef}
              aria-labelledby={`${baseId}-anchors-heading`}
              className="scroll-mt-8 space-y-4 lg:col-span-7 lg:col-start-6 lg:row-start-1 lg:row-span-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-baseline gap-2.5">
                  <h2
                    id={`${baseId}-anchors-heading`}
                    className="text-base font-semibold text-foreground"
                  >
                    Your interests
                  </h2>
                  <span className="text-xs text-cb-muted">
                    {state.anchors.length} of {MAX_TRUSTED_ANCHORS}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {unsearchedAnchors.length > 0 && (
                    <button
                      type="button"
                      disabled={isGenerating}
                      onClick={lookupAllUnsearched}
                      className="rounded-full bg-cb-accent px-4 py-2 text-xs font-semibold text-cb-accent-fg shadow-xs transition-colors hover:bg-cb-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent disabled:cursor-not-allowed disabled:opacity-50"
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
                        className="rounded-full border border-cb-border bg-cb-card px-4 py-2 text-xs font-medium text-foreground transition-colors hover:border-cb-border-strong hover:bg-cb-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        + Add interest
                      </button>
                    )}
                </div>
              </div>

              {formError && (
                <div
                  role="alert"
                  className="rounded-xl border border-cb-error/30 bg-cb-error-soft px-4 py-3 text-sm text-cb-error"
                >
                  {formError}
                </div>
              )}

              {/* Interest collection list */}
              <div className="overflow-hidden rounded-2xl border border-cb-border bg-cb-card shadow-[0_2px_16px_rgba(35,34,30,0.035)] divide-y divide-cb-border">
                {state.anchors.length === 0 && !isAddRowOpen && (
                  <div className="p-8 text-center">
                    <p className="text-base font-semibold text-foreground">
                      Your interest list is empty
                    </p>
                    <p className="mx-auto mt-1 max-w-md text-sm text-cb-muted">
                      Add an artist, television show, film, brand, or public
                      figure to start shaping your {state.city} guide.
                    </p>
                    <button
                      type="button"
                      disabled={isGenerating}
                      onClick={() => setIsAddRowOpen(true)}
                      className="mt-4 rounded-full bg-cb-accent px-5 py-2.5 text-sm font-semibold text-cb-accent-fg transition-colors hover:bg-cb-accent-hover"
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
                      setState((prev) =>
                        setAnchorEditing(prev, anchor.id, true),
                      )
                    }
                    onCancelEdit={() =>
                      setState((prev) =>
                        setAnchorEditing(prev, anchor.id, false),
                      )
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

                {/* Add interest composer */}
                {isAddRowOpen && state.anchors.length < MAX_TRUSTED_ANCHORS && (
                  <form
                    onSubmit={handleAddAnchorSubmit}
                    className="bg-background/60 p-4 sm:p-5"
                  >
                    <div className="mb-3 flex items-center justify-between">
                      <span className="text-xs font-semibold text-foreground">
                        Add to your interests ({state.anchors.length + 1} of{" "}
                        {MAX_TRUSTED_ANCHORS})
                      </span>
                      {state.anchors.length > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            setIsAddRowOpen(false);
                            setFormError(null);
                          }}
                          className="text-xs font-medium text-cb-muted hover:text-foreground"
                        >
                          Cancel
                        </button>
                      )}
                    </div>

                    <div className="flex flex-col gap-2.5 sm:flex-row">
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
                          className="w-full rounded-xl border border-cb-border bg-cb-card px-3 py-2.5 text-sm text-foreground focus:border-cb-accent focus:outline-none focus:ring-1 focus:ring-cb-accent"
                        >
                          {SUPPORTED_ANCHOR_TYPES.map((typeOption) => (
                            <option key={typeOption} value={typeOption}>
                              {ANCHOR_TYPE_META[typeOption].label}
                            </option>
                          ))}
                        </select>
                      </div>

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
                          className="w-full rounded-xl border border-cb-border bg-cb-card px-3.5 py-2.5 text-sm text-foreground placeholder:text-cb-muted focus:border-cb-accent focus:outline-none focus:ring-1 focus:ring-cb-accent"
                        />
                      </div>

                      <button
                        type="submit"
                        disabled={isGenerating || newQuery.trim().length === 0}
                        className="rounded-xl bg-cb-accent px-4 py-2.5 text-sm font-semibold text-cb-accent-fg transition-colors hover:bg-cb-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Find matches
                      </button>
                    </div>
                  </form>
                )}
              </div>
            </section>

            {/* Element 3 (Left Bottom on Desktop, Bottom on Mobile): Build Guide Action & Error State */}
            <div className="space-y-4 lg:col-span-5 lg:col-start-1 lg:row-start-2 lg:self-start">
              <section
                aria-label="Build city guide"
                className="rounded-2xl border border-cb-border bg-cb-card p-5 shadow-[0_4px_20px_rgba(35,34,30,0.04)] sm:p-6"
              >
                <div className="mb-3.5 flex items-center justify-between gap-2 border-b border-cb-border pb-3 text-xs text-cb-muted">
                  <span className="font-medium text-foreground">
                    {activeCityMeta.name}
                    {activeCityMeta.country ? `, ${activeCityMeta.country}` : ""}
                  </span>
                  <span>{activePreset.name}</span>
                </div>

                <div className="space-y-1.5" role="status" aria-live="polite">
                  <p className="text-sm font-semibold text-foreground sm:text-base">
                    {isGenerating
                      ? `Curating your ${state.city} guide…`
                      : isReady
                        ? `Ready to build your ${state.city} guide`
                        : state.anchors.length === 0
                          ? "Add at least one interest to get started"
                          : `${confirmedCount} of ${state.anchors.length} ${
                              state.anchors.length === 1
                                ? "interest"
                                : "interests"
                            } confirmed`}
                  </p>
                  <p className="text-xs text-cb-muted leading-relaxed sm:text-sm">
                    {isGenerating
                      ? `Searching taste connections and screening venues in ${state.city}.`
                      : isReady
                        ? `Using ${state.anchors
                            .map((a) => a.confirmedEntity?.name ?? a.query)
                            .join(", ")}.`
                        : phase === "waiting_for_confirmation"
                          ? "Select the matching entry for each interest to continue."
                          : unsearchedAnchors.length > 0
                            ? `Find matches for ${
                                pendingAnchors.length === 1
                                  ? `"${pendingAnchors[0].query}"`
                                  : `your remaining ${pendingAnchors.length} interests`
                              }, then confirm each one.`
                            : "Confirm or remove any unresolved interests to continue."}
                  </p>
                </div>

                <div className="mt-5 space-y-2.5">
                  <button
                    type="button"
                    onClick={handleGenerateKit}
                    disabled={!isReady || isGenerating}
                    className="inline-flex w-full items-center justify-center gap-2.5 rounded-full bg-cb-accent px-6 py-3.5 text-sm font-semibold text-cb-accent-fg shadow-xs transition-all hover:bg-cb-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent disabled:cursor-not-allowed disabled:opacity-40"
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
                  className="space-y-4 rounded-2xl border border-cb-error/30 bg-cb-error-soft p-5"
                >
                  <div className="space-y-3">
                    <div>
                      <h3 className="text-sm font-semibold text-cb-error">
                        Couldn&rsquo;t build your guide right now
                      </h3>
                      <p className="mt-1 text-sm text-foreground/85">
                        {state.generation.errorMessage ??
                          "An unexpected error occurred."}
                      </p>
                      <p className="mt-1 text-xs text-cb-muted">
                        Your destination ({state.city}) and {confirmedCount}{" "}
                        confirmed{" "}
                        {confirmedCount === 1 ? "interest" : "interests"} are
                        still saved.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={focusAnchorsEditor}
                        className="rounded-full border border-cb-border bg-cb-card px-4 py-2 text-xs font-medium text-foreground hover:bg-cb-surface"
                      >
                        Review interests
                      </button>
                      <button
                        type="button"
                        onClick={handleGenerateKit}
                        disabled={!isReady || isGenerating}
                        className="rounded-full bg-cb-accent px-4 py-2 text-xs font-semibold text-cb-accent-fg hover:bg-cb-accent-hover disabled:opacity-40"
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
          </div>
        )}

        {/* Results view — shown after generation */}
        {view === "results" && state.generation.result && (
          <section aria-label="Your city guide" className="scroll-mt-4">
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
      <form
        onSubmit={handleEditSubmit}
        className="space-y-3 bg-background/60 p-4 sm:p-5"
      >
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-foreground">
            Edit interest
          </span>
          <button
            type="button"
            onClick={onCancelEdit}
            className="text-xs font-medium text-cb-muted hover:text-foreground"
          >
            Cancel
          </button>
        </div>

        <div className="flex flex-col gap-2.5 sm:flex-row">
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
              className="w-full rounded-xl border border-cb-border bg-cb-card px-3 py-2 text-sm text-foreground focus:border-cb-accent focus:outline-none focus:ring-1 focus:ring-cb-accent"
            >
              {SUPPORTED_ANCHOR_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ANCHOR_TYPE_META[t].label}
                </option>
              ))}
            </select>
          </div>

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
              className="w-full rounded-xl border border-cb-border bg-cb-card px-3.5 py-2 text-sm text-foreground focus:border-cb-accent focus:outline-none focus:ring-1 focus:ring-cb-accent"
            />
          </div>

          <button
            type="submit"
            disabled={disabled || editQuery.trim().length === 0}
            className="rounded-xl bg-cb-accent px-4 py-2 text-sm font-semibold text-cb-accent-fg hover:bg-cb-accent-hover disabled:opacity-40"
          >
            Save &amp; find
          </button>
        </div>
      </form>
    );
  }

  const isConfirmed =
    anchor.status === "confirmed" && anchor.confirmedEntity !== null;
  const displayTitle = isConfirmed
    ? anchor.confirmedEntity!.name
    : anchor.query;
  const disambiguation =
    isConfirmed &&
    anchor.confirmedEntity!.disambiguation &&
    anchor.confirmedEntity!.disambiguation.toLowerCase() !==
      anchor.confirmedEntity!.name.toLowerCase()
      ? anchor.confirmedEntity!.disambiguation
      : null;

  return (
    <div className="p-4 sm:px-5 sm:py-4">
      {/* Unified interest row */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex min-w-0 items-center gap-3">
          {/* Status indicator */}
          {isConfirmed ? (
            <span
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-cb-confirmed-soft text-cb-confirmed"
              title="Confirmed match"
            >
              <svg
                className="h-3.5 w-3.5"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
              </svg>
            </span>
          ) : anchor.status === "searching" ? (
            <span
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center"
              aria-hidden="true"
            >
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-cb-border border-t-cb-accent" />
            </span>
          ) : anchor.status === "candidates" ? (
            <span
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-cb-warning-soft text-xs font-bold text-cb-warning"
              title="Select a match"
              aria-hidden="true"
            >
              ?
            </span>
          ) : anchor.status === "no_matches" ||
            anchor.status === "lookup_error" ? (
            <span
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-cb-error-soft text-xs font-bold text-cb-error"
              aria-hidden="true"
            >
              !
            </span>
          ) : (
            <span
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-cb-border-strong bg-background text-cb-muted"
              title="Not yet matched"
              aria-hidden="true"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-cb-muted/60" />
            </span>
          )}

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-foreground sm:text-base">
                {displayTitle}
              </span>
              {disambiguation && (
                <span className="text-xs text-cb-muted">
                  ({disambiguation})
                </span>
              )}
              <span className="rounded-full bg-cb-surface px-2.5 py-0.5 text-xs font-medium text-cb-muted">
                {formatAnchorType(anchor.type)}
              </span>
            </div>
            {isConfirmed &&
              anchor.query.trim().toLowerCase() !==
                anchor.confirmedEntity!.name.trim().toLowerCase() && (
                <p className="mt-0.5 text-xs text-cb-muted">
                  Matched from &ldquo;{anchor.query}&rdquo;
                </p>
              )}
          </div>
        </div>

        {/* Actions */}
        <div className="ml-auto flex items-center gap-1 text-xs sm:gap-1.5 sm:text-sm">
          {anchor.status === "unsearched" && (
            <button
              type="button"
              disabled={disabled}
              onClick={onLookup}
              className="rounded-full border border-cb-border-strong bg-background px-3.5 py-1.5 text-xs font-semibold text-foreground transition-colors hover:border-cb-accent hover:text-cb-accent disabled:opacity-40"
            >
              Find match
            </button>
          )}
          {anchor.status === "confirmed" && (
            <button
              type="button"
              disabled={disabled}
              onClick={onUnconfirm}
              className="rounded-full px-2.5 py-1 text-xs font-medium text-cb-muted transition-colors hover:bg-cb-surface hover:text-foreground disabled:opacity-40"
            >
              Change
            </button>
          )}
          <button
            type="button"
            disabled={disabled || anchor.status === "searching"}
            onClick={openEdit}
            className="rounded-full px-2.5 py-1 text-xs font-medium text-cb-muted transition-colors hover:bg-cb-surface hover:text-foreground disabled:opacity-40"
          >
            Edit
          </button>
          <button
            type="button"
            disabled={disabled || anchor.status === "searching"}
            onClick={onRemove}
            aria-label={`Remove ${anchor.query}`}
            className="rounded-full px-2.5 py-1 text-xs font-medium text-cb-muted transition-colors hover:bg-cb-error-soft hover:text-cb-error disabled:opacity-40"
          >
            Remove
          </button>
        </div>
      </div>

      {/* Searching status */}
      {anchor.status === "searching" && (
        <p
          role="status"
          aria-live="polite"
          className="mt-2 pl-9 text-xs text-cb-muted"
        >
          Looking up &ldquo;{anchor.query}&rdquo;…
        </p>
      )}

      {/* Candidate selection panel */}
      {anchor.status === "candidates" && anchor.candidates.length > 0 && (
        <div className="mt-3.5 pl-0 sm:pl-9">
          <div className="rounded-xl border border-cb-border bg-background/75 p-3.5">
            <p className="mb-2.5 text-xs font-medium text-foreground">
              {anchor.candidates.length === 1
                ? "Confirm this match for your guide:"
                : `Found ${anchor.candidates.length} possible matches — choose the one you mean:`}
            </p>

            <div
              role="group"
              aria-label={`Matches for ${anchor.query}`}
              className="space-y-2"
            >
              {anchor.candidates.map((cand) => {
                const candDisambig =
                  cand.disambiguation &&
                  cand.disambiguation.toLowerCase() !== cand.name.toLowerCase()
                    ? cand.disambiguation
                    : null;
                return (
                  <div
                    key={cand.entityId}
                    className="flex flex-col justify-between gap-2.5 rounded-xl border border-cb-border bg-cb-card px-3.5 py-2.5 sm:flex-row sm:items-center"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-2 text-sm">
                        <span className="font-semibold text-foreground">
                          {cand.name}
                        </span>
                        {candDisambig && (
                          <span className="rounded-md bg-cb-surface px-2 py-0.5 text-xs font-medium text-cb-muted">
                            {candDisambig}
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
                      className="shrink-0 rounded-full bg-cb-accent px-4 py-1.5 text-xs font-semibold text-cb-accent-fg transition-colors hover:bg-cb-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent disabled:opacity-40"
                    >
                      Confirm match
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* No matches */}
      {anchor.status === "no_matches" && (
        <div role="status" className="mt-3 pl-0 sm:pl-9">
          <div className="flex flex-col justify-between gap-2 rounded-xl border border-cb-warning/30 bg-cb-warning-soft px-3.5 py-2.5 text-xs sm:flex-row sm:items-center">
            <p className="text-foreground/85">
              No matches found for &ldquo;{anchor.query}&rdquo; under{" "}
              {formatAnchorType(anchor.type).toLowerCase()}. Try editing the
              spelling or category.
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                disabled={disabled}
                onClick={openEdit}
                className="rounded-full border border-cb-border bg-cb-card px-3 py-1 font-medium text-foreground hover:bg-cb-surface"
              >
                Edit
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={onRemove}
                className="rounded-full border border-cb-error/30 bg-cb-card px-3 py-1 font-medium text-cb-error hover:bg-cb-error-soft"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lookup error */}
      {anchor.status === "lookup_error" && (
        <div role="alert" className="mt-3 pl-0 sm:pl-9">
          <div className="flex flex-col justify-between gap-2 rounded-xl border border-cb-error/30 bg-cb-error-soft px-3.5 py-2.5 text-xs sm:flex-row sm:items-center">
            <p className="text-foreground/85">
              {anchor.errorMessage ??
                "Search couldn't complete. Retry or edit this interest."}
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                disabled={disabled}
                onClick={onLookup}
                className="rounded-full border border-cb-border bg-cb-card px-3 py-1 font-medium text-foreground hover:bg-cb-surface"
              >
                Retry
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={openEdit}
                className="rounded-full border border-cb-border bg-cb-card px-3 py-1 font-medium text-foreground hover:bg-cb-surface"
              >
                Edit
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={onRemove}
                className="rounded-full border border-cb-error/30 bg-cb-card px-3 py-1 font-medium text-cb-error hover:bg-cb-error-soft"
              >
                Remove
              </button>
            </div>
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

  // Determine whether all recommendations share the exact same provenance label
  const distinctLabels = useMemo(() => {
    const set = new Set(completion.recommendations.map((r) => r.label));
    return [...set];
  }, [completion.recommendations]);
  const sharedSingleLabel =
    distinctLabels.length === 1 ? distinctLabels[0] : null;

  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);
  const [activeCategoryFilter, setActiveCategoryFilter] =
    useState<string>("__all__");
  const [mobilePane, setMobilePane] = useState<"list" | "map">("list");
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

  function handleShowOnMapFromCard(entityId: string) {
    setSelectedEntityId(entityId);
    setMobilePane("map");
  }

  function handleJumpToCard(entityId: string) {
    handleSelectFromMap(entityId);
    setMobilePane("list");
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
    <div className="space-y-6">
      {/* Editorial Guide Header */}
      <div className="border-b border-cb-border pb-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                Your {displayCity} guide
              </h1>
              {completion.status !== "success" && (
                <span
                  className={`rounded-full px-3 py-0.5 text-xs font-medium ${statusPresentation.badgeClassName}`}
                >
                  {statusPresentation.badgeText}
                </span>
              )}
            </div>

            <p className="max-w-2xl text-sm text-cb-muted sm:text-base">
              {completion.recommendations.length > 0 ? (
                <>
                  <strong className="font-semibold text-foreground">
                    {completion.recommendations.length}{" "}
                    {completion.recommendations.length === 1
                      ? "place"
                      : "places"}
                  </strong>{" "}
                  in {displayCity}
                  {confirmedAnchorsSummary.length > 0 && (
                    <>
                      {" "}
                      · Curated from{" "}
                      <span className="text-foreground/90">
                        {confirmedAnchorsSummary.join(", ")}
                      </span>
                    </>
                  )}
                </>
              ) : (
                completion.summary
              )}
            </p>
          </div>

          {/* Provenance summary — explained once when all recommendations share the same label */}
          {sharedSingleLabel && completion.recommendations.length > 0 && (
            <div className="inline-flex self-start items-center gap-2 rounded-full border border-cb-border bg-cb-card px-3.5 py-1.5 text-xs text-cb-muted sm:self-auto">
              <span
                className="font-semibold text-cb-accent"
                aria-hidden="true"
              >
                {LABEL_PRESENTATION[sharedSingleLabel].symbol}
              </span>
              <span className="font-medium text-foreground">
                {LABEL_PRESENTATION[sharedSingleLabel].badgeText}
              </span>
              <span aria-hidden="true">·</span>
              <span>{LABEL_PRESENTATION[sharedSingleLabel].shortTitle}</span>
            </div>
          )}
        </div>

        {/* Mixed-label legend — only shown when results contain multiple provenance types */}
        {!sharedSingleLabel && completion.recommendations.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-cb-muted">
            {(["connection", "useful-place", "exploratory"] as const).map(
              (labelKey) => {
                const info = LABEL_PRESENTATION[labelKey];
                const count = completion.recommendations.filter(
                  (r) => r.label === labelKey,
                ).length;
                if (count === 0) return null;
                return (
                  <span key={labelKey} className="flex items-center gap-1.5">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${info.badgeClassName}`}
                    >
                      <span aria-hidden="true">{info.symbol}</span>
                      {info.badgeText}
                    </span>
                    <span>
                      {info.shortTitle} ({count})
                    </span>
                  </span>
                );
              },
            )}
          </div>
        )}
      </div>

      {/* Partial or fallback notice */}
      {(completion.status === "partial" ||
        completion.mode === "deterministic") && (
        <div className="rounded-2xl border border-cb-border bg-cb-card px-4 py-3 text-sm text-cb-muted">
          {completion.status === "partial" && (
            <p>
              <strong className="font-semibold text-foreground">
                Partial results:
              </strong>{" "}
              {completion.filteredInvalidCount > 0
                ? `${completion.filteredInvalidCount} candidate${
                    completion.filteredInvalidCount === 1 ? " was" : "s were"
                  } excluded because ${
                    completion.filteredInvalidCount === 1 ? "it" : "they"
                  } didn't pass venue quality checks.`
                : "Only recommendations that passed every quality check are shown."}{" "}
              CultureBridge never pads results.
            </p>
          )}
          {completion.mode === "deterministic" && (
            <p>
              <strong className="font-semibold text-foreground">
                Direct taste-graph search:
              </strong>{" "}
              {completion.searchProcess.fallbackReason ??
                "Results were generated directly from Qloo taste data without AI synthesis."}
            </p>
          )}
        </div>
      )}

      {/* Expandable "How these suggestions were found" bar & drawer */}
      <AgentTraceDrawer
        process={completion.searchProcess}
        isOpen={isTraceOpen}
        onToggle={() => setIsTraceOpen((prev) => !prev)}
      />

      {/* Empty vs populated results */}
      {completion.recommendations.length === 0 ? (
        <div className="rounded-2xl border border-cb-border bg-cb-card p-8 text-center sm:p-12">
          <h2 className="text-xl font-semibold text-foreground">
            No places matched this combination
          </h2>
          <p className="mx-auto mt-2 max-w-lg text-sm text-cb-muted leading-relaxed">
            CultureBridge only shows places that pass venue quality screening.
            Check the search details above to see what was tried, or adjust your
            interests to explore a different angle of {displayCity}.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <button
              type="button"
              onClick={onEditAnchors}
              disabled={isGenerating}
              className="rounded-full bg-cb-accent px-5 py-2.5 text-sm font-semibold text-cb-accent-fg hover:bg-cb-accent-hover disabled:opacity-40"
            >
              Edit interests
            </button>
            <button
              type="button"
              disabled={isGenerating}
              onClick={onRegenerate}
              className="rounded-full border border-cb-border bg-background px-5 py-2.5 text-sm font-medium text-foreground hover:bg-cb-surface disabled:opacity-40"
            >
              Try again
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          {/* Toolbar: Mobile List/Map toggle + Category filters */}
          <div className="flex flex-col gap-3">
            {/* Mobile List / Map Switcher (< lg) */}
            <div className="flex items-center justify-between lg:hidden">
              <div
                role="group"
                aria-label="Mobile view mode"
                className="inline-flex rounded-full border border-cb-border bg-cb-surface p-1"
              >
                <button
                  type="button"
                  aria-pressed={mobilePane === "list"}
                  onClick={() => setMobilePane("list")}
                  className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${
                    mobilePane === "list"
                      ? "bg-cb-card text-foreground shadow-2xs"
                      : "text-cb-muted hover:text-foreground"
                  }`}
                >
                  List ({visibleItems.length})
                </button>
                <button
                  type="button"
                  aria-pressed={mobilePane === "map"}
                  onClick={() => setMobilePane("map")}
                  className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${
                    mobilePane === "map"
                      ? "bg-cb-card text-foreground shadow-2xs"
                      : "text-cb-muted hover:text-foreground"
                  }`}
                >
                  Map ({markers.length})
                </button>
              </div>
            </div>

            {/* Category filter pills — horizontal scroll on mobile, wrap on desktop */}
            {groups.length > 1 && (
              <nav
                aria-label="Filter by category"
                className="flex items-center gap-1.5 overflow-x-auto pb-1 lg:flex-wrap lg:overflow-visible lg:pb-0"
              >
                <button
                  type="button"
                  aria-pressed={activeCategoryFilter === "__all__"}
                  onClick={() => setActiveCategoryFilter("__all__")}
                  className={`shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent sm:text-sm ${
                    activeCategoryFilter === "__all__"
                      ? "border-foreground bg-foreground text-background"
                      : "border-cb-border bg-cb-card text-foreground hover:border-cb-border-strong hover:bg-cb-surface"
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
                      className={`shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent sm:text-sm ${
                        active
                          ? "border-foreground bg-foreground text-background"
                          : "border-cb-border bg-cb-card text-foreground hover:border-cb-border-strong hover:bg-cb-surface"
                      }`}
                    >
                      {group.title}{" "}
                      <span className="opacity-70">({group.items.length})</span>
                    </button>
                  );
                })}
              </nav>
            )}
          </div>

          {/* Integrated Split Layout: Recommendations List (Left 6 cols) + Sticky City Map (Right 6 cols) */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-start lg:gap-8">
            {/* Recommendation cards column */}
            <div
              className={`space-y-3.5 lg:col-span-6 ${
                mobilePane === "map" ? "hidden lg:block" : "block"
              }`}
            >
              {visibleItems.map((rec) => (
                <RecommendationCard
                  key={rec.entityId}
                  rec={rec}
                  pinOrderIndex={markerOrderById.get(rec.entityId) ?? null}
                  showLabelBadge={!sharedSingleLabel}
                  isSelected={selection.selectedEntityId === rec.entityId}
                  onSelect={() => setSelectedEntityId(rec.entityId)}
                  onShowOnMap={() => handleShowOnMapFromCard(rec.entityId)}
                />
              ))}
            </div>

            {/* Sticky map column */}
            <div
              className={`lg:col-span-6 lg:sticky lg:top-6 ${
                mobilePane === "list" ? "hidden lg:block" : "block"
              }`}
            >
              <ResultsMap
                city={displayCity}
                recommendations={completion.recommendations}
                selectedEntityId={selection.selectedEntityId}
                onSelectEntity={handleSelectFromMap}
                onJumpToCard={handleJumpToCard}
              />
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
  showLabelBadge: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onShowOnMap: () => void;
}

function RecommendationCard({
  rec,
  pinOrderIndex,
  showLabelBadge,
  isSelected,
  onSelect,
  onShowOnMap,
}: RecommendationCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const labelInfo = getLabelPresentation(rec.label);
  const categoryInfo = useMemo(() => describeCategoryEvidence(rec), [rec]);
  const provenance = useMemo(() => formatRecommendationProvenance(rec), [rec]);
  const practical = useMemo(() => buildPracticalDetailsView(rec), [rec]);

  const primaryCategory = categoryInfo.qlooCategories[0] ?? null;
  const secondaryCategories = categoryInfo.qlooCategories.slice(1);

  return (
    <article
      id={`rec-card-${rec.entityId}`}
      tabIndex={-1}
      aria-label={`${rec.name} — ${labelInfo.badgeText}`}
      className={`group rounded-2xl border p-5 transition-all focus:outline-none ${
        isSelected
          ? "border-cb-accent bg-cb-card shadow-[0_6px_24px_rgba(224,86,56,0.08)] ring-1 ring-cb-accent/30"
          : "border-cb-border bg-cb-card shadow-[0_2px_10px_rgba(35,34,30,0.025)] hover:border-cb-border-strong"
      }`}
    >
      <div className="flex items-start gap-3.5">
        {/* Editorial Numbered Pin */}
        {practical.mappable && pinOrderIndex !== null ? (
          <button
            type="button"
            onClick={onShowOnMap}
            title="Show on map"
            aria-label={`Pin ${pinOrderIndex}: Show ${rec.name} on map`}
            className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold transition-all ${
              isSelected
                ? "bg-cb-accent text-cb-accent-fg shadow-xs"
                : "border border-cb-border-strong bg-cb-surface/70 text-foreground hover:border-cb-accent hover:bg-cb-accent hover:text-cb-accent-fg"
            }`}
          >
            {pinOrderIndex}
          </button>
        ) : (
          <span
            title="Location coordinates not available"
            className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-cb-border text-xs text-cb-muted"
          >
            —
          </span>
        )}

        {/* Main Card Content */}
        <div className="min-w-0 flex-1">
          {/* Category + Neighborhood metadata line */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-cb-muted">
              {primaryCategory && (
                <span className="text-foreground/85">{primaryCategory}</span>
              )}
              {primaryCategory && practical.neighborhood && (
                <span aria-hidden="true">·</span>
              )}
              {practical.neighborhood && <span>{practical.neighborhood}</span>}
              {practical.priceTier && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{practical.priceTier}</span>
                </>
              )}
              {!primaryCategory && !practical.neighborhood && (
                <span>Place in catalog</span>
              )}
            </div>

            {showLabelBadge && (
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${labelInfo.badgeClassName}`}
              >
                <span aria-hidden="true">{labelInfo.symbol}</span>
                {labelInfo.badgeText}
              </span>
            )}
          </div>

          {/* Place Name */}
          <h3 className="mt-1 text-lg font-semibold tracking-tight text-foreground">
            <button
              type="button"
              onClick={onSelect}
              className="text-left hover:text-cb-accent focus:outline-none"
            >
              {rec.name}
            </button>
          </h3>

          {/* Address line */}
          {practical.address && (
            <p className="mt-0.5 text-xs text-cb-muted">{practical.address}</p>
          )}

          {/* Grounded Explanation */}
          <p className="mt-2.5 text-sm leading-relaxed text-foreground/85">
            {rec.explanationText}
          </p>

          {/* Card Footer Actions */}
          <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3 border-t border-cb-border/70 pt-3 text-xs">
            <div className="flex items-center gap-4">
              <button
                type="button"
                aria-expanded={isExpanded}
                onClick={() => setIsExpanded(!isExpanded)}
                className="inline-flex items-center gap-1 font-semibold text-foreground transition-colors hover:text-cb-accent"
              >
                <span>{isExpanded ? "Hide details" : "Details & why"}</span>
                <svg
                  className={`h-3.5 w-3.5 text-cb-muted transition-transform ${
                    isExpanded ? "rotate-180" : ""
                  }`}
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M4.22 6.22a.75.75 0 011.06 0L8 8.94l2.72-2.72a.75.75 0 111.06 1.06l-3.25 3.25a.75.75 0 01-1.06 0L4.22 7.28a.75.75 0 010-1.06z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>

              {practical.mappable && (
                <button
                  type="button"
                  onClick={onShowOnMap}
                  className={`font-medium transition-colors ${
                    isSelected
                      ? "text-cb-accent"
                      : "text-cb-muted hover:text-foreground"
                  }`}
                >
                  {isSelected ? "Highlighted on map" : "Locate on map"}
                </button>
              )}
            </div>

            {practical.websiteUrl && (
              <a
                href={practical.websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-medium text-cb-muted transition-colors hover:text-foreground"
              >
                <span>Visit website</span>
                <span aria-hidden="true">↗</span>
              </a>
            )}
          </div>

          {/* Expanded Details & Provenance Drawer */}
          {isExpanded && (
            <div className="mt-4 space-y-4 rounded-xl border border-cb-border bg-background/60 p-4 text-sm">
              {/* Practical details */}
              {practical.hasAnyPracticalDetail && (
                <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {practical.locationLine && (
                    <div>
                      <dt className="text-xs text-cb-muted">Location</dt>
                      <dd className="mt-0.5 text-xs font-medium text-foreground">
                        {practical.locationLine}
                      </dd>
                    </div>
                  )}
                  {practical.websiteUrl && practical.websiteDisplay && (
                    <div>
                      <dt className="text-xs text-cb-muted">Website</dt>
                      <dd className="mt-0.5 text-xs font-medium">
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
                      <dt className="text-xs text-cb-muted">Phone</dt>
                      <dd className="mt-0.5 text-xs font-medium text-foreground">
                        {practical.phone}
                      </dd>
                    </div>
                  )}
                  {practical.priceTier && (
                    <div>
                      <dt className="text-xs text-cb-muted">Price tier</dt>
                      <dd className="mt-0.5 text-xs font-medium text-foreground">
                        {practical.priceTier}
                      </dd>
                    </div>
                  )}
                </dl>
              )}

              {/* Additional categories & tags */}
              {secondaryCategories.length > 0 && (
                <div className="text-xs">
                  <span className="text-cb-muted">Additional categories: </span>
                  <span className="font-medium text-foreground">
                    {secondaryCategories.join(", ")}
                  </span>
                </div>
              )}

              {practical.supportingTags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {practical.supportingTags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full bg-cb-surface px-2.5 py-0.5 text-xs text-cb-muted"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              {/* Grounded provenance */}
              <div className="border-t border-cb-border pt-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-foreground">
                    How this place connected
                  </span>
                  <span className="rounded-full bg-cb-surface px-2.5 py-0.5 text-[11px] font-medium text-cb-muted">
                    {labelInfo.symbol} {labelInfo.badgeText}
                  </span>
                </div>
                <p className="mt-1 text-xs font-medium text-foreground/90">
                  {provenance.headline}
                </p>
                <p className="mt-0.5 text-xs text-cb-muted leading-relaxed">
                  {provenance.detail}
                </p>
                {provenance.honestyDisclaimer && (
                  <p className="mt-1.5 text-[11px] text-cb-muted">
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
