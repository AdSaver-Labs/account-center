# Interface Notes

These notes capture UI/application ideas that should be revisited when Account Center moves from CLI/ChatOps into a visual app.

## Always-on account limit overlay

Requested by Alej on 2026-07-10.

### Concept

Add an optional always-on-top screen overlay for monitoring Account Center limits while working in other apps.

The desired behavior is similar to an FPS counter in games:

- small overlay pinned to a screen corner, for example top-left;
- can also behave like a macOS menu-bar/status item in the top-right area, similar to background apps that sit in the Mac menu bar;
- visible above normal tabs, terminals, browsers, and applications when overlay mode is enabled;
- continuously shows the currently active account and key limit windows;
- lets Alej monitor account usage without opening the full dashboard or typing `/auth`;
- should be easy to enable/disable and move between corners.

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
- macOS menu-bar/status item that lives in the top-right menu bar like other background utilities, with a compact live limit indicator and click-to-expand details.
- Browser/PWA mini-window for systems where native always-on-top is not available.
- Terminal/status-bar fallback for SSH/VPS-only usage.
- Dashboard setting: “Enable account limits overlay”.
- Event-stream updates from the local Account Center API instead of polling when possible.

### Reminder for interface phase

When starting Phase 11 dashboard/app work, explicitly bring this feature back into the UI planning checklist before finalizing the interface scope.
