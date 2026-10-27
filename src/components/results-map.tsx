"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import {
  computeMapBounds,
  extractMapMarkers,
  getLabelPresentation,
  resolveSelectionState,
} from "@/lib/input";
import type { MapMarkerItem, SafeRecommendationItem } from "@/lib/input";

export interface ResultsMapProps {
  city: string;
  recommendations: readonly SafeRecommendationItem[];
  selectedEntityId: string | null;
  onSelectEntity: (entityId: string) => void;
  onJumpToCard?: (entityId: string) => void;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function createPinIcon(
  marker: MapMarkerItem,
  isSelected: boolean,
  showSymbol: boolean,
): L.DivIcon {
  const safeSymbol = escapeHtml(marker.symbol);
  const safeName = escapeHtml(marker.name);
  const safeBadge = escapeHtml(marker.badgeText);
  const labelClass = getLabelPresentation(marker.label).markerClassName;
  const innerHtml = showSymbol
    ? `<span aria-hidden="true">${safeSymbol}</span><span>${marker.orderIndex}</span>`
    : `<span>${marker.orderIndex}</span>`;

  return L.divIcon({
    className: "cb-map-pin-wrapper",
    html: `<span class="cb-map-pin ${labelClass}" data-selected="${isSelected ? "true" : "false"}" title="${safeName} (${safeBadge})" aria-label="${marker.orderIndex}. ${safeName} (${safeBadge})">${innerHtml}</span>`,
    iconSize: showSymbol ? [38, 30] : [30, 30],
    iconAnchor: showSymbol ? [19, 15] : [15, 15],
  });
}

export default function ResultsMap({
  city,
  recommendations,
  selectedEntityId,
  onSelectEntity,
  onJumpToCard,
}: ResultsMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersLayerRef = useRef<Map<string, L.Marker>>(new Map());
  const prevSelectedIdRef = useRef<string | null>(selectedEntityId);
  const lastFittedWidthRef = useRef<number>(0);
  const onSelectRef = useRef(onSelectEntity);

  useEffect(() => {
    onSelectRef.current = onSelectEntity;
  }, [onSelectEntity]);

  const markers = useMemo(
    () => extractMapMarkers(recommendations),
    [recommendations],
  );
  const viewport = useMemo(() => computeMapBounds(markers), [markers]);
  const selection = useMemo(
    () => resolveSelectionState(recommendations, selectedEntityId),
    [recommendations, selectedEntityId],
  );

  const hasMixedLabels = useMemo(() => {
    const distinct = new Set(markers.map((m) => m.label));
    return distinct.size > 1;
  }, [markers]);

  const fitAllMarkers = useCallback(
    (animate: boolean = true) => {
      const map = mapRef.current;
      if (!map || viewport.mode === "empty") return;
      if (viewport.mode === "single") {
        map.setView([viewport.center.lat, viewport.center.lon], viewport.zoom, {
          animate,
        });
      } else {
        const bounds = L.latLngBounds(
          [viewport.southWest.lat, viewport.southWest.lon],
          [viewport.northEast.lat, viewport.northEast.lon],
        );
        map.fitBounds(bounds, { padding: [36, 36], maxZoom: 15, animate });
      }
    },
    [viewport],
  );

  // Initialize & update Leaflet map when mappable markers change
  useEffect(() => {
    if (typeof window === "undefined") return;
    const container = containerRef.current;
    if (!container) return;

    if (markers.length === 0) {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        markersLayerRef.current.clear();
      }
      return;
    }

    if (!mapRef.current) {
      const map = L.map(container, {
        zoomControl: true,
        attributionControl: true,
        scrollWheelZoom: false,
      });

      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
      }).addTo(map);

      mapRef.current = map;
      lastFittedWidthRef.current = 0;
    }

    const map = mapRef.current;
    const layerMap = markersLayerRef.current;

    for (const existingMarker of layerMap.values()) {
      existingMarker.remove();
    }
    layerMap.clear();

    for (const item of markers) {
      const isSelected = item.entityId === selectedEntityId;
      const leafletMarker = L.marker([item.lat, item.lon], {
        icon: createPinIcon(item, isSelected, hasMixedLabels),
        keyboard: true,
        title: `${item.orderIndex}. ${item.name} (${item.badgeText})`,
        alt: `${item.name} — ${item.badgeText}`,
      });

      leafletMarker.on("click", () => {
        onSelectRef.current(item.entityId);
      });

      leafletMarker.addTo(map);
      layerMap.set(item.entityId, leafletMarker);
    }

    if (container.clientWidth > 0 && container.clientHeight > 0) {
      map.invalidateSize({ animate: false });
      fitAllMarkers(false);
      lastFittedWidthRef.current = container.clientWidth;
    } else {
      lastFittedWidthRef.current = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markers, viewport, hasMixedLabels]);

  // Synchronize marker icons and map focus when selectedEntityId changes
  useEffect(() => {
    const map = mapRef.current;
    const layerMap = markersLayerRef.current;
    if (!map || layerMap.size === 0) return;

    for (const item of markers) {
      const leafletMarker = layerMap.get(item.entityId);
      if (!leafletMarker) continue;
      const isSelected = item.entityId === selectedEntityId;
      leafletMarker.setIcon(createPinIcon(item, isSelected, hasMixedLabels));
      leafletMarker.setZIndexOffset(isSelected ? 1000 : 0);
    }

    const didSelectionChange = prevSelectedIdRef.current !== selectedEntityId;
    prevSelectedIdRef.current = selectedEntityId;

    if (didSelectionChange && selectedEntityId) {
      const targetMarker = markers.find((m) => m.entityId === selectedEntityId);
      if (targetMarker) {
        const container = containerRef.current;
        if (container && container.clientWidth > 0) {
          map.invalidateSize({ animate: false });
          const currentZoom = map.getZoom();
          const targetZoom =
            typeof currentZoom === "number" &&
            currentZoom >= 13 &&
            currentZoom <= 16
              ? currentZoom
              : 14;
          map.setView([targetMarker.lat, targetMarker.lon], targetZoom, {
            animate: true,
          });
        }
      }
    }
  }, [selectedEntityId, markers, hasMixedLabels]);

  // ResizeObserver so mobile List/Map tab toggles or viewport changes always render tiles and fit bounds properly
  useEffect(() => {
    if (typeof window === "undefined" || typeof ResizeObserver === "undefined") {
      return;
    }
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || !mapRef.current) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        const map = mapRef.current;
        map.invalidateSize({ animate: false });
        if (Math.abs(width - lastFittedWidthRef.current) > 24) {
          lastFittedWidthRef.current = width;
          const activeMarker = selectedEntityId
            ? markers.find((m) => m.entityId === selectedEntityId)
            : null;
          if (activeMarker) {
            map.setView([activeMarker.lat, activeMarker.lon], 14, {
              animate: false,
            });
          } else {
            fitAllMarkers(false);
          }
        }
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [fitAllMarkers, markers, selectedEntityId]);

  // Clean up Leaflet instance on unmount
  useEffect(() => {
    const layerMap = markersLayerRef.current;
    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      layerMap.clear();
    };
  }, []);

  // Empty state
  if (markers.length === 0) {
    return (
      <div
        role="region"
        aria-label={`${city || "Destination"} map`}
        className="rounded-2xl border border-cb-border bg-cb-card p-6"
      >
        <h4 className="text-sm font-semibold text-foreground">
          {city || "Destination"} map
        </h4>
        <p className="mt-1.5 text-sm text-cb-muted leading-relaxed">
          {recommendations.length === 0
            ? "No places to show on the map."
            : `None of the ${recommendations.length} ${
                recommendations.length === 1 ? "place" : "places"
              } included map coordinates in Qloo's catalog. All places remain available in the list.`}
        </p>
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label={`${city || "Destination"} map`}
      className="overflow-hidden rounded-2xl border border-cb-border bg-cb-card shadow-[0_2px_16px_rgba(35,34,30,0.04)]"
    >
      {/* Map header */}
      <div className="flex items-center justify-between border-b border-cb-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-semibold text-foreground">{city} map</span>
          <span className="text-cb-border-strong" aria-hidden="true">
            ·
          </span>
          <span className="text-xs text-cb-muted">
            {markers.length === recommendations.length
              ? `${markers.length} ${markers.length === 1 ? "place" : "places"} mapped`
              : `${markers.length} of ${recommendations.length} mapped`}
          </span>
        </div>

        {markers.length > 1 && (
          <button
            type="button"
            onClick={() => fitAllMarkers(true)}
            className="rounded-full border border-cb-border bg-background px-3 py-1 text-xs font-medium text-foreground transition-colors hover:border-cb-border-strong hover:bg-cb-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent"
          >
            Fit all pins
          </button>
        )}
      </div>

      {/* Map canvas */}
      <div
        ref={containerRef}
        className="cb-leaflet-container h-80 w-full sm:h-96 lg:h-[calc(100vh-11rem)] lg:min-h-[500px] lg:max-h-[700px]"
      />

      {/* Compact pin bar & active place spotlight */}
      <div className="border-t border-cb-border bg-background/60 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-cb-muted">Pins</span>
          <div
            role="group"
            aria-label="Map pins"
            className="flex flex-wrap items-center gap-1.5"
          >
            {markers.map((marker) => {
              const isSelected = marker.entityId === selectedEntityId;
              return (
                <button
                  key={marker.entityId}
                  type="button"
                  aria-pressed={isSelected}
                  title={`${marker.orderIndex}. ${marker.name}`}
                  aria-label={`${marker.orderIndex}. ${marker.name}`}
                  onClick={() => onSelectEntity(marker.entityId)}
                  className={`inline-flex h-7 min-w-7 items-center justify-center rounded-full border px-2 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent ${
                    isSelected
                      ? "border-cb-accent bg-cb-accent text-cb-accent-fg shadow-xs"
                      : "border-cb-border bg-cb-card text-foreground hover:border-cb-accent/50 hover:bg-cb-surface"
                  }`}
                >
                  {marker.orderIndex}
                </button>
              );
            })}
          </div>
        </div>

        {/* Selected place spotlight */}
        {selection.selectedRecommendation && (
          <div
            role="status"
            aria-live="polite"
            className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-cb-border bg-cb-card px-3.5 py-2.5 text-sm shadow-2xs"
          >
            {selection.selectedMarker ? (
              <div className="flex min-w-0 items-center gap-2.5">
                <span
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-cb-accent text-xs font-bold text-cb-accent-fg"
                  aria-hidden="true"
                >
                  {selection.selectedMarker.orderIndex}
                </span>
                <div className="min-w-0">
                  <p className="truncate font-semibold text-foreground">
                    {selection.selectedMarker.name}
                  </p>
                  {selection.selectedMarker.locationLine && (
                    <p className="truncate text-xs text-cb-muted">
                      {selection.selectedMarker.locationLine}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="min-w-0">
                <p className="truncate font-semibold text-foreground">
                  {selection.selectedRecommendation.name}
                </p>
                <p className="text-xs text-cb-muted">
                  Not on map — no coordinates in catalog
                </p>
              </div>
            )}

            {onJumpToCard && (
              <button
                type="button"
                onClick={() =>
                  onJumpToCard(selection.selectedRecommendation!.entityId)
                }
                className="shrink-0 rounded-full border border-cb-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-cb-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent"
              >
                Show in list
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
