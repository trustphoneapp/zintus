#!/usr/bin/env sh
# Print suggested Zintus gateway dev URLs.
#
# Shows the loopback URL (for the web app on the same machine) and a LAN URL
# (for a physical phone / another device on the same Wi-Fi), so a developer
# knows what to set GATEWAY_URL to on each.
#
# Usage:  ./scripts/print-dev-urls.sh
# Override the port:  GATEWAY_PORT=9000 ./scripts/print-dev-urls.sh

PORT="${GATEWAY_PORT:-8788}"

# macOS: en0 is usually Wi-Fi, en1 is often Ethernet/Thunderbolt. Try both.
LAN_IP=""
if command -v ipconfig >/dev/null 2>&1; then
  LAN_IP="$(ipconfig getifaddr en0 2>/dev/null)"
  if [ -z "$LAN_IP" ]; then
    LAN_IP="$(ipconfig getifaddr en1 2>/dev/null)"
  fi
fi

# Fallback for non-macOS or when ipconfig found nothing.
if [ -z "$LAN_IP" ] && command -v hostname >/dev/null 2>&1; then
  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi

echo "Zintus gateway dev URLs (port ${PORT})"
echo
echo "  Web app (same machine):"
echo "    GATEWAY_URL=http://localhost:${PORT}"
echo

if [ -n "$LAN_IP" ]; then
  echo "  Mobile / physical device (same Wi-Fi):"
  echo "    GATEWAY_URL=http://${LAN_IP}:${PORT}"
  echo
  echo "  Detected LAN IP: ${LAN_IP}"
  echo "  Reminder: bind the gateway to 0.0.0.0 and set GATEWAY_TOKEN to expose it on the LAN."
else
  echo "  Mobile / physical device:"
  echo "    Could not detect a LAN IP (not connected to Wi-Fi/Ethernet?)."
  echo "    Find it manually, then use http://<LAN_IP>:${PORT}"
fi
