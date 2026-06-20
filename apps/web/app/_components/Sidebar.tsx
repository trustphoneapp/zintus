"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getGatewayUrl } from "@/lib/gateway";
import { useAppStore } from "@/lib/app-store";
import { Icon } from "./Icons";

const SECTIONS: Array<{
  label: string;
  items: Array<{ href: string; icon: "chat" | "layers" | "activity" | "terminal" | "settings"; label: string }>;
}> = [
  {
    label: "Main",
    items: [
      { href: "/chat", icon: "chat", label: "Chat" },
      { href: "/providers", icon: "layers", label: "Providers" },
      { href: "/usage", icon: "activity", label: "Usage" },
    ],
  },
  {
    label: "Dev",
    items: [
      { href: "/terminal", icon: "terminal", label: "Terminal" },
      { href: "/settings", icon: "settings", label: "Settings" },
    ],
  },
];

export function Sidebar({
  collapsed,
  onToggle,
  gatewayConnected,
}: {
  collapsed: boolean;
  onToggle: () => void;
  gatewayConnected: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const newChat = useAppStore((state) => state.newChat);

  return (
    <aside className={`app-sidebar${collapsed ? " collapsed" : ""}`}>
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <Icon name="layers" size={14} />
        </div>
        {!collapsed ? <span className="sidebar-brand">Zintus</span> : null}
        <button
          type="button"
          className="sidebar-toggle"
          onClick={onToggle}
          aria-label="Toggle sidebar"
        >
          <Icon name="menu" size={16} />
        </button>
      </div>

      <button
        type="button"
        className="sidebar-newchat"
        title={collapsed ? "New chat" : undefined}
        onClick={() => {
          newChat();
          router.push("/chat");
        }}
      >
        <Icon name="plus" size={16} />
        {!collapsed ? <span>New chat</span> : null}
      </button>

      <nav className="sidebar-nav">
        {SECTIONS.map((section) => (
          <div key={section.label} className="sidebar-section">
            {!collapsed ? (
              <span className="sidebar-section-label">{section.label}</span>
            ) : null}
            {section.items.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`sidebar-link${active ? " active" : ""}`}
                  title={collapsed ? item.label : undefined}
                >
                  <Icon name={item.icon} size={17} />
                  {!collapsed ? <span>{item.label}</span> : null}
                  {active && !collapsed ? (
                    <span className="sidebar-active-dot" />
                  ) : null}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {!collapsed ? (
        <div className="sidebar-footer">
          <div className="sidebar-status">
            <span className={`status-dot${gatewayConnected ? " online" : ""}`} />
            <span>{gatewayConnected ? "Gateway connected" : "Gateway offline"}</span>
          </div>
          <div className="sidebar-substatus">
            {gatewayConnected ? getGatewayUrl() : "Start: bun run dev:gateway"}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
