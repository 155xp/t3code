# NZXT Kraken agent status

T3 Code can render local agent status on an NZXT Kraken LCD through NZXT CAM's
Web Integration mode. It does not access the cooler over USB and does not
control pump, fan, or lighting settings.

## Set up NZXT CAM

1. Start T3 Code and NZXT CAM.
2. In CAM, open the Kraken's **Lighting** panel.
3. Select **Web Integration** as the display mode.
4. Enter `http://127.0.0.1:3783/`.

The 240 × 240 display shows the provider and shortened task title for Codex,
Claude, Cursor, and OpenCode. Successful work remains on **DONE** until another
agent changes state. Approval, input, failure, and stopped states have distinct
cards.

## Configuration

- `T3CODE_KRAKEN_ENABLED=false` disables the listener.
- `T3CODE_KRAKEN_PORT=<port>` changes the default port from `3783`.

The listener always binds to IPv4 loopback (`127.0.0.1`) and exposes only the
display page, a read-only `/status` response, and an `/events` status stream.
Prompts, message bodies, file paths, and provider error details are never
included.

If the port is already occupied, T3 Code continues normally and records a
warning in the server log. Choose another port and enter the matching URL in
CAM.
