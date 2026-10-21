import { KitRequestSchema } from "../api/kit-handler";
import type { KitRequest } from "../api/kit-handler";
import type {
  AnchorCandidate,
  AnchorSearchResponse,
} from "../api/anchor-search-handler";
import { StructuredOutputSchema } from "../output/schema";
import type { RecommendationLabel } from "../recommend";
import {
  DEFAULT_CITY,
  DEFAULT_PRESET_ID,
  MAX_TRUSTED_ANCHORS,
  CitySelectionSchema,
  getPresetById,
  isSupportedAnchorType,
} from "./presets";
import type { PresetId, SupportedAnchorType } from "./presets";

// ── Types ────────────────────────────────────────────────────

export type AnchorItemStatus =
  | "unsearched"
  | "searching"
  | "candidates"
  | "confirmed"
  | "no_matches"
  | "lookup_error";

export interface AnchorItem {
  id: string;
  query: string;
  type: SupportedAnchorType;
  status: AnchorItemStatus;
  resolutionStatus: "resolved" | "ambiguous" | "not_found" | null;
  candidates: AnchorCandidate[];
  confirmedEntity: AnchorCandidate | null;
  errorMessage: string | null;
  isEditing: boolean;
}

export interface SafeRecommendationItem {
  entityId: string;
  name: string;
  label: RecommendationLabel;
  categories: string[];
  neighborhood: string | null;
  address: string | null;
  website: string | null;
  phone: string | null;
  priceLevel: number | null;
  explanationText: string;
  anchorNames: string[];
}

export interface SafeKitCompletion {
  status: "success" | "partial" | "empty";
  summary: string;
  city: string;
  mode: "agent" | "deterministic";
  cached: boolean;
  recommendations: SafeRecommendationItem[];
}

export interface GenerationState {
  status: "idle" | "loading" | "success" | "partial" | "empty" | "error";
  result: SafeKitCompletion | null;
  errorMessage: string | null;
}

export type FlowPhase =
  | "initial_profile"
  | "editing_anchors"
  | "searching_matches"
  | "waiting_for_confirmation"
  | "lookup_failure"
  | "ready_to_generate"
  | "generating"
  | "success"
  | "empty_recommendations"
  | "generation_error";

export interface FlowState {
  selectedPresetId: PresetId;
  city: string;
  anchors: AnchorItem[];
  hasEditedAnchors: boolean;
  nextAnchorSeq: number;
  generation: GenerationState;
}

export type FlowTransitionResult =
  | { ok: true; state: FlowState }
  | { ok: false; state: FlowState; error: string };

// ── Error & response sanitization ────────────────────────────

const SENSITIVE_PATTERN =
  /api.?key|secret|credential|token|password|authorization|bearer|qloo_api_key|aws_access_key|aws_secret|sk-[a-z0-9]/i;

const INTERNAL_LEAK_PATTERN =
  /hackathon\.api\.qloo\.com|\/v2\/insights|toolCallCount|qlooOutboundRequests|finalization|at\s+\w+\s*\(/i;

export function sanitizeUiError(
  raw: unknown,
  fallback: string = "Something went wrong. Please try again.",
): string {
  const msg =
    typeof raw === "string"
      ? raw.trim()
      : raw instanceof Error
        ? raw.message.trim()
        : "";

  if (!msg) return fallback;
  if (SENSITIVE_PATTERN.test(msg)) {
    return "Service configuration error. Please try again later.";
  }
  if (INTERNAL_LEAK_PATTERN.test(msg)) {
    return fallback;
  }
  if (/abort|timed?\s*out|deadline/i.test(msg)) {
    return "The request timed out before completion. Your selections are saved — please retry.";
  }
  return msg.slice(0, 200);
}

// ── Initialization & Preset/City transitions ─────────────────

export function createInitialFlowState(
  presetId: PresetId = DEFAULT_PRESET_ID,
  city: string = DEFAULT_CITY,
): FlowState {
  const preset = getPresetById(presetId);
  const validCity = CitySelectionSchema.safeParse(city);
  const resolvedCity = validCity.success ? validCity.data : DEFAULT_CITY;

  const anchors: AnchorItem[] = preset.anchors.map((seed, idx) => ({
    id: `anchor-${idx + 1}`,
    query: seed.query,
    type: seed.type,
    status: "unsearched",
    resolutionStatus: null,
    candidates: [],
    confirmedEntity: null,
    errorMessage: null,
    isEditing: false,
  }));

  return {
    selectedPresetId: preset.id,
    city: resolvedCity,
    anchors,
    hasEditedAnchors: false,
    nextAnchorSeq: anchors.length + 1,
    generation: {
      status: "idle",
      result: null,
      errorMessage: null,
    },
  };
}

export function selectPreset(
  state: FlowState,
  presetId: PresetId,
): FlowTransitionResult {
  if (state.generation.status === "loading") {
    return {
      ok: false,
      state,
      error: "Cannot change profile while generating your kit.",
    };
  }

  const preset = getPresetById(presetId);
  let seq = state.nextAnchorSeq;
  const anchors: AnchorItem[] = preset.anchors.map((seed) => ({
    id: `anchor-${seq++}`,
    query: seed.query,
    type: seed.type,
    status: "unsearched",
    resolutionStatus: null,
    candidates: [],
    confirmedEntity: null,
    errorMessage: null,
    isEditing: false,
  }));

  // Preserve the user's selected city — never change destination silently
  return {
    ok: true,
    state: {
      ...state,
      selectedPresetId: preset.id,
      anchors,
      hasEditedAnchors: false,
      nextAnchorSeq: seq,
      generation: {
        status: "idle",
        result: null,
        errorMessage: null,
      },
    },
  };
}

export function selectCity(
  state: FlowState,
  city: string,
): FlowTransitionResult {
  if (state.generation.status === "loading") {
    return {
      ok: false,
      state,
      error: "Cannot change destination city while generating your kit.",
    };
  }

  const parsed = CitySelectionSchema.safeParse(city);
  if (!parsed.success) {
    return {
      ok: false,
      state,
      error: parsed.error.issues[0]?.message ?? "Invalid city selection.",
    };
  }

  if (parsed.data === state.city) {
    return { ok: true, state };
  }

  return {
    ok: true,
    state: {
      ...state,
      city: parsed.data,
      generation: {
        status: "idle",
        result: null,
        errorMessage: null,
      },
    },
  };
}

// ── Anchor CRUD & Duplicate Prevention ───────────────────────

function normalizeAnchorKey(query: string, type: string): string {
  return JSON.stringify([query.toLowerCase().trim(), type.trim()]);
}

export function addAnchor(
  state: FlowState,
  query: string,
  type: string,
): FlowTransitionResult {
  if (state.generation.status === "loading") {
    return {
      ok: false,
      state,
      error: "Cannot modify anchors while generating your kit.",
    };
  }

  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) {
    return { ok: false, state, error: "Enter an anchor name to search." };
  }
  if (trimmedQuery.length > 200) {
    return {
      ok: false,
      state,
      error: "Anchor name must be 200 characters or fewer.",
    };
  }
  if (!isSupportedAnchorType(type)) {
    return { ok: false, state, error: "Choose a valid entity type." };
  }
  if (state.anchors.length >= MAX_TRUSTED_ANCHORS) {
    return {
      ok: false,
      state,
      error: `You can include up to ${MAX_TRUSTED_ANCHORS} cultural anchors.`,
    };
  }

  const candidateKey = normalizeAnchorKey(trimmedQuery, type);
  const isDuplicate = state.anchors.some(
    (a) => normalizeAnchorKey(a.query, a.type) === candidateKey,
  );
  if (isDuplicate) {
    return {
      ok: false,
      state,
      error: "This anchor and type are already in your profile.",
    };
  }

  const newItem: AnchorItem = {
    id: `anchor-${state.nextAnchorSeq}`,
    query: trimmedQuery,
    type,
    status: "unsearched",
    resolutionStatus: null,
    candidates: [],
    confirmedEntity: null,
    errorMessage: null,
    isEditing: false,
  };

  return {
    ok: true,
    state: {
      ...state,
      anchors: [...state.anchors, newItem],
      hasEditedAnchors: true,
      nextAnchorSeq: state.nextAnchorSeq + 1,
      generation: {
        status: "idle",
        result: null,
        errorMessage: null,
      },
    },
  };
}

export function setAnchorEditing(
  state: FlowState,
  anchorId: string,
  isEditing: boolean,
): FlowState {
  if (state.generation.status === "loading") return state;
  return {
    ...state,
    anchors: state.anchors.map((a) =>
      a.id === anchorId ? { ...a, isEditing, errorMessage: null } : a,
    ),
  };
}

export function updateAnchor(
  state: FlowState,
  anchorId: string,
  query: string,
  type: string,
): FlowTransitionResult {
  if (state.generation.status === "loading") {
    return {
      ok: false,
      state,
      error: "Cannot edit anchors while generating your kit.",
    };
  }

  const target = state.anchors.find((a) => a.id === anchorId);
  if (!target) {
    return { ok: false, state, error: "Anchor not found." };
  }

  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) {
    return { ok: false, state, error: "Anchor query cannot be empty." };
  }
  if (trimmedQuery.length > 200) {
    return {
      ok: false,
      state,
      error: "Anchor query must be 200 characters or fewer.",
    };
  }
  if (!isSupportedAnchorType(type)) {
    return { ok: false, state, error: "Choose a valid entity type." };
  }

  const newKey = normalizeAnchorKey(trimmedQuery, type);
  const duplicateOther = state.anchors.some(
    (a) => a.id !== anchorId && normalizeAnchorKey(a.query, a.type) === newKey,
  );
  if (duplicateOther) {
    return {
      ok: false,
      state,
      error: "Another anchor already uses this query and type.",
    };
  }

  const changed =
    target.query.trim().toLowerCase() !== trimmedQuery.toLowerCase() ||
    target.type !== type;

  const updatedAnchors = state.anchors.map((a): AnchorItem => {
    if (a.id !== anchorId) return a;
    if (!changed) {
      return { ...a, query: trimmedQuery, isEditing: false };
    }
    // Reset confirmation and candidates whenever query or type changes
    return {
      ...a,
      query: trimmedQuery,
      type,
      status: "unsearched",
      resolutionStatus: null,
      candidates: [],
      confirmedEntity: null,
      errorMessage: null,
      isEditing: false,
    };
  });

  return {
    ok: true,
    state: {
      ...state,
      anchors: updatedAnchors,
      hasEditedAnchors: true,
      generation: changed
        ? { status: "idle", result: null, errorMessage: null }
        : state.generation,
    },
  };
}

export function removeAnchor(
  state: FlowState,
  anchorId: string,
): FlowTransitionResult {
  if (state.generation.status === "loading") {
    return {
      ok: false,
      state,
      error: "Cannot remove anchors while generating your kit.",
    };
  }

  const filtered = state.anchors.filter((a) => a.id !== anchorId);
  if (filtered.length === state.anchors.length) {
    return { ok: false, state, error: "Anchor not found." };
  }

  return {
    ok: true,
    state: {
      ...state,
      anchors: filtered,
      hasEditedAnchors: true,
      generation: {
        status: "idle",
        result: null,
        errorMessage: null,
      },
    },
  };
}

// ── Lookup & Explicit Entity Confirmation ────────────────────

export function startAnchorLookup(
  state: FlowState,
  anchorId: string,
): FlowState {
  return {
    ...state,
    anchors: state.anchors.map((a) =>
      a.id === anchorId
        ? {
            ...a,
            status: "searching",
            resolutionStatus: null,
            candidates: [],
            confirmedEntity: null,
            errorMessage: null,
            isEditing: false,
          }
        : a,
    ),
  };
}

export function applyAnchorLookupResult(
  state: FlowState,
  anchorId: string,
  response: AnchorSearchResponse,
): FlowState {
  return {
    ...state,
    anchors: state.anchors.map((a): AnchorItem => {
      if (a.id !== anchorId) return a;

      // Ignore stale lookup responses if the anchor query/type was modified while in flight
      if (
        response.query &&
        response.requestedType &&
        (a.query.trim().toLowerCase() !== response.query.trim().toLowerCase() ||
          a.type !== response.requestedType)
      ) {
        return a;
      }

      if (response.status === "error") {
        return {
          ...a,
          status: "lookup_error",
          resolutionStatus: "not_found",
          candidates: [],
          confirmedEntity: null,
          errorMessage: sanitizeUiError(
            response.error?.message,
            "Unable to search Qloo entities right now. Please try again.",
          ),
        };
      }

      if (
        response.status === "no_matches" ||
        response.candidates.length === 0
      ) {
        return {
          ...a,
          status: "no_matches",
          resolutionStatus: "not_found",
          candidates: [],
          confirmedEntity: null,
          errorMessage: null,
        };
      }

      // Never automatically confirm the first candidate merely because it appears first.
      // Always place candidates in "candidates" status for explicit user confirmation.
      return {
        ...a,
        status: "candidates",
        resolutionStatus: response.resolutionStatus,
        candidates: response.candidates,
        confirmedEntity: null,
        errorMessage: null,
      };
    }),
  };
}

export function applyAnchorLookupFailure(
  state: FlowState,
  anchorId: string,
  error: unknown,
): FlowState {
  return {
    ...state,
    anchors: state.anchors.map((a): AnchorItem =>
      a.id === anchorId
        ? {
            ...a,
            status: "lookup_error",
            resolutionStatus: "not_found",
            candidates: [],
            confirmedEntity: null,
            errorMessage: sanitizeUiError(
              error,
              "Unable to search Qloo entities right now. Please try again.",
            ),
          }
        : a,
    ),
  };
}

export function confirmAnchorCandidate(
  state: FlowState,
  anchorId: string,
  entityId: string,
): FlowTransitionResult {
  if (state.generation.status === "loading") {
    return {
      ok: false,
      state,
      error: "Cannot change confirmations while generating your kit.",
    };
  }

  const target = state.anchors.find((a) => a.id === anchorId);
  if (!target) {
    return { ok: false, state, error: "Anchor not found." };
  }

  if (target.status !== "candidates" && target.status !== "confirmed") {
    return {
      ok: false,
      state,
      error: "Search for matching candidates before confirming an entity.",
    };
  }

  const candidate = target.candidates.find((c) => c.entityId === entityId);
  if (!candidate) {
    return {
      ok: false,
      state,
      error: "Selected candidate is not in the lookup results for this anchor.",
    };
  }

  if (!candidate.types.includes(target.type)) {
    return {
      ok: false,
      state,
      error: "Selected candidate does not match the requested entity type.",
    };
  }

  const duplicateEntity = state.anchors.some(
    (a) =>
      a.id !== anchorId &&
      a.status === "confirmed" &&
      a.confirmedEntity?.entityId === entityId,
  );
  if (duplicateEntity) {
    return {
      ok: false,
      state,
      error: "This Qloo entity is already confirmed in another anchor slot.",
    };
  }

  return {
    ok: true,
    state: {
      ...state,
      anchors: state.anchors.map((a) =>
        a.id === anchorId
          ? {
              ...a,
              status: "confirmed",
              confirmedEntity: candidate,
              errorMessage: null,
              isEditing: false,
            }
          : a,
      ),
      generation: {
        status: "idle",
        result: null,
        errorMessage: null,
      },
    },
  };
}

export function unconfirmAnchor(
  state: FlowState,
  anchorId: string,
): FlowTransitionResult {
  if (state.generation.status === "loading") {
    return {
      ok: false,
      state,
      error: "Cannot change confirmations while generating your kit.",
    };
  }

  const target = state.anchors.find((a) => a.id === anchorId);
  if (!target) {
    return { ok: false, state, error: "Anchor not found." };
  }

  return {
    ok: true,
    state: {
      ...state,
      anchors: state.anchors.map((a) =>
        a.id === anchorId
          ? {
              ...a,
              status: a.candidates.length > 0 ? "candidates" : "unsearched",
              confirmedEntity: null,
              errorMessage: null,
            }
          : a,
      ),
      generation: {
        status: "idle",
        result: null,
        errorMessage: null,
      },
    },
  };
}

// ── Readiness & `/api/kit` Payload Construction ──────────────

export function canGenerateKit(state: FlowState): boolean {
  if (state.generation.status === "loading") return false;
  if (!CitySelectionSchema.safeParse(state.city).success) return false;
  if (
    state.anchors.length === 0 ||
    state.anchors.length > MAX_TRUSTED_ANCHORS
  ) {
    return false;
  }

  // Every active anchor in the profile must be explicitly confirmed and not mid-edit
  return state.anchors.every(
    (a) =>
      a.status === "confirmed" &&
      a.confirmedEntity !== null &&
      !a.isEditing &&
      a.confirmedEntity.types.includes(a.type),
  );
}

export function buildKitRequestPayload(state: FlowState): KitRequest | null {
  if (!canGenerateKit(state)) return null;

  const confirmedAnchors = state.anchors.filter(
    (a): a is AnchorItem & { confirmedEntity: AnchorCandidate } =>
      a.status === "confirmed" && a.confirmedEntity !== null && !a.isEditing,
  );

  if (
    confirmedAnchors.length === 0 ||
    confirmedAnchors.length > MAX_TRUSTED_ANCHORS
  ) {
    return null;
  }

  const payload: KitRequest = {
    city: state.city.trim(),
    anchors: confirmedAnchors.map((a) => ({
      query: a.query.trim(),
      type: a.type,
    })),
    confirmedAnchors: confirmedAnchors.map((a) => ({
      entityId: a.confirmedEntity.entityId,
      name: a.confirmedEntity.name,
      query: a.query.trim(),
      type: a.type,
    })),
  };

  const validated = KitRequestSchema.safeParse(payload);
  return validated.success ? validated.data : null;
}

// ── Flow Phase Derivation ────────────────────────────────────

export function deriveFlowPhase(state: FlowState): FlowPhase {
  if (state.generation.status === "loading") {
    return "generating";
  }
  if (state.generation.status === "error") {
    return "generation_error";
  }
  if (state.generation.status === "empty") {
    return "empty_recommendations";
  }
  if (
    state.generation.status === "success" ||
    state.generation.status === "partial"
  ) {
    return "success";
  }

  if (state.anchors.some((a) => a.status === "searching")) {
    return "searching_matches";
  }

  if (
    state.anchors.some(
      (a) => a.status === "lookup_error" || a.status === "no_matches",
    )
  ) {
    return "lookup_failure";
  }

  if (state.anchors.some((a) => a.status === "candidates")) {
    return "waiting_for_confirmation";
  }

  if (canGenerateKit(state)) {
    return "ready_to_generate";
  }

  if (
    !state.hasEditedAnchors &&
    state.selectedPresetId !== "custom" &&
    state.anchors.length > 0 &&
    state.anchors.every((a) => a.status === "unsearched" && !a.isEditing)
  ) {
    return "initial_profile";
  }

  return "editing_anchors";
}

// ── Generation Lifecycle & Response Sanitization ─────────────

export function startKitGeneration(state: FlowState): FlowTransitionResult {
  if (state.generation.status === "loading") {
    return {
      ok: false,
      state,
      error: "A Cultural Starter Kit request is already in progress.",
    };
  }

  if (!canGenerateKit(state)) {
    return {
      ok: false,
      state,
      error:
        "Confirm all cultural anchors in your profile before generating a kit.",
    };
  }

  return {
    ok: true,
    state: {
      ...state,
      generation: {
        status: "loading",
        result: null,
        errorMessage: null,
      },
    },
  };
}

function sanitizeWebsiteUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

export function parseSafeKitResponse(
  raw: unknown,
  httpStatus: number,
):
  | { ok: true; completion: SafeKitCompletion }
  | { ok: false; errorMessage: string } {
  if (typeof raw !== "object" || raw === null) {
    return {
      ok: false,
      errorMessage: "Received an invalid response from the server.",
    };
  }

  const obj = raw as Record<string, unknown>;

  if (httpStatus >= 400 || obj.status === "error" || !obj.output) {
    const errObj =
      typeof obj.error === "object" && obj.error !== null
        ? (obj.error as Record<string, unknown>)
        : null;
    const rawMsg =
      typeof errObj?.message === "string"
        ? errObj.message
        : httpStatus === 429
          ? "Too many requests. Please wait a moment and try again."
          : httpStatus === 504
            ? "Request timed out while building your kit. Please retry."
            : "Could not generate your Cultural Starter Kit. Please retry.";

    return {
      ok: false,
      errorMessage: sanitizeUiError(rawMsg),
    };
  }

  const parsedOutput = StructuredOutputSchema.safeParse(obj.output);
  if (!parsedOutput.success) {
    return {
      ok: false,
      errorMessage: "Received an unexpected output format from the server.",
    };
  }

  const output = parsedOutput.data;
  const metaObj =
    typeof obj.meta === "object" && obj.meta !== null
      ? (obj.meta as Record<string, unknown>)
      : {};

  const city =
    typeof metaObj.city === "string" && metaObj.city.trim().length > 0
      ? metaObj.city.trim()
      : "";
  const mode = metaObj.mode === "deterministic" ? "deterministic" : "agent";
  const cached = Boolean(metaObj.cached);

  // Only include recommendations with verified explanations; strip any internal data
  const recommendations: SafeRecommendationItem[] = output.recommendations
    .filter((rec) => rec.explanation.verified)
    .map((rec) => ({
      entityId: rec.entityId,
      name: rec.name,
      label: rec.label,
      categories: rec.categories,
      neighborhood: rec.details.neighborhood,
      address: rec.details.address,
      website: sanitizeWebsiteUrl(rec.details.website),
      phone: rec.details.phone,
      priceLevel: rec.details.priceLevel,
      explanationText: rec.explanation.text,
      anchorNames: rec.explanation.basis.anchorNames,
    }));

  const effectiveStatus: "success" | "partial" | "empty" =
    recommendations.length === 0
      ? "empty"
      : output.status === "partial"
        ? "partial"
        : "success";

  const safeSummary =
    SENSITIVE_PATTERN.test(output.summary) ||
    INTERNAL_LEAK_PATTERN.test(output.summary) ||
    /\d+\s*%|confidence/i.test(output.summary)
      ? effectiveStatus === "empty"
        ? `No verified recommendations found for ${city || "this destination"}.`
        : `Found ${recommendations.length} verified recommendation${recommendations.length === 1 ? "" : "s"}${city ? ` in ${city}` : ""}.`
      : output.summary;

  return {
    ok: true,
    completion: {
      status: effectiveStatus,
      summary: safeSummary,
      city,
      mode,
      cached,
      recommendations,
    },
  };
}

export function applyKitGenerationResponse(
  state: FlowState,
  raw: unknown,
  httpStatus: number,
): FlowState {
  const parsed = parseSafeKitResponse(raw, httpStatus);
  if (!parsed.ok) {
    // Preserve profile, city, and confirmed anchors on error so the user can retry
    return {
      ...state,
      generation: {
        status: "error",
        result: null,
        errorMessage: parsed.errorMessage,
      },
    };
  }

  return {
    ...state,
    generation: {
      status: parsed.completion.status,
      result: parsed.completion,
      errorMessage: null,
    },
  };
}

export function applyKitGenerationError(
  state: FlowState,
  error: unknown,
): FlowState {
  return {
    ...state,
    generation: {
      status: "error",
      result: null,
      errorMessage: sanitizeUiError(
        error,
        "Unable to reach the server. Your anchors are saved — please retry.",
      ),
    },
  };
}

// ── Duplicate-safe Submission Controller ─────────────────────

export interface KitSubmissionController {
  isSubmitting: () => boolean;
  submit: (
    getState: () => FlowState,
    setState: (updater: (prev: FlowState) => FlowState) => void,
  ) => Promise<boolean>;
}

export function createKitSubmissionController(
  sendRequest: (
    payload: KitRequest,
  ) => Promise<{ body: unknown; httpStatus: number }>,
): KitSubmissionController {
  let active = false;

  return {
    isSubmitting: () => active,
    submit: async (getState, setState) => {
      if (active) return false;

      const currentState = getState();
      const payload = buildKitRequestPayload(currentState);
      if (!payload) return false;

      const started = startKitGeneration(currentState);
      if (!started.ok) return false;

      active = true;
      setState(() => started.state);

      try {
        const { body, httpStatus } = await sendRequest(payload);
        setState((prev) => applyKitGenerationResponse(prev, body, httpStatus));
        return true;
      } catch (err) {
        setState((prev) => applyKitGenerationError(prev, err));
        return true;
      } finally {
        active = false;
      }
    },
  };
}
