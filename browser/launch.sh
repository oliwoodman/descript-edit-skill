#!/bin/bash
# Opens a Descript project in its own Chrome window with remote debugging on port 9333.
# The profile at ~/.cache/descript-chrome keeps the Descript sign-in, so you sign in once.
# Usage: bash launch.sh "<project url>"
set -e
URL="$1"
# run from the skill folder so the helper finds its own Playwright install
cd "$(dirname "$0")/.."
if curl -s http://127.0.0.1:9333/json/version >/dev/null; then
  # Chrome is up. A project already open is left alone; any other opens in a window of its own, set 200 right and
  # 169 down so neither window covers the other whole (Chrome stops drawing a window it thinks is hidden, and the
  # frames then read stale). Each chat then names its project with DESCRIPT_PROJECT=<project id>.
  ID=$(echo "$URL" | sed -E 's|https://web.descript.com/([0-9a-f-]+).*|\1|')
  if curl -s http://127.0.0.1:9333/json/list | grep -q "$ID"; then echo "already open: $ID"; exit 0; fi
  node --input-type=module -e "
    import { chromium } from 'playwright';
    const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
    const s = await b.newBrowserCDPSession();
    const { targetId } = await s.send('Target.createTarget', { url: process.argv[1], newWindow: true });
    const { windowId } = await s.send('Browser.getWindowForTarget', { targetId });
    await s.send('Browser.setWindowBounds', { windowId, bounds: { left: 200, top: 169, width: 1600, height: 1000 } });
    console.log('opened in a new window; run the helper with DESCRIPT_PROJECT=$ID');
    process.exit(0);" "$URL"
  exit 0
fi
mkdir -p "$HOME/.cache/descript-chrome"
nice -n 5 "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$HOME/.cache/descript-chrome" --remote-debugging-port=9333 \
  --no-first-run --no-default-browser-check --window-size=1600,1000 "$URL" >/dev/null 2>&1 &
for i in $(seq 1 15); do curl -s http://127.0.0.1:9333/json/version >/dev/null && { echo "up"; exit 0; }; sleep 1; done
echo "Chrome did not open the debugging port"; exit 1
