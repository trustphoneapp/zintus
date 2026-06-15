import { View, Text } from "react-native";
import type { ProviderId } from "@multipleai/types";
import { PROVIDER_LIMITS } from "@/lib/limits";

interface QuotaBarProps {
  providerId: ProviderId;
  requestsToday: number;
  tokensToday: number;
  inCooldown?: boolean;
}

export function QuotaBar({
  providerId,
  requestsToday,
  tokensToday,
  inCooldown = false,
}: QuotaBarProps) {
  const limits = PROVIDER_LIMITS[providerId];
  const requestRatio =
    limits.requestsPerDay != null
      ? Math.min(requestsToday / limits.requestsPerDay, 1)
      : 0;
  const tokenRatio =
    limits.tokensPerDay != null
      ? Math.min(tokensToday / limits.tokensPerDay, 1)
      : 0;
  const used = Math.max(requestRatio, tokenRatio);
  const remaining = Math.round((1 - used) * 100);

  return (
    <View className="gap-1">
      <View className="h-2 overflow-hidden rounded-full bg-slate-800">
        <View
          className={`h-full rounded-full ${inCooldown ? "bg-amber-500" : "bg-accent"}`}
          style={{ width: `${Math.max(remaining, 2)}%` }}
        />
      </View>
      <Text className="text-xs text-muted">
        {remaining}% left · {requestsToday}
        {limits.requestsPerDay != null ? `/${limits.requestsPerDay}` : ""} req
        {inCooldown ? " · cooldown" : ""}
      </Text>
    </View>
  );
}
