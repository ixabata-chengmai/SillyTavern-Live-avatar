# Live Avatar Generator (SillyTavern Extension)

Watches your SillyTavern chat, has a connected LLM describe the character's current scene
and appearance, generates an image via ComfyUI (or the built-in Image Generation extension),
and displays it as a floating avatar panel in the corner of the screen.

[日本語版はこちら (Japanese README)](README.ja.md)

## Features

- **Two-stage LLM pipeline**: a *compression* stage keeps a running, per-character description
  of clothing/body/pose/situation, updated incrementally from a short rolling window of recent
  messages; a *prompt* stage turns that description into Danbooru-style image tags.
- **Per-chat, per-character persistence**: state is tracked separately for each character
  (including group chat members) and separately for each chat, so an interrupted conversation
  resumes with its previous state intact.
- **Two generation modes**: reuse SillyTavern's standard Image Generation settings via
  `/imagine`, or drive ComfyUI directly with your own API-format workflow JSON.
- **Fully customizable prompts**: both LLM stages have editable instruction text and template
  layout, with a set of `{{token}}` placeholders.
- **Floating, draggable, resizable avatar panel** with crossfade transitions and a placeholder
  state for "no image yet" / "failed to load."
- **Throttling and abort control** to avoid hammering your LLM/image backend on rapid message
  bursts.
- **Per-character prompt overrides**: custom tags, prompt prefix, and (in custom mode) a
  specific checkpoint model per character.

## Installation

1. Copy this `live-avatar` folder into
   `<your SillyTavern install>/public/scripts/extensions/third-party/live-avatar`.
2. Restart SillyTavern (or reload the page).
3. Open the extensions panel (the magic wand icon → Extensions) and confirm
   `Live Avatar Generator` appears in the list.
4. Open its drawer and check "Enabled."

## Using ComfyUI Directly (Generation Settings Source = Custom)

1. Start ComfyUI with CORS enabled:
   ```
   python main.py --enable-cors-header
   ```
   Without this, the browser (SillyTavern) cannot reach ComfyUI directly.
2. In the settings panel, enter your ComfyUI URL (e.g. `http://127.0.0.1:8188`) and click
   "🔄 Fetch" — this pulls the sampler / scheduler / checkpoint / VAE lists straight from
   ComfyUI into the dropdowns.
3. Paste the workflow JSON exported from ComfyUI's `Save (API Format)` into the "Workflow
   JSON" field, or load it from a file. The following placeholders are supported (omit any
   you don't need):

   ```
   %prompt%  %negative_prompt%  %seed%  %steps%  %scale%
   %sampler% %scheduler% %model% %vae% %width% %height%
   %denoise% %clip_skip%
   ```

   Note: `%denoise%` and `%clip_skip%` have no corresponding connected node in the sample
   workflow, so their values are saved but not applied during generation. To use them,
   wire the corresponding node inputs in your workflow to these placeholders (`%clip_skip%`
   requires adding a `CLIPSetLastLayer` node).

## Using the Standard Image Generation Settings (Generation Settings Source = Standard)

- Configure the ComfyUI URL, workflow, model, etc. in SillyTavern's built-in "Image
  Generation" extension (with a ComfyUI source).
- This extension simply runs `/imagine <prompt>` internally, so any change to the standard
  panel's settings is reflected automatically.

## How It Works (Two-Stage LLM Pipeline)

1. An AI message is rendered (`CHARACTER_MESSAGE_RENDERED` event).
2. Throttling / abort conditions are checked.
3. **Stage 1 (compress & update state)**: the speaker's previously saved "compressed
   context" (a description of clothing, body, pose, and situation) plus a short window of
   the N most recent chat lines (configurable) are sent to the LLM via `/genraw`, which
   returns an updated description reflecting only what changed. The result is persisted.
4. **Stage 2 (build the prompt)**: the updated compressed context is sent to the LLM via
   `/genraw`, which returns Danbooru-style tags for image generation.
5. Those tags are sent to ComfyUI (or `/imagine` in standard mode) to generate an image.
6. The generated image is crossfaded into the floating avatar panel in the corner of the
   screen.

### Persisted State

- **Storage location**: SillyTavern's chat metadata (`chatMetadata`) is used when available,
  since it's tied to the chat file itself — state survives closing and reopening the chat.
  If this isn't available in your SillyTavern version, the extension falls back to storing
  the same data inside its own settings, keyed by chat ID (a browser extension has no way to
  write directly to an arbitrary folder on disk).
- **Key structure**: `chat ID → speaker name → compressed context`. In a group chat with
  multiple characters, each character's compressed context is tracked independently.
- **Switching chats**: switching to a different chat automatically loads that chat's saved
  compressed contexts, resuming tracking from where it left off.
- **Messages before the extension was enabled**: not tracked. Tracking starts from the first
  time the extension runs in a given chat — past history is not backfilled.

## Settings Reference

| Setting | Description |
|---|---|
| Recent message window | How many of the most recent messages are sent to Stage 1 together with the previous state. Recommended: a handful (e.g. 5) rather than 1, to avoid overly abrupt changes. |
| Stage 1 template / instruction | Used for the compression stage. Tokens: `{{instruction}} {{character_card}} {{previous_context}} {{recent_log}} {{compressed_context}} {{speaker}} {{char_*}}` |
| Stage 2 template / instruction | Used for the prompt-generation stage. Tokens: `{{instruction}} {{character_card}} {{compressed_context}} {{previous_context}} {{recent_log}} {{speaker}} {{char_*}}` |
| Minimum length of the compressed result | If Stage 1's response is shorter than this many characters, it's discarded and the previous state is kept (0 disables; default 20 characters). |
| Cache | When on, reuses a previously generated image for the same combination of tags (fast). When off, always regenerates. |
| Minimum generation interval | Don't regenerate until this much time has passed since the last generation. 0 disables. |
| Message-length-diff threshold | Don't regenerate if the character count differs from the previous message by less than this. 0 disables. |
| Abort control | Whether an in-flight generation is cancelled when a new message arrives. |
| Timeout | Force-abort a generation that hangs, after this many ms. |
| Seed | A value ≥ 0 generates with that fixed seed every time (for visual consistency). **-1 randomizes.** |
| Per-character overrides | Switch checkpoint / prompt prefix per speaker name (`name`). |

Both `{{char}}` / `{{user}}` SillyTavern macros are also supported in the instruction fields,
the templates, and the recent chat log sent to the LLM.

## Known Limitations

- `/genraw`, `/imagine`, and `executeSlashCommandsWithOptions` are internal APIs of the
  SillyTavern core and their behavior can change between versions. If something breaks after
  an update, check the browser console for errors.
- Direct ComfyUI access in custom mode requires CORS to be enabled on the ComfyUI side.
- Client-side JavaScript cannot write to an arbitrary folder on disk — persisted state uses
  either SillyTavern's chat metadata or this extension's own settings storage (see above).

## License

Add your preferred license here (e.g. MIT) before publishing.
