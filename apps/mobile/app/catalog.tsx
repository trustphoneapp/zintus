import { useCallback, useMemo, useState } from "react";
import {
  FlatList,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { listCatalogModels, type CatalogModel } from "@zintus/providers";
import { PROVIDER_METADATA } from "@zintus/providers";
import {
  catalogProviders,
  EMPTY_CATALOG_FILTERS,
  filterAndSortCatalog,
  formatContext,
  priceLabel,
  type CatalogCapability,
  type CatalogFilters,
  type CatalogSortKey,
} from "@/lib/catalog-filter";
import {
  loadSelectedModel,
  saveSelectedModel,
  type SelectedModel,
} from "@/lib/config";
import { COLORS } from "@/lib/theme";

const ALL_MODELS = listCatalogModels();
const PROVIDER_IDS = catalogProviders(ALL_MODELS);

const SORTS: ReadonlyArray<{ key: CatalogSortKey; label: string }> = [
  { key: "name", label: "Name" },
  { key: "price", label: "Price" },
  { key: "context", label: "Context" },
];

const CAPS: ReadonlyArray<{ key: CatalogCapability; label: string }> = [
  { key: "vision", label: "Vision" },
  { key: "tools", label: "Tools" },
  { key: "json", label: "JSON" },
];

function providerLabel(id: string): string {
  return PROVIDER_METADATA[id as keyof typeof PROVIDER_METADATA]?.name ?? id;
}

/** A small pill toggle used for filters, sort and the provider picker. */
function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      className={`rounded-full border px-3 py-1.5 ${
        active
          ? "border-transparent bg-accent"
          : "border-slate-700 bg-transparent"
      }`}
    >
      <Text
        className={`text-xs ${active ? "font-semibold text-slate-950" : "text-muted"}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** Capability badge — bright when supported, dim when not (honest, no claims). */
function CapBadge({ label, on }: { label: string; on: boolean }) {
  return (
    <View
      className={`rounded px-1.5 py-0.5 ${
        on ? "bg-emerald-500/15" : "bg-slate-800"
      }`}
    >
      <Text className={`text-[10px] ${on ? "text-emerald-400" : "text-muted"}`}>
        {label}
      </Text>
    </View>
  );
}

function ModelRow({
  model,
  selected,
  onUse,
}: {
  model: CatalogModel;
  selected: boolean;
  onUse: () => void;
}) {
  const price = priceLabel(model);
  const priceColor =
    price.tone === "free"
      ? COLORS.good
      : price.tone === "unknown"
        ? COLORS.muted
        : COLORS.ink;

  return (
    <View className="rounded-xl border border-slate-800 bg-panel p-4">
      <View className="flex-row items-start justify-between">
        <View className="flex-1 pr-3">
          <Text className="text-base font-semibold text-ink">
            {model.displayName}
          </Text>
          <Text className="text-xs text-muted">
            {providerLabel(model.provider)} · {formatContext(model.contextWindow)} ctx
            {model.isProviderDefault ? " · default" : ""}
          </Text>
        </View>
        <View className="items-end">
          <Text className="text-sm font-semibold" style={{ color: priceColor }}>
            {price.headline}
          </Text>
          {price.detail ? (
            <Text className="text-[10px] text-muted">{price.detail}</Text>
          ) : null}
        </View>
      </View>

      <View className="mt-3 flex-row flex-wrap gap-1">
        <CapBadge label="Vision" on={model.vision} />
        <CapBadge label="Tools" on={model.tools} />
        <CapBadge label="JSON" on={model.structuredOutput !== "none"} />
        {model.local ? <CapBadge label="Local" on /> : null}
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={onUse}
        className={`mt-3 items-center rounded-lg py-2.5 ${
          selected ? "border border-emerald-500/40 bg-emerald-500/10" : "bg-accent"
        }`}
      >
        <Text
          className={`font-semibold ${selected ? "text-emerald-400" : "text-slate-950"}`}
        >
          {selected ? "● Active model" : "Use this model"}
        </Text>
      </Pressable>
    </View>
  );
}

export default function CatalogScreen() {
  const router = useRouter();
  const [filters, setFilters] = useState<CatalogFilters>(EMPTY_CATALOG_FILTERS);
  const [selected, setSelected] = useState<SelectedModel | null>(
    loadSelectedModel(),
  );

  useFocusEffect(
    useCallback(() => {
      setSelected(loadSelectedModel());
    }, []),
  );

  const visible = useMemo(
    () => filterAndSortCatalog(ALL_MODELS, filters),
    [filters],
  );

  function toggleCap(key: CatalogCapability) {
    setFilters((f) => ({
      ...f,
      capabilities: { ...f.capabilities, [key]: !f.capabilities[key] },
    }));
  }

  function handleUse(model: CatalogModel) {
    const next: SelectedModel = {
      id: model.id,
      provider: model.provider,
      displayName: model.displayName,
    };
    saveSelectedModel(next);
    setSelected(next);
    router.push("/");
  }

  const header = (
    <View className="gap-3 pb-2">
      <Text className="text-sm text-muted">
        Every model your gateway can route to — capabilities, context and honest
        pricing. Core stays free; no paywall.
      </Text>

      {selected ? (
        <View className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
          <Text className="text-xs text-emerald-400">
            Active: {selected.displayName} · {providerLabel(selected.provider)}
          </Text>
        </View>
      ) : null}

      <TextInput
        placeholder="Search by name or id…"
        placeholderTextColor={COLORS.muted}
        value={filters.search}
        onChangeText={(search) => setFilters((f) => ({ ...f, search }))}
        autoCapitalize="none"
        autoCorrect={false}
        className="rounded-lg border border-slate-700 bg-panel px-3 py-2.5 text-ink"
      />

      <View className="flex-row flex-wrap gap-1.5">
        <Chip
          label="Free"
          active={filters.free}
          onPress={() => setFilters((f) => ({ ...f, free: !f.free }))}
        />
        {CAPS.map((c) => (
          <Chip
            key={c.key}
            label={c.label}
            active={filters.capabilities[c.key]}
            onPress={() => toggleCap(c.key)}
          />
        ))}
      </View>

      <View>
        <Text className="mb-1 text-[10px] uppercase tracking-wide text-muted">
          Provider
        </Text>
        <View className="flex-row flex-wrap gap-1.5">
          <Chip
            label="All"
            active={filters.provider === "all"}
            onPress={() => setFilters((f) => ({ ...f, provider: "all" }))}
          />
          {PROVIDER_IDS.map((id) => (
            <Chip
              key={id}
              label={providerLabel(id)}
              active={filters.provider === id}
              onPress={() => setFilters((f) => ({ ...f, provider: id }))}
            />
          ))}
        </View>
      </View>

      <View>
        <Text className="mb-1 text-[10px] uppercase tracking-wide text-muted">
          Sort
        </Text>
        <View className="flex-row gap-1.5">
          {SORTS.map((s) => (
            <Chip
              key={s.key}
              label={s.label}
              active={filters.sort === s.key}
              onPress={() => setFilters((f) => ({ ...f, sort: s.key }))}
            />
          ))}
        </View>
      </View>

      <Text className="text-xs text-muted">
        {visible.length} model{visible.length === 1 ? "" : "s"}
      </Text>
    </View>
  );

  return (
    <View className="flex-1 bg-surface">
      <FlatList
        data={visible}
        keyExtractor={(m) => `${m.provider}:${m.id}`}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        ListHeaderComponent={header}
        renderItem={({ item }) => (
          <ModelRow
            model={item}
            selected={
              selected?.id === item.id && selected?.provider === item.provider
            }
            onUse={() => handleUse(item)}
          />
        )}
        ListEmptyComponent={
          <View className="items-center rounded-xl border border-slate-800 bg-panel p-8">
            <Text className="font-semibold text-ink">No models match</Text>
            <Text className="mt-1 text-xs text-muted">
              Try clearing search or filter chips.
            </Text>
          </View>
        }
      />
    </View>
  );
}
