"use client";

import { useEffect, useMemo, useRef } from "react";
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

function createPinIcon(marker: MapMarkerItem, isSelected: boolean): L.DivIcon {
  const safeSymbol = escapeHtml(marker.symbol);
  const safeName = escapeHtml(marker.name);
  const safeBadge = escapeHtml(marker.badgeText);
  const labelClass = getLabelPresentation(marker.label).markerClassName;

  return L.divIcon({
    className: "cb-map-pin-wrapper",
    html: `<span class="cb-map-pin ${labelClass}" data-selected="${isSelected ? "true" : "false"}" title="${safeName} (${safeBadge})" aria-label="${safeName} (${safeBadge})"><span>${safeSymbol}</span><span>${marker.orderIndex}</span></span>`,
    iconSize: [36, 26],
    iconAnchor: [18, 13],
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


  function fitAllMarkers() {
    const map = mapRef.current;
    if (!map || viewport.mode === "empty") return;
    if (viewport.mode === "single") {
      map.setView([viewport.center.lat, viewport.center.lon], viewport.zoom, {
        animate: true,
      });
    } else {
      const bounds = L.latLngBounds(
        [viewport.southWest.lat, viewport.southWest.lon],
        [viewport.northEast.lat, viewport.northEast.lon],
      );
      map.fitBounds(bounds, { padding: [32, 32], maxZoom: 15 });
    }
  }

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
        icon: createPinIcon(item, isSelected),
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

    if (viewport.mode === "single") {
      map.setView([viewport.center.lat, viewport.center.lon], viewport.zoom, {
        animate: false,
      });
    } else if (viewport.mode === "bounds") {
      const bounds = L.latLngBounds(
        [viewport.southWest.lat, viewport.southWest.lon],
        [viewport.northEast.lat, viewport.northEast.lon],
      );
      map.fitBounds(bounds, { padding: [32, 32], maxZoom: 15, animate: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markers, viewport]);

  // Synchronize marker icons and map focus when selectedEntityId changes
  useEffect(() => {
    const map = mapRef.current;
    const layerMap = markersLayerRef.current;
    if (!map || layerMap.size === 0) return;

    for (const item of markers) {
      const leafletMarker = layerMap.get(item.entityId);
      if (!leafletMarker) continue;
      const isSelected = item.entityId === selectedEntityId;
      leafletMarker.setIcon(createPinIcon(item, isSelected));
      leafletMarker.setZIndexOffset(isSelected ? 1000 : 0);
    }

    const didSelectionChange = prevSelectedIdRef.current !== selectedEntityId;
    prevSelectedIdRef.current = selectedEntityId;

    if (didSelectionChange && selectedEntityId) {
      const targetMarker = markers.find((m) => m.entityId === selectedEntityId);
      if (targetMarker) {
        const currentZoom = map.getZoom();
        const targetZoom =
          typeof currentZoom === "number" && currentZoom >= 13
            ? currentZoom
            : 14;
        map.setView([targetMarker.lat, targetMarker.lon], targetZoom, {
          animate: true,
        });
      }
    }
  }, [selectedEntityId, markers]);

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
        className="rounded-lg border border-cb-border bg-cb-surface/50 p-6"
      >
        <h4 className="text-sm font-semibold">
          {city || "Destination"} map
        </h4>
        <p className="mt-1.5 text-sm text-cb-muted leading-relaxed">
          {recommendations.length === 0
            ? "No places to show on the map."
            : `None of the ${recommendations.length} ${
                recommendations.length === 1 ? "place" : "places"
              } had map coordinates. All recommendations are in the list.`}
        </p>
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label={`${city || "Destination"} map`}
      className="overflow-hidden rounded-lg border border-cb-border bg-background"
    >
      {/* Map header */}
      <div className="flex items-center justify-between border-b border-cb-border bg-cb-surface/40 px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-semibold">{city} map</span>
          <span className="text-cb-muted">
            {markers.length} of {recommendations.length} mapped
          </span>
        </div>

        {markers.length > 1 && (
          <button
            type="button"
            onClick={fitAllMarkers}
            className="rounded-md border border-cb-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-cb-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent"
          >
            Fit all
          </button>
        )}
      </div>

      {/* Map canvas */}
      <div
        ref={containerRef}
        className="cb-leaflet-container h-64 w-full sm:h-80 lg:h-96"
      />

      {/* Pin selector */}
      <div className="border-t border-cb-border bg-cb-surface/30 px-4 py-3">
        <div
          role="group"
          aria-label="Map pins"
          className="flex flex-wrap gap-1.5"
        >
          {markers.map((marker) => {
            const isSelected = marker.entityId === selectedEntityId;
            return (
              <button
                key={marker.entityId}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelectEntity(marker.entityId)}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent ${
                  isSelected
                    ? "border-cb-accent bg-cb-accent text-cb-accent-fg font-medium"
                    : "border-cb-border bg-background text-foreground hover:bg-cb-surface"
                }`}
              >
                <span className="font-semibold" aria-hidden="true">
                  {marker.orderIndex}
                </span>
                <span className="max-w-[8rem] truncate">{marker.name}</span>
              </button>
            );
          })}
        </div>

        {/* Selected place info */}
        {selection.selectedRecommendation && (
          <div
            role="status"
            aria-live="polite"
            className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-cb-border bg-background px-3.5 py-2.5 text-sm"
          >
            {selection.selectedMarker ? (
              <div className="min-w-0">
                <span className="font-medium">
                  {selection.selectedMarker.name}
                </span>
                {selection.selectedMarker.locationLine && (
                  <p className="mt-0.5 truncate text-xs text-cb-muted">
                    {selection.selectedMarker.locationLine}
                  </p>
                )}
              </div>
            ) : (
              <div className="min-w-0">
                <span className="font-medium">
                  {selection.selectedRecommendation.name}
                </span>
                <p className="mt-0.5 text-xs text-cb-muted">
                  Not on map — no coordinates available
                </p>
              </div>
            )}

            {onJumpToCard && (
              <button
                type="button"
                onClick={() =>
                  onJumpToCard(selection.selectedRecommendation!.entityId)
                }
                className="shrink-0 rounded-lg border border-cb-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-cb-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cb-accent"
              >
                Jump to details
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
