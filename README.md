# Claude Footprint

Ask Claude to analyze your own Claude.ai chat history, right from Obsidian.

---

## 1. Export your Claude.ai chats

Anthropic's own built-in export (no browser extension needed):

1. Open claude.ai (or the Claude desktop app) and sign in
2. Click your initials (bottom-left) → **Settings** → **Privacy** → **Export data**
3. Anthropic emails you a download link within a few minutes (expires after 24 hours)
4. Download and unzip it — inside you'll find a folder like `data-xxxx-batch-0000/` containing `conversations.json` and `users.json`

You only need `conversations.json`. This step is manual — there's no way to automate triggering it, since Anthropic doesn't expose your chat history through an API. Do this whenever you want your vault refreshed (weekly is reasonable).

## 2. Set up the vault

- Point Obsidian at (or create) your vault
- Create a subfolder called `Footprint` — this is where your daily notes will live
- Create a note called `claude.md` at the vault root — this is where you'll ask questions and get answers back

## 3. Install the plugin

1. Copy the `claude-footprint-plugin` folder into your vault at:
   `YourVault/.obsidian/plugins/claude-footprint/`
   (so it contains `manifest.json`, `main.js`, `styles.css` directly inside)
2. Settings → Community plugins → turn off "Restricted mode" if it's on
3. Reload Obsidian (Cmd/Ctrl+P → "Reload app without saving")
4. Enable "Claude Footprint" in the Community plugins list
5. Settings → Claude Footprint:
   - Paste in your **Anthropic API key** (get one at console.anthropic.com — separate from a claude.ai subscription, billed per use)
   - Set **Footprint folder** to `Footprint`

## 4. Import your export

No terminal, no Node.js — the plugin reads the file directly.

1. Cmd/Ctrl+P → **"Import Claude export (conversations.json)"** (or click the import icon in the ribbon)
2. A normal file picker opens — select your `conversations.json`
3. The plugin sorts every conversation by the day it started and writes daily notes straight into your `Footprint` folder

Re-running this later (say, after a fresh export with more recent chats) is safe — it only files conversations it hasn't seen before, so nothing gets duplicated.

## 5. Ask questions

In `claude.md`, write a question as the last line:

```
>> Explain what things I discussed on 30th June
```

Then run **"Ask Claude about my Footprint notes"** (Cmd/Ctrl+P, or the chat-bubble ribbon icon). The plugin figures out which date(s) you mean, pulls in the matching daily note(s), sends them + your question to Claude, and appends the answer into `claude.md`.

Understands things like: "30th June", "June 30", "2026-06-30", "yesterday", "today", "this week", "last week". No date mentioned → defaults to your most recent notes.

---

## Redeploying changes to GitHub

If you edit the plugin code, both **Obsidian's built-in updater** and **BRAT** decide whether there's a new version by comparing the `version` field in `manifest.json` against your GitHub release tags. Pushing new code without a matching new release means nobody's install will pick up the change.

**Yes — every code change needs a new release.** Steps:

1. **Bump the version** in `manifest.json`, e.g. `1.0.1` → `1.0.2`. Use plain semver (no `v` prefix, no `-beta` suffixes unless you specifically want a pre-release).

2. **Commit and push** the changed files:
   ```bash
   cd claude-footprint-plugin
   git add manifest.json main.js styles.css
   git commit -m "Add feature X"
   git push
   ```

3. **Create a new GitHub release**, tagged to match:
   - Repo → Releases → "Draft a new release"
   - Tag: exactly the new version, e.g. `1.0.2`
   - Publish as a normal release (not a draft, not a pre-release, unless intentional)

4. **Attach the three files as individual release assets** (this is the step that's easy to miss — committing them to the repo isn't enough, they must be dragged into the release's Assets area separately):
   - `main.js`
   - `manifest.json`
   - `styles.css`

5. **Publish the release.**

From there:
   - If you're using **BRAT**: Command palette → "BRAT: Check for updates to all beta plugins" picks it up (or it happens automatically depending on your BRAT settings)
   - If you're on the **official Community Plugins list**: Obsidian shows the update automatically to all users once your release is live — no extra step
   - If you (or others) installed **manually**: re-download the three files from the new release and overwrite them in `.obsidian/plugins/claude-footprint/`

A quick sanity check after publishing: hit `https://api.github.com/repos/YOUR_USERNAME/YOUR_REPO/releases/latest` in a browser and confirm `tag_name` matches your new `manifest.json` version and all three assets are listed — this is exactly what BRAT and Obsidian check.
