# Demo screenshot

`demo.png` should be a terminal screenshot of `npx ctx-audit` run in a repo that has at least one FRESH and one STALE file.

**How to capture:**
1. Use a repo with both fresh and stale context files (or temporarily adjust `last_synced_commit` in one file to an old SHA)
2. Run: `npx ctx-audit`
3. Screenshot the colored output (macOS: `Cmd+Shift+4`, then select the terminal window)
4. Save as `docs/demo.png`

Colored output (green FRESH / red STALE / yellow STALE?) makes the README click-worthy — this is the highest-ROI README change.
