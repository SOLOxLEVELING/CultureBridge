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

  const unmappedCount = Math.max(0, recommendations.length - markers.length);

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

    // Clear existing markers
    for (const existingMarker of layerMap.values()) {
      existingMarker.remove();
    }
    layerMap.clear();

    // Add validated markers
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

    // Apply initial bounds
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

  // Empty map state when no recommendations have valid coordinates
  if (markers.length === 0) {
    return (
      <div
        role="region"
        aria-label={`${city || "Destination"} recommendation map`}
        className="rounded-lg border border-foreground/15 bg-foreground/[0.02] p-5"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="text-xs font-semibold tracking-tight text-foreground/85">
              Map view · {city || "Destination"}
            </h4>
            <p className="mt-1 text-xs leading-relaxed text-foreground/65">
              {recommendations.length === 0
                ? "No accepted places to plot on the map."
                : `None of the ${recommendations.length} accepted ${
                    recommendations.length === 1 ? "place" : "places"
                  } included valid latitude and longitude coordinates in Qloo. All recommendations remain available in the list.`}
            </p>
          </div>
          <span className="shrink-0 rounded border border-foreground/15 px-2 py-0.5 font-mono text-[11px] text-foreground/60">
            0 mapped
          </span>
        </div>
        <p className="mt-3 text-[11px] text-foreground/50">
          CultureBridge only plots coordinates directly returned by Qloo and
          never infers or fabricates map pins.
        </p>
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label={`${city || "Destination"} recommendation map`}
      className="overflow-hidden rounded-lg border border-foreground/15 bg-background"
    >
      {/* Map Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-foreground/10 bg-foreground/[0.02] px-3.5 py-2.5">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold text-foreground">
            {city || "Destination"} Map
          </span>
          <span className="font-mono text-[11px] text-foreground/60">
            {markers.length} of {recommendations.length} mapped
          </span>
          {unmappedCount > 0 && (
            <span className="rounded border border-foreground/15 bg-background px-1.5 py-0.5 font-mono text-[10px] text-foreground/60">
              {unmappedCount} in list without coordinates
            </span>
          )}
        </div>

        {markers.length > 1 && (
          <button
            type="button"
            onClick={fitAllMarkers}
            className="rounded border border-foreground/20 bg-background px-2 py-0.5 font-mono text-[11px] text-foreground/75 transition-colors hover:bg-foreground/[0.05] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
          >
            Fit all pins
          </button>
        )}
      </div>

      {/* Leaflet Canvas — compact on mobile so it never consumes the full screen */}
      <div
        ref={containerRef}
        className="cb-leaflet-container h-60 w-full sm:h-72 lg:h-80"
      />

      {/* Keyboard-accessible pin selector bar */}
      <div className="border-t border-foreground/10 bg-foreground/[0.015] px-3.5 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-foreground/60">
            Mapped places (select to focus pin &amp; card):
          </span>
          <span className="text-[10px] text-foreground/50">
            Map data &copy;{" "}
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground/80"
            >
              OpenStreetMap
            </a>{" "}
            contributors
          </span>
        </div>

        <div
          role="group"
          aria-label="Mapped recommendation pins"
          className="mt-2 flex flex-wrap gap-1.5"
        >
          {markers.map((marker) => {
            const isSelected = marker.entityId === selectedEntityId;
            return (
              <button
                key={marker.entityId}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelectEntity(marker.entityId)}
                className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-left text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground ${
                  isSelected
                    ? "border-foreground bg-foreground text-background font-medium"
                    : "border-foreground/15 bg-background text-foreground/80 hover:border-foreground/35 hover:bg-foreground/[0.04]"
                }`}
              >
                <span className="font-mono text-[11px]" aria-hidden="true">
                  {marker.symbol}
                  {marker.orderIndex}
                </span>
                <span className="max-w-[10rem] truncate">{marker.name}</span>
              </button>
            );
          })}
        </div>

        {/* Active selection inspector bar */}
        {selection.selectedRecommendation && (
          <div
            role="status"
            aria-live="polite"
            className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded border border-foreground/15 bg-background px-3 py-2 text-xs"
          >
            {selection.selectedMarker ? (
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[11px] font-semibold">
                    Pin {selection.selectedMarker.symbol}
                    {selection.selectedMarker.orderIndex}
                  </span>
                  <span className="font-semibold text-foreground">
                    {selection.selectedMarker.name}
                  </span>
                  <span className="rounded border border-foreground/15 px-1.5 py-0.5 font-mono text-[10px] text-foreground/65">
                    {selection.selectedMarker.badgeText}
                  </span>
                </div>
                <p className="truncate text-[11px] text-foreground/60">
                  {selection.selectedMarker.locationLine ??
                    `${selection.selectedMarker.lat.toFixed(4)}, ${selection.selectedMarker.lon.toFixed(4)}`}
                </p>
              </div>
            ) : (
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium text-foreground/85">
                  {selection.selectedRecommendation.name} · Not on map
                </p>
                <p className="text-[11px] text-foreground/60">
                  This place has no coordinates in Qloo and is shown in the
                  recommendation list only.
                </p>
              </div>
            )}

            {onJumpToCard && (
              <button
                type="button"
                onClick={() =>
                  onJumpToCard(selection.selectedRecommendation!.entityId)
                }
                className="shrink-0 rounded border border-foreground/20 px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-foreground/[0.05] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
              >
                Jump to card
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
