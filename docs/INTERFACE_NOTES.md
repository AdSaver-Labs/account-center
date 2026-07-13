# Interface Notes

These notes capture UI/application ideas that should be revisited when Account Center moves from CLI/ChatOps into a visual app.

## Always-on account limit overlay

Requested by Alej on 2026-07-10.

### Concept

Add an optional always-on-top screen overlay for monitoring Account Center limits while working in other apps.

The desired behavior is similar to an FPS counter in games:

- small overlay pinned to a screen corner, for example top-left;
- can also behave like a macOS menu-bar/status node/icon in the top-right area, similar to background apps that indicate they are running in the Mac menu bar;
- in menu-bar mode, hovering the embedded widget should reveal a compact limits panel for the active account(s);
- the hover panel should include an **Always on** button/toggle;
- pressing **Always on** should pop the widget out into a movable FPS-counter-style overlay that stays above all screens/apps;
- visible above normal tabs, terminals, browsers, and applications when overlay mode is enabled;
- continuously shows the currently active account and key limit windows;
- lets Alej monitor account usage without opening the full dashboard or typing `/auth`;
- should be easy to enable/disable, move between corners, and collapse back into the menu-bar node.

### Useful display fields

Minimum useful overlay content:

- active runtime/agent, e.g. Dexter/OpenClaw, Jack/Hermes, Codex;
- active account label/email, redacted or user-configurable;
- plan/tier, e.g. Plus/Pro/API/custom;
- 5-hour window remaining;
- weekly window remaining;
- next reset time;
- warning color when an account is near exhaustion;
- next eligible account, if current account is low.

### Product requirements

- Overlay must call the same local Account Center API/command core as CLI, Telegram, and dashboard.
- Overlay must not store credentials or tokens.
- Overlay should support a compact mode and expanded hover/click mode.
- Overlay should have configurable position, opacity, refresh interval, and warning thresholds.
- Overlay should work as a companion to the future dashboard/app, not as a separate source of truth.

### Implementation ideas to evaluate later

- Desktop floating window with always-on-top behavior.
- macOS menu-bar/status node that lives in the top-right menu bar like other background utilities, with a compact live limit indicator.
- Hover panel from the menu-bar node showing active account limits and key reset times.
- Hover-panel **Always on** button/toggle that pops the status widget out into a movable always-on-top FPS-counter-style overlay.
- Collapse action that returns the floating overlay back into the menu-bar node.
- Browser/PWA mini-window for systems where native always-on-top is not available.
- Terminal/status-bar fallback for SSH/VPS-only usage.
- Dashboard setting: “Enable account limits overlay”.
- Event-stream updates from the local Account Center API instead of polling when possible.

### Reminder for interface phase

When starting Phase 11 dashboard/app work, explicitly bring this feature back into the UI planning checklist before finalizing the interface scope.
