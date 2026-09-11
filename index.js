// Live Avatar Generator for SillyTavern
// Watches the chat, extracts the current scene/expression via the connected LLM,
// generates an image via ComfyUI (or the standard Image Generation extension),
// and swaps it into a dedicated floating avatar panel.

(function () {
    "use strict";

    const MODULE_NAME = "live_avatar";
    const EXTENSION_FOLDER = "scripts/extensions/third-party/live-avatar";

    // storage keys used inside chat metadata (or the settings-based fallback)
    const CONTEXT_STORE_KEY = "live_avatar_context";

    const DEFAULT_SETTINGS = {
        enabled: true,
        generationMode: "standard", // "standard" | "custom"
        standardPromptPrefix: "",
        // per-chat-id fallback store, used only when SillyTavern's chat metadata
        // API is unavailable in this ST version. { [chatId]: { [speakerName]: { compressedContext } } }
        chatContextFallback: {},
        custom: {
            comfyUrl: "http://127.0.0.1:8188",
            workflowJson: "",
            resolutionPreset: "1024x1024",
            width: 1024,
            height: 1024,
            negativePrompt: "",
            defaults: {
                steps: 12,
                scale: 1.0,
                sampler: "euler",
                scheduler: "simple",
                denoise: 1.0,
                clipSkip: 1,   // not wired into the sample workflow (no CLIPSetLastLayer node)
                seed: 0        // -1 = randomize every generation
            },
            characterOverrides: {} // { [speakerName]: { model, vae, promptPrefix } }
        },
        cacheEnabled: true,
        throttle: {
            minIntervalMs: 3000,
            minCharDiff: 0
        },
        abort: {
            enabled: true,
            timeoutMs: 15000
        },
        // free-form position & size for the floating avatar panel (drag & resize)
        panel: {
            usePosition: false,
            left: null,
            top: null,
            width: 220,
            height: 300
        },
        // how many of the most recent chat messages are handed to Stage 1
        // (context compression) together with the previously stored compressed
        // context, every time the chat updates.
        compressWindowSize: 5,
        // Stage 2 (compressed context -> image-generation tags): order/composition
        // of what gets sent to the LLM.
        // available tokens: {{instruction}} {{character_card}} {{compressed_context}} {{speaker}}
        // {{char_name}} {{char_description}} {{char_personality}} {{char_scenario}} {{char_mes_example}}
        promptTemplate: "{{instruction}}\n\n{{character_card}}\n\n[Current state]\n{{compressed_context}}",
        // instruction text sent to the LLM for Stage 2. Empty => DEFAULT_INSTRUCTION is used.
        customInstruction: "",
        // Stage 1 (recent log + previous compressed context -> updated compressed
        // context): order/composition of what gets sent to the LLM.
        // available tokens: {{instruction}} {{character_card}} {{previous_context}} {{recent_log}}
        // {{speaker}} {{char_name}} {{char_description}} {{char_personality}} {{char_scenario}} {{char_mes_example}}
        compressPromptTemplate:
            "{{instruction}}\n\n{{character_card}}\n\n[Previous state]\n{{previous_context}}\n\n[Recent lines]\n{{recent_log}}",
        // instruction text sent to the LLM for Stage 1. Empty => DEFAULT_COMPRESS_INSTRUCTION is used.
        compressInstruction: "",
        // If Stage 1's output is shorter than this many characters, it's
        // treated as a degenerate/broken response (occasionally the LLM
        // replies with something very short) and discarded: the previously
        // stored compressed context is kept as-is instead of being
        // overwritten, and is reused as-is for Stage 2. 0 disables the check.
        minCompressedContextLength: 20
    };

    const DEFAULT_INSTRUCTION =
        "You are a visual scene extractor for an image generation pipeline. " +
        "Based on the character's current state description below, output ONLY a " +
        "comma-separated list of Danbooru-style tags describing {{speaker}}'s appearance, " +
        "facial expression, pose, and immediate setting. No sentences, no explanation, " +
        "tags only, max 25 tags.";

    const DEFAULT_COMPRESS_INSTRUCTION =
        "You maintain a running state description of {{speaker}}'s current physical " +
        "appearance, clothing, body, pose, and immediate situation, for an image generation " +
        "pipeline. You are given the previous state description and the most recent lines of " +
        "roleplay. Output an UPDATED one-paragraph state description that reflects what is true " +
        "right now: carry over anything from the previous state that the recent lines don't " +
        "contradict, and update only what the recent lines indicate has changed. " +
        "Output ONLY the updated description text, no explanation, no headers.";

    // Placeholder -> value type, used when a workflow field value is *exactly*
    // the placeholder string (so numeric ComfyUI inputs get real numbers, not "12").
    const PLACEHOLDER_TYPES = {
        "%seed%": "int",
        "%steps%": "int",
        "%scale%": "float",
        "%sampler%": "string",
        "%scheduler%": "string",
        "%model%": "string",
        "%width%": "int",
        "%height%": "int",
        "%prompt%": "string",
        "%negative_prompt%": "string",
        "%vae%": "string",
        "%denoise%": "float",
        "%clip_skip%": "int"
    };

    let context = null;
    let eventTypes = null;
    let settings = null;

    let lastGenTime = 0;
    let lastMessageText = "";
    let currentAbortController = null;
    let abortTimer = null;
    let suppressNextTrigger = false;
    let suppressNextTriggerResetTimer = null;
    const imageCache = new Map(); // tagsHash -> image URL

    // in-memory mirror of the currently loaded chat's per-character compressed
    // context, so we don't have to hit the metadata store on every message.
    // Reloaded whenever the chat changes. { [speakerName]: { compressedContext } }
    let currentChatContexts = {};

    // ---------------------------------------------------------------------
    // per-chat / per-character compressed-context persistence
    //
    // Preferred storage: SillyTavern's chat metadata (context.chatMetadata /
    // context.chat_metadata), which is saved alongside the chat file itself —
    // this is what lets an interrupted conversation be resumed later with its
    // state intact, and keeps each chat's data separate automatically.
    //
    // Fallback: if this ST version doesn't expose chat metadata (or saving it
    // fails), we fall back to storing the same data inside this extension's
    // own settings, keyed by chat id. This is the browser extension's only
    // other persistent, per-user storage location — there is no way for
    // client-side JS to write to an arbitrary folder on disk.
    // ---------------------------------------------------------------------

    function getChatId() {
        const fresh = SillyTavern.getContext();
        if (typeof fresh.getCurrentChatId === "function") {
            const id = fresh.getCurrentChatId();
            if (id) return String(id);
        }
        return fresh.chatId ? String(fresh.chatId) : "__no_chat__";
    }

    function getChatMetadataStore() {
        const fresh = SillyTavern.getContext();
        const meta = fresh.chatMetadata || fresh.chat_metadata;
        if (!meta || typeof meta !== "object") return null;
        return meta;
    }

    function saveChatMetadataStore() {
        const fresh = SillyTavern.getContext();
        if (typeof fresh.saveMetadataDebounced === "function") {
            fresh.saveMetadataDebounced();
            return true;
        }
        if (typeof fresh.saveMetadata === "function") {
            fresh.saveMetadata();
            return true;
        }
        return false;
    }

    function loadChatContexts() {
        const meta = getChatMetadataStore();
        if (meta) {
            return meta[CONTEXT_STORE_KEY] ? structuredClone(meta[CONTEXT_STORE_KEY]) : {};
        }
        const chatId = getChatId();
        const fallback = settings.chatContextFallback[chatId];
        return fallback ? structuredClone(fallback) : {};
    }

    function persistChatContexts() {
        const meta = getChatMetadataStore();
        if (meta) {
            meta[CONTEXT_STORE_KEY] = currentChatContexts;
            if (saveChatMetadataStore()) return;
            // if ST exposed metadata but no save function, still fall through
            // to the settings-based fallback so nothing gets silently lost.
        }
        const chatId = getChatId();
        settings.chatContextFallback[chatId] = currentChatContexts;
        save();
    }

    function getStoredCharacterContext(speakerName) {
        return currentChatContexts[speakerName]?.compressedContext || "";
    }

    function setStoredCharacterContext(speakerName, compressedContext) {
        currentChatContexts[speakerName] = { compressedContext };
        persistChatContexts();
    }

    // Called on load and whenever the chat changes, so a conversation that was
    // interrupted mid-way resumes with its previously saved state instead of
    // starting blank.
    function reloadChatContexts() {
        currentChatContexts = loadChatContexts();
    }

    // ---------------------------------------------------------------------
    // settings persistence
    // ---------------------------------------------------------------------

    // The old (pre-2-stage) default value of promptTemplate. Users who never
    // customized this field have it persisted verbatim in their saved
    // settings, so a plain deepMerge would silently keep this stale template
    // (with a "{{log}}" token this version no longer fills) forever. We
    // detect and migrate it below.
    const LEGACY_PROMPT_TEMPLATE = "{{instruction}}\n\n{{character_card}}\n\n---\n{{log}}\n---";

    // NOTE: iterates the UNION of base's and override's keys, not just base's.
    // The previous version only looped over Object.keys(base), which silently
    // dropped anything the user had saved under a key that isn't part of the
    // fixed default shape — e.g. settings.custom.characterOverrides defaults
    // to {} (no fixed keys), so every saved character's custom tags were
    // discarded on every reload. Recurses into nested plain objects; for
    // anything else (arrays, primitives), override wins when present.
    function deepMerge(base, override) {
        if (Array.isArray(base)) {
            return override !== undefined ? override : [...base];
        }
        if (base && typeof base === "object") {
            const out = { ...base };
            const keys = new Set([
                ...Object.keys(base),
                ...(override && typeof override === "object" ? Object.keys(override) : [])
            ]);
            for (const key of keys) {
                if (override && Object.prototype.hasOwnProperty.call(override, key)) {
                    if (
                        base[key] && typeof base[key] === "object" && !Array.isArray(base[key]) &&
                        override[key] && typeof override[key] === "object" && !Array.isArray(override[key])
                    ) {
                        out[key] = deepMerge(base[key], override[key]);
                    } else {
                        out[key] = override[key];
                    }
                }
            }
            return out;
        }
        return override !== undefined ? override : base;
    }

    function loadSettings() {
        context.extensionSettings[MODULE_NAME] = context.extensionSettings[MODULE_NAME] || {};
        context.extensionSettings[MODULE_NAME] = deepMerge(
            structuredClone(DEFAULT_SETTINGS),
            context.extensionSettings[MODULE_NAME]
        );
        const merged = context.extensionSettings[MODULE_NAME];

        // Migrate a still-unmodified pre-2-stage template so it picks up the
        // new default (which uses {{compressed_context}} instead of the
        // no-longer-filled {{log}}) instead of silently going stale forever.
        if (merged.promptTemplate === LEGACY_PROMPT_TEMPLATE) {
            merged.promptTemplate = DEFAULT_SETTINGS.promptTemplate;
        }

        return merged;
    }

    function save() {
        context.saveSettingsDebounced();
    }

    // ---------------------------------------------------------------------
    // ComfyUI object_info -> dropdown population
    // ---------------------------------------------------------------------

    async function fetchComfyOptions(comfyUrl) {
        const res = await fetch(`${comfyUrl}/object_info`);
        if (!res.ok) throw new Error(`Failed to fetch object_info: ${res.status}`);
        const info = await res.json();
        return {
            samplers: info?.KSampler?.input?.required?.sampler_name?.[0] ?? [],
            schedulers: info?.KSampler?.input?.required?.scheduler?.[0] ?? [],
            checkpoints: info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [],
            vaes: info?.VAELoader?.input?.required?.vae_name?.[0] ?? []
        };
    }

    function populateSelect(el, options, selectedValue) {
        const $el = $(el);
        $el.empty();
        options.forEach((opt) => {
            $el.append(`<option value="${opt}" ${opt === selectedValue ? "selected" : ""}>${opt}</option>`);
        });
        if (selectedValue && !options.includes(selectedValue)) {
            $el.prepend(`<option value="${selectedValue}" selected>${selectedValue} (not found)</option>`);
        }
    }

    async function refreshComfyDropdowns() {
        if (!settings.custom.comfyUrl) return;
        try {
            const opts = await fetchComfyOptions(settings.custom.comfyUrl);
            populateSelect("#la_sampler", opts.samplers, settings.custom.defaults.sampler);
            populateSelect("#la_scheduler", opts.schedulers, settings.custom.defaults.scheduler);
            populateSelect("#la_default_model", opts.checkpoints, settings.custom.defaults.model);
            populateSelect("#la_default_vae", opts.vaes, settings.custom.defaults.vae);
            $("#la_char_overrides_list .char-model").each(function () {
                const current = $(this).val();
                populateSelect(this, opts.checkpoints, current);
            });
            window.toastr?.success?.("Updated ComfyUI option lists");
        } catch (e) {
            console.error("live-avatar:", e);
            window.toastr?.error?.(`Failed to fetch from ComfyUI: ${e.message}`);
        }
    }

    // ---------------------------------------------------------------------
    // workflow placeholder filling (type-aware)
    // ---------------------------------------------------------------------

    function castValue(raw, type) {
        if (type === "int") return parseInt(raw, 10);
        if (type === "float") return parseFloat(raw);
        return String(raw);
    }

    function fillWorkflowPlaceholders(node, values) {
        if (Array.isArray(node)) {
            return node.map((v) => fillWorkflowPlaceholders(v, values));
        }
        if (node !== null && typeof node === "object") {
            const result = {};
            for (const [k, v] of Object.entries(node)) {
                result[k] = fillWorkflowPlaceholders(v, values);
            }
            return result;
        }
        if (typeof node === "string") {
            // exact match -> type-cast replace (handles numeric fields like seed/steps/width)
            if (Object.prototype.hasOwnProperty.call(values, node)) {
                const type = PLACEHOLDER_TYPES[node] ?? "string";
                return castValue(values[node], type);
            }
            // partial match -> plain string substitution
            let replaced = node;
            for (const [placeholder, value] of Object.entries(values)) {
                if (replaced.includes(placeholder)) {
                    replaced = replaced.split(placeholder).join(String(value));
                }
            }
            return replaced;
        }
        return node;
    }

    function resolveSeed(seedSetting) {
        if (Number(seedSetting) === -1) return Math.floor(Math.random() * 1e10);
        return Number(seedSetting);
    }

    // ---------------------------------------------------------------------
    // LLM scene/tag extraction (uses the currently connected API via /genraw)
    // ---------------------------------------------------------------------

    // Reads the currently active character card and exposes its fields as
    // individually usable template tokens ({{char_name}}, {{char_description}}, ...).
    //
    // IMPORTANT: `context` is captured once at extension load time. Arrays like
    // context.chat / context.characters stay in sync because SillyTavern mutates
    // the same array in place, but scalar fields like characterId/groupId do NOT
    // update on that cached object when the user switches character/chat — they
    // only reflect whatever they were at load time. So for these two fields we
    // always ask SillyTavern.getContext() again to get the live value.
    function getActiveCharacterId() {
        const fresh = SillyTavern.getContext();
        return fresh.characterId ?? fresh.this_chid ?? window.this_chid;
    }

    function getActiveGroupId() {
        const fresh = SillyTavern.getContext();
        return fresh.groupId ?? window.selected_group ?? null;
    }

    // SillyTavern-style macros like {{user}} / {{char}} commonly show up not
    // just in character card fields, but also in user-written instruction
    // text and templates (this used to "just work" because the assembled
    // prompt went through resolution before Stage separation existed).
    // Since we build/send these strings ourselves via /genraw, they are NOT
    // resolved automatically — we resolve them explicitly wherever a user
    // might type them: card fields, instruction text, and the final
    // assembled prompt.
    function resolveMacros(text) {
        if (!text) return text;
        const fresh = SillyTavern.getContext();
        if (typeof fresh.substituteParams === "function") {
            try {
                return fresh.substituteParams(text);
            } catch {
                /* fall through to the manual replacement below */
            }
        }
        const userName = fresh.name1 || "User";
        const charName = fresh.characters?.[getActiveCharacterId()]?.name || fresh.name2 || "Character";
        return text.replaceAll("{{user}}", userName).replaceAll("{{User}}", userName)
            .replaceAll("{{char}}", charName).replaceAll("{{Char}}", charName);
    }

    // kept as an alias for readability at the call sites that specifically
    // resolve macros inside character-card fields.
    const resolveCardMacros = resolveMacros;

    function getCharacterCardFields() {
        const fresh = SillyTavern.getContext();
        const char = fresh.characters?.[getActiveCharacterId()] ?? {};
        // Character Card v2 keeps the real fields under `.data`; fall back to
        // the flat legacy fields if `.data` isn't present.
        const data = char.data || char;
        return {
            char_name: char.name || data.name || "",
            char_description: resolveCardMacros(data.description || char.description || ""),
            char_personality: resolveCardMacros(data.personality || char.personality || ""),
            char_scenario: resolveCardMacros(data.scenario || char.scenario || ""),
            char_mes_example: resolveCardMacros(data.mes_example || char.mes_example || "")
        };
    }

    function buildCharacterCardBlock(fields) {
        const parts = [];
        if (fields.char_name) parts.push(`Name: ${fields.char_name}`);
        if (fields.char_description) parts.push(`Description: ${fields.char_description}`);
        if (fields.char_personality) parts.push(`Personality: ${fields.char_personality}`);
        if (fields.char_scenario) parts.push(`Scenario: ${fields.char_scenario}`);
        return parts.join("\n");
    }

    // Simple {{token}} substitution. Unknown tokens are left untouched.
    function fillTemplate(template, values) {
        let out = template;
        for (const [key, val] of Object.entries(values)) {
            out = out.split(`{{${key}}}`).join(val ?? "");
        }
        return out;
    }

    // Normalizes line endings; real newlines are sent through as-is to /genraw
    // (confirmed working), we just avoid stray \r characters and still guard
    // against STscript's `|` (command chaining) and `{ }` (macro) syntax.
    function flattenForSlashCommand(text) {
        return text
            .replace(/\r\n|\r/g, "\n")
            .replaceAll("{", "(")
            .replaceAll("}", ")")
            .replaceAll("|", "-");
    }

    // Detects a message that is itself the result of our own /imagine call
    // (used both to filter the log and as a belt-and-suspenders check next to
    // the suppressNextTrigger flag).
    function looksLikeGeneratedImageMessage(message) {
        if (!message) return false;
        if (message.extra?.image) return true;
        const text = (message.mes || "").trim();
        if (!text) return false;
        if (/^<img[\s>]/i.test(text)) return true;
        if (/\.(png|jpe?g|webp|gif)(\?\S*)?$/i.test(text) && text.length < 300) return true;
        return false;
    }

    // Excludes messages that this extension generated itself so they don't
    // pollute the context sent to the LLM. Always returns the N most recent
    // messages (across all speakers), since Stage 1 relies on a short rolling
    // window rather than the full chat history.
    function buildRecentLogText(count) {
        const source = context.chat.filter((m) => !looksLikeGeneratedImageMessage(m));
        const n = Math.max(1, Number(count) || 1);
        const messages = source.slice(-n);
        // Message text (m.mes) is stored as authored — SillyTavern only
        // resolves {{user}}/{{char}} macros at render time, not in the
        // underlying chat data. This is especially common in a character's
        // opening/greeting message, which often literally contains
        // "{{user}}: ..." as example-dialogue formatting. Resolve it here so
        // it doesn't leak into the log we send to the LLM.
        return messages.map((m) => `${resolveMacros(m.name)}: ${resolveMacros(m.mes)}`).join("\n");
    }

    async function runGenraw(prompt) {
        const safe = flattenForSlashCommand(prompt);
        const result = await context.executeSlashCommandsWithOptions(`/genraw ${safe}`, {
            showOutput: false
        });
        const raw = result?.pipe?.trim();
        if (!raw) throw new Error("Empty response from the LLM");
        return raw;
    }

    // Both stages accept the full token set (some tokens are simply blank in
    // a stage where they don't apply) so a user who references a token in
    // the "wrong" template still gets it substituted instead of seeing a
    // literal, un-filled "{{token}}" in the text sent to the LLM.
    function buildTemplateValues({ instruction, speakerLabel, charFields, previousContext, recentLog, compressedContext }) {
        return {
            instruction,
            character_card: buildCharacterCardBlock(charFields),
            previous_context: previousContext ?? "",
            recent_log: recentLog ?? "",
            compressed_context: compressedContext ?? "",
            speaker: speakerLabel,
            ...charFields
        };
    }

    // Stage 1: previous compressed context + a short window of recent chat
    // lines -> an updated compressed state description (clothing/body/pose/
    // situation) for this speaker. This is what gets persisted per chat per
    // character. Returns both the updated context and the recentLog it used,
    // so the caller can pass the same recentLog into Stage 2 without
    // recomputing it.
    async function requestUpdatedCompressedContext(speakerName, previousContext, signal) {
        const charFields = getCharacterCardFields();
        const speakerLabel = speakerName || "the character";
        const recentLog = buildRecentLogText(settings.compressWindowSize);

        const rawInstruction = (settings.compressInstruction || "").trim() || DEFAULT_COMPRESS_INSTRUCTION;
        const instruction = resolveMacros(fillTemplate(rawInstruction, { speaker: speakerLabel, ...charFields }));

        const template = settings.compressPromptTemplate?.trim() || DEFAULT_SETTINGS.compressPromptTemplate;
        const prompt = resolveMacros(fillTemplate(template, buildTemplateValues({
            instruction,
            speakerLabel,
            charFields,
            previousContext: previousContext || "(no state recorded yet)",
            recentLog
        })));

        const result = await context.executeSlashCommandsWithOptions(`/genraw ${flattenForSlashCommand(prompt)}`, {
            showOutput: false,
            abortController: signal ? { signal } : undefined
        });
        const raw = result?.pipe?.trim();
        if (!raw) throw new Error("Empty response from the LLM (compression stage)");
        return { compressedContext: raw.replace(/^["']|["']$/g, ""), recentLog };
    }

    // Stage 2: compressed state description -> Danbooru-style tags for image
    // generation. previousContext/recentLog are the same values Stage 1 was
    // given (pre-update), passed through so a customized template can also
    // reference them here if useful, not just {{compressed_context}}.
    async function requestTagsFromCompressedContext(speakerName, compressedContext, previousContext, recentLog, signal) {
        const charFields = getCharacterCardFields();
        const speakerLabel = speakerName || "the character";

        const rawInstruction = (settings.customInstruction || "").trim() || DEFAULT_INSTRUCTION;
        const instruction = resolveMacros(fillTemplate(rawInstruction, { speaker: speakerLabel, ...charFields }));

        const template = settings.promptTemplate?.trim() || DEFAULT_SETTINGS.promptTemplate;
        const prompt = resolveMacros(fillTemplate(template, buildTemplateValues({
            instruction,
            speakerLabel,
            charFields,
            compressedContext,
            previousContext,
            recentLog
        })));

        const result = await context.executeSlashCommandsWithOptions(`/genraw ${flattenForSlashCommand(prompt)}`, {
            showOutput: false,
            abortController: signal ? { signal } : undefined
        });
        const raw = result?.pipe?.trim();
        if (!raw) throw new Error("Empty response from the LLM (prompt generation stage)");

        return raw
            .replace(/^["']|["']$/g, "")
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
            .slice(0, 30);
    }

    // ---------------------------------------------------------------------
    // image generation
    // ---------------------------------------------------------------------

    async function generateViaImagineCommand(prompt, signal) {
        const escaped = prompt.replace(/[\r\n]+/g, " ").replace(/[{}]/g, "");

        // quiet=true is the documented way to stop /imagine from posting the
        // generated image into the chat as a message. We also keep the
        // suppressNextTrigger flag as a safety net for older ST versions
        // where quiet=true might not be honored.
        suppressNextTrigger = true;
        clearTimeout(suppressNextTriggerResetTimer);
        suppressNextTriggerResetTimer = setTimeout(() => { suppressNextTrigger = false; }, 10000);

        const result = await context.executeSlashCommandsWithOptions(`/imagine quiet=true ${escaped}`, {
            showOutput: false,
            abortController: signal ? { signal } : undefined
        });
        const url = result?.pipe;
        if (!url) throw new Error("No result returned from the standard image generation pipeline");
        return url;
    }

    function generateViaCustomWorkflow(promptText, speakerName, signal) {
        const { comfyUrl, workflowJson, width, height, defaults, negativePrompt, characterOverrides } = settings.custom;
        if (!workflowJson) return Promise.reject(new Error("Workflow JSON is not set"));

        const override = characterOverrides[speakerName] || {};
        const seed = resolveSeed(defaults.seed);

        const values = {
            "%seed%": seed,
            "%steps%": defaults.steps,
            "%scale%": defaults.scale,
            "%sampler%": defaults.sampler,
            "%scheduler%": defaults.scheduler,
            "%model%": override.model || defaults.model,
            "%width%": width,
            "%height%": height,
            "%prompt%": `${override.promptPrefix || ""}${promptText}`,
            "%negative_prompt%": negativePrompt || "",
            "%vae%": override.vae || defaults.vae,
            "%denoise%": defaults.denoise,
            "%clip_skip%": defaults.clipSkip
        };

        let workflow;
        try {
            workflow = fillWorkflowPlaceholders(JSON.parse(workflowJson), values);
        } catch (e) {
            return Promise.reject(new Error(`Failed to parse workflow JSON: ${e.message}`));
        }

        const clientId = crypto.randomUUID();

        return new Promise((resolve, reject) => {
            const wsUrl = comfyUrl.replace(/^http/, "ws") + `/ws?clientId=${clientId}`;
            const ws = new WebSocket(wsUrl);

            const onAbort = () => {
                try { ws.close(); } catch { /* noop */ }
                reject(new DOMException("Aborted", "AbortError"));
            };
            signal?.addEventListener("abort", onAbort);

            ws.onopen = async () => {
                try {
                    const res = await fetch(`${comfyUrl}/prompt`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ prompt: workflow, client_id: clientId }),
                        signal
                    });
                    if (!res.ok) {
                        const errText = await res.text();
                        ws.close();
                        reject(new Error(`ComfyUI error ${res.status}: ${errText}`));
                    }
                } catch (e) {
                    if (e.name !== "AbortError") reject(e);
                }
            };

            ws.onmessage = async (event) => {
                if (typeof event.data !== "string") return;
                let msg;
                try {
                    msg = JSON.parse(event.data);
                } catch {
                    return;
                }

                if (msg.type === "execution_error") {
                    ws.close();
                    reject(new Error(`ComfyUI execution error: ${msg.data?.exception_message ?? "unknown"}`));
                    return;
                }

                if (msg.type === "executing" && msg.data.node === null) {
                    try {
                        const histRes = await fetch(`${comfyUrl}/history/${msg.data.prompt_id}`);
                        const hist = await histRes.json();
                        const outputs = Object.values(hist)[0]?.outputs ?? {};
                        const imgInfo = Object.values(outputs).find((o) => o.images)?.images?.[0];
                        ws.close();
                        if (!imgInfo) {
                            reject(new Error("No SaveImage output found"));
                            return;
                        }
                        const url =
                            `${comfyUrl}/view?filename=${encodeURIComponent(imgInfo.filename)}` +
                            `&subfolder=${encodeURIComponent(imgInfo.subfolder)}&type=${imgInfo.type}`;
                        resolve(url);
                    } catch (e) {
                        reject(e);
                    }
                }
            };

            ws.onerror = () => reject(new Error("ComfyUI WebSocket connection error"));
        });
    }

    async function generateAvatar(tags, speakerName, signal) {
        const override = settings.custom.characterOverrides[speakerName] || {};
        const tagList = override.customTags ? `${override.customTags}, ${tags.join(", ")}` : tags.join(", ");

        if (settings.generationMode === "standard") {
            const prompt = `${settings.standardPromptPrefix}${override.promptPrefix || ""}${tagList}`;
            return await generateViaImagineCommand(prompt, signal);
        }
        return await generateViaCustomWorkflow(tagList, speakerName, signal);
    }

    // ---------------------------------------------------------------------
    // floating avatar panel
    // ---------------------------------------------------------------------

    function ensureAvatarPanel() {
        if ($("#live-avatar-panel").length) return;
        $("body").append(`
            <div id="live-avatar-panel">
                <div id="live-avatar-header">
                    <span id="live-avatar-name"></span>
                    <span id="live-avatar-close">×</span>
                </div>
                <div id="live-avatar-imgwrap" class="no-image">
                    <img id="live-avatar-img" src="">
                    <img id="live-avatar-img-fade" src="">
                    <div id="live-avatar-placeholder">No image generated yet</div>
                </div>
                <div id="live-avatar-spinner">Generating...</div>
                <div id="live-avatar-resize-handle"></div>
            </div>
        `);
        $("#live-avatar-close").on("click", (e) => {
            e.stopPropagation();
            $("#live-avatar-panel").toggleClass("collapsed");
        });
        applyPanelPosition();
        applyPanelSize();
        initPanelDrag();
        initPanelResize();
    }

    // Restores the saved free-form position, or falls back to the default
    // bottom-right corner if the panel has never been dragged.
    function applyPanelPosition() {
        const $panel = $("#live-avatar-panel");
        if (settings.panel.usePosition && settings.panel.left != null && settings.panel.top != null) {
            $panel.css({ left: `${settings.panel.left}px`, top: `${settings.panel.top}px`, right: "auto", bottom: "auto" });
        } else {
            $panel.css({ right: "20px", bottom: "20px", left: "auto", top: "auto" });
        }
    }

    // Restores the saved free-form size, or falls back to the default size.
    function applyPanelSize() {
        const $panel = $("#live-avatar-panel");
        const width = settings.panel.width || 220;
        const height = settings.panel.height || 300;
        $panel.css({ width: `${width}px`, height: `${height}px` });
    }

    // Lets the user resize the panel by dragging the bottom-right handle.
    // The image inside always scales to fill the panel (object-fit: contain),
    // so the panel size directly controls the displayed avatar size.
    function initPanelResize() {
        const $panel = $("#live-avatar-panel");
        const $handle = $("#live-avatar-resize-handle");
        let resizing = false;
        let startX = 0, startY = 0, startWidth = 0, startHeight = 0;

        const getPoint = (e) => (e.touches ? e.touches[0] : e);
        const MIN_WIDTH = 140;
        const MIN_HEIGHT = 180;

        $handle.on("mousedown touchstart", (e) => {
            resizing = true;
            const point = getPoint(e.originalEvent ?? e);
            const rect = $panel[0].getBoundingClientRect();
            startX = point.clientX;
            startY = point.clientY;
            startWidth = rect.width;
            startHeight = rect.height;
            $panel.addClass("resizing");
            e.preventDefault();
            e.stopPropagation();
        });

        $(document).on("mousemove touchmove", (e) => {
            if (!resizing) return;
            const point = getPoint(e.originalEvent ?? e);
            const newWidth = Math.max(MIN_WIDTH, startWidth + (point.clientX - startX));
            const newHeight = Math.max(MIN_HEIGHT, startHeight + (point.clientY - startY));
            $panel.css({ width: `${newWidth}px`, height: `${newHeight}px` });
        });

        $(document).on("mouseup touchend", () => {
            if (!resizing) return;
            resizing = false;
            $panel.removeClass("resizing");
            const rect = $panel[0].getBoundingClientRect();
            settings.panel.width = Math.round(rect.width);
            settings.panel.height = Math.round(rect.height);
            save();
        });
    }

    // Lets the user drag the panel anywhere on screen by its header bar.
    // The resulting position is persisted so it survives reloads.
    function initPanelDrag() {
        const $panel = $("#live-avatar-panel");
        const $header = $("#live-avatar-header");
        let dragging = false;
        let startX = 0, startY = 0, startLeft = 0, startTop = 0;

        const getPoint = (e) => (e.touches ? e.touches[0] : e);

        $header.on("mousedown touchstart", (e) => {
            if ($(e.target).is("#live-avatar-close")) return;
            dragging = true;
            const point = getPoint(e.originalEvent ?? e);
            const rect = $panel[0].getBoundingClientRect();
            startX = point.clientX;
            startY = point.clientY;
            startLeft = rect.left;
            startTop = rect.top;
            $panel.css({ right: "auto", bottom: "auto", left: `${startLeft}px`, top: `${startTop}px` });
            $panel.addClass("dragging");
            e.preventDefault();
        });

        $(document).on("mousemove touchmove", (e) => {
            if (!dragging) return;
            const point = getPoint(e.originalEvent ?? e);
            const dx = point.clientX - startX;
            const dy = point.clientY - startY;
            const maxLeft = Math.max(0, window.innerWidth - $panel.outerWidth());
            const maxTop = Math.max(0, window.innerHeight - $panel.outerHeight());
            const newLeft = Math.min(Math.max(0, startLeft + dx), maxLeft);
            const newTop = Math.min(Math.max(0, startTop + dy), maxTop);
            $panel.css({ left: `${newLeft}px`, top: `${newTop}px` });
        });

        $(document).on("mouseup touchend", () => {
            if (!dragging) return;
            dragging = false;
            $panel.removeClass("dragging");
            const rect = $panel[0].getBoundingClientRect();
            settings.panel.usePosition = true;
            settings.panel.left = rect.left;
            settings.panel.top = rect.top;
            save();
        });
    }

    function swapAvatar(url, speakerName) {
        ensureAvatarPanel();
        $("#live-avatar-name").text(speakerName || "");
        const $fade = $("#live-avatar-img-fade");
        const $wrap = $("#live-avatar-imgwrap");
        const $placeholder = $("#live-avatar-placeholder");

        $fade.off("load error");
        $fade.on("load", () => {
            $wrap.removeClass("no-image");
            $fade.css("opacity", 1);
            setTimeout(() => {
                $("#live-avatar-img").attr("src", url);
                $fade.css("opacity", 0);
            }, 300);
        });
        $fade.on("error", () => {
            $placeholder.text("Failed to load image");
            $wrap.addClass("no-image");
        });
        $fade.attr("src", url);
    }

    function showGeneratingIndicator(show) {
        ensureAvatarPanel();
        $("#live-avatar-spinner").toggleClass("visible", !!show);
    }

    // ---------------------------------------------------------------------
    // main event flow: new AI message -> tags -> image -> swap
    // ---------------------------------------------------------------------

    async function onNewMessage(messageIndex) {
        if (!settings.enabled) return;

        const message = context.chat[messageIndex];
        if (!message || message.is_user) return;

        // Ignore the chat message that /imagine just posted with our own
        // generated image — otherwise it re-triggers this handler forever.
        if (suppressNextTrigger || looksLikeGeneratedImageMessage(message)) {
            suppressNextTrigger = false;
            clearTimeout(suppressNextTriggerResetTimer);
            console.log("live-avatar: ignoring self-generated image message");
            return;
        }

        // NOTE: we deliberately do NOT rebuild the speaker dropdown here.
        // Doing so on every single message used to reset whatever character
        // the user had selected in the settings panel while they were mid-edit,
        // silently recording their typed tags under the wrong character. The
        // dropdown is refreshed instead on drawer-open, CHAT_CHANGED, and the
        // manual 🔄 button — see refreshCharSelectDropdown().

        // throttling (user-configurable, 0 disables the check)
        const now = Date.now();
        const { minIntervalMs, minCharDiff } = settings.throttle;
        if (minIntervalMs > 0 && now - lastGenTime < minIntervalMs) {
            console.log("live-avatar: throttled (interval)");
            return;
        }
        if (minCharDiff > 0) {
            const diff = Math.abs(message.mes.length - lastMessageText.length);
            if (diff < minCharDiff) {
                console.log("live-avatar: throttled (char diff)");
                return;
            }
        }

        // abort control (user-configurable)
        if (settings.abort.enabled && currentAbortController) {
            currentAbortController.abort();
            clearTimeout(abortTimer);
        }
        currentAbortController = new AbortController();
        const signal = currentAbortController.signal;
        if (settings.abort.enabled) {
            abortTimer = setTimeout(() => currentAbortController.abort(), settings.abort.timeoutMs);
        }

        try {
            const speakerName = message.name;

            // Step 1 (Stage 1): fold the recent lines into this character's persisted
            // compressed state (clothing/body/pose/situation), carrying over
            // whatever the recent lines don't contradict.
            const previousContext = getStoredCharacterContext(speakerName);
            const { compressedContext: rawCompressedContext, recentLog } =
                await requestUpdatedCompressedContext(speakerName, previousContext, signal);

            // Guard against occasional degenerate/too-short Stage 1 replies,
            // which would otherwise corrupt the tracked state. Only applies
            // once we actually have a previous state to fall back to — a
            // short first-ever result is still accepted, since there's
            // nothing better to use.
            const minLen = Number(settings.minCompressedContextLength) || 0;
            const isTooShort = minLen > 0 && previousContext && rawCompressedContext.trim().length < minLen;
            const compressedContext = isTooShort ? previousContext : rawCompressedContext;
            if (isTooShort) {
                console.warn(
                    `live-avatar: Stage 1 response too short, discarded — kept previous state (${rawCompressedContext.trim().length} chars < ${minLen} chars)`
                );
            } else {
                setStoredCharacterContext(speakerName, compressedContext);
            }

            // Step 2 (Stage 2): turn that compressed state into image-generation tags
            const tags = await requestTagsFromCompressedContext(speakerName, compressedContext, previousContext, recentLog, signal);
            const hash = tags.slice().sort().join(",");

            if (settings.cacheEnabled && imageCache.has(hash)) {
                swapAvatar(imageCache.get(hash), speakerName);
                lastGenTime = now;
                lastMessageText = message.mes;
                return;
            }

            showGeneratingIndicator(true);

            // Step 3: send it to ComfyUI (or the standard image gen pipeline)
            const imageUrl = await generateAvatar(tags, speakerName, signal);
            if (settings.cacheEnabled) imageCache.set(hash, imageUrl);

            // Step 4: overwrite the avatar panel
            swapAvatar(imageUrl, speakerName);

            lastGenTime = now;
            lastMessageText = message.mes;
        } catch (e) {
            if (e?.name !== "AbortError") console.error("live-avatar:", e);
        } finally {
            showGeneratingIndicator(false);
            clearTimeout(abortTimer);
        }
    }

    // ---------------------------------------------------------------------
    // settings panel wiring
    // ---------------------------------------------------------------------

    function toggleModeBlocks() {
        const mode = settings.generationMode;
        $("#la_standard_block").toggle(mode === "standard");
        $("#la_custom_block").toggle(mode === "custom");
    }

    function toggleResolutionBlock() {
        $("#la_custom_res_block").toggle(settings.custom.resolutionPreset === "custom");
    }

    function addCharOverrideRow(name, cfg) {
        const $list = $("#la_char_overrides_list");
        const row = $(`
            <div class="la-char-row">
                <input type="text" class="text_pole char-name" value="${name}" placeholder="Character name (must match display name)">
                <select class="text_pole char-model"></select>
                <input type="text" class="text_pole char-prefix" value="${cfg.promptPrefix || ""}" placeholder="Prompt prefix">
                <input type="text" class="text_pole char-tags" value="${cfg.customTags || ""}" placeholder="Custom tags (comma-separated)">
                <button class="menu_button char-remove">×</button>
            </div>
        `);
        const existing = cfg.model ? [cfg.model] : [];
        populateSelect(row.find(".char-model")[0], existing, cfg.model || "");
        row.find(".char-name, .char-model, .char-prefix, .char-tags").on("input change", () => {
            syncCharOverrides();
            refreshCurrentCharTagsField();
        });
        row.find(".char-remove").on("click", () => {
            row.remove();
            syncCharOverrides();
            refreshCurrentCharTagsField();
        });
        $list.append(row);
    }

    function renderCharOverridesList() {
        $("#la_char_overrides_list").empty();
        for (const [name, cfg] of Object.entries(settings.custom.characterOverrides)) {
            addCharOverrideRow(name, cfg);
        }
    }

    function syncCharOverrides() {
        const overrides = {};
        $("#la_char_overrides_list .la-char-row").each(function () {
            const name = $(this).find(".char-name").val().trim();
            if (!name) return;
            overrides[name] = {
                model: $(this).find(".char-model").val(),
                promptPrefix: $(this).find(".char-prefix").val(),
                customTags: $(this).find(".char-tags").val()
            };
        });
        settings.custom.characterOverrides = overrides;
        save();
    }

    // ---- "character tags" field, targeted via a speaker dropdown ---------
    // Shows/edits settings.custom.characterOverrides[<selected speaker>].customTags.
    // The dropdown is built from names that actually appear in the chat log
    // (plus the loaded character card and, for group chats, all group
    // members), since relying on a single "active character" id proved
    // unreliable across chat types.

    function getKnownSpeakers() {
        const fresh = SillyTavern.getContext();
        const names = new Set();

        // characters that have already spoken in this chat
        for (const m of fresh.chat ?? []) {
            if (m && !m.is_user && !m.is_system && m.name) names.add(m.name);
        }

        // the currently loaded character card, so it's selectable even before
        // it has sent a single message (solo chat)
        const activeChar = fresh.characters?.[getActiveCharacterId()];
        if (activeChar?.name) names.add(activeChar.name);

        // all members of the current group, if this is a group chat
        const groupId = getActiveGroupId();
        if (groupId && Array.isArray(fresh.groups)) {
            const group = fresh.groups.find((g) => g.id === groupId);
            for (const avatarFile of group?.members ?? []) {
                const member = fresh.characters?.find((c) => c.avatar === avatarFile);
                if (member?.name) names.add(member.name);
            }
        }

        // never let a character silently drop out of the list just because a
        // refresh happened to run before they spoke again — anyone we already
        // have recorded tag data for stays selectable.
        for (const name of Object.keys(settings.custom.characterOverrides || {})) {
            if (name) names.add(name);
        }

        return Array.from(names).sort((a, b) => a.localeCompare(b));
    }

    // Rebuilds the speaker dropdown. Only ever called from explicit,
    // non-disruptive triggers (initial render, drawer open, CHAT_CHANGED,
    // the manual refresh button) — never from the per-message chat handler,
    // since that used to yank the selection out from under the user mid-edit.
    function refreshCharSelectDropdown() {
        const $select = $("#la_char_select");
        if (!$select.length) return;

        const speakers = getKnownSpeakers();
        const previous = $select.val();
        $select.empty();

        if (speakers.length === 0) {
            $select.append(`<option value="">(no characters found)</option>`);
        } else {
            speakers.forEach((name) => $select.append(`<option value="${name}">${name}</option>`));
            $select.val(speakers.includes(previous) ? previous : speakers[0]);
        }

        refreshCurrentCharTagsField();
    }

    function refreshCurrentCharTagsField() {
        if (!$("#la_current_char_tags").length) return;
        const name = $("#la_char_select").val() || "";
        const cfg = settings.custom.characterOverrides[name] || {};
        $("#la_current_char_tags").val(cfg.customTags || "");
        $("#la_current_char_tags").prop("disabled", !name);
    }

    function saveCurrentCharTags(value) {
        const name = $("#la_char_select").val();
        if (!name) return;
        const overrides = settings.custom.characterOverrides;
        overrides[name] = { ...(overrides[name] || {}), customTags: value };
        settings.custom.characterOverrides = overrides;
        save();
        renderCharOverridesList(); // keep the full table in sync
    }

    async function renderSettingsPanel() {
        const html = await $.get(`${EXTENSION_FOLDER}/settings.html`);
        $("#extensions_settings2").append(html);

        // initial values
        $("#la_enabled").prop("checked", settings.enabled);
        $("#la_mode").val(settings.generationMode);
        $("#la_standard_prefix").val(settings.standardPromptPrefix);
        $("#la_comfy_url").val(settings.custom.comfyUrl);
        $("#la_workflow_json").val(settings.custom.workflowJson);
        $("#la_resolution_preset").val(settings.custom.resolutionPreset);
        $("#la_width").val(settings.custom.width);
        $("#la_height").val(settings.custom.height);
        $("#la_negative_prompt").val(settings.custom.negativePrompt);
        $("#la_steps").val(settings.custom.defaults.steps);
        $("#la_scale").val(settings.custom.defaults.scale);
        $("#la_denoise").val(settings.custom.defaults.denoise);
        $("#la_clip_skip").val(settings.custom.defaults.clipSkip);
        $("#la_seed").val(settings.custom.defaults.seed);
        $("#la_cache_enabled").prop("checked", settings.cacheEnabled);
        $("#la_throttle_ms").val(settings.throttle.minIntervalMs);
        $("#la_throttle_chardiff").val(settings.throttle.minCharDiff);
        $("#la_abort_enabled").prop("checked", settings.abort.enabled);
        $("#la_abort_timeout").val(settings.abort.timeoutMs);
        $("#la_prompt_template").val(settings.promptTemplate);
        $("#la_custom_instruction").val(settings.customInstruction);
        $("#la_compress_window").val(settings.compressWindowSize);
        $("#la_compress_prompt_template").val(settings.compressPromptTemplate);
        $("#la_compress_instruction").val(settings.compressInstruction);
        $("#la_compress_min_length").val(settings.minCompressedContextLength);

        toggleModeBlocks();
        toggleResolutionBlock();
        renderCharOverridesList();
        refreshCharSelectDropdown();

        if (settings.custom.comfyUrl) refreshComfyDropdowns();

        // bindings
        $("#la_enabled").on("change", (e) => { settings.enabled = e.target.checked; save(); });
        $("#la_mode").on("change", (e) => { settings.generationMode = e.target.value; toggleModeBlocks(); save(); });
        $("#la_standard_prefix").on("input", (e) => { settings.standardPromptPrefix = e.target.value; save(); });

        $("#la_comfy_url").on("change", () => {
            settings.custom.comfyUrl = $("#la_comfy_url").val();
            save();
            refreshComfyDropdowns();
        });
        $("#la_refresh_comfy").on("click", refreshComfyDropdowns);

        $("#la_workflow_json").on("input", (e) => { settings.custom.workflowJson = e.target.value; save(); });
        $("#la_workflow_file").on("change", async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const text = await file.text();
            settings.custom.workflowJson = text;
            $("#la_workflow_json").val(text);
            save();
        });

        $("#la_resolution_preset").on("change", (e) => {
            settings.custom.resolutionPreset = e.target.value;
            if (e.target.value !== "custom") {
                const [w, h] = e.target.value.split("x").map(Number);
                settings.custom.width = w;
                settings.custom.height = h;
                $("#la_width").val(w);
                $("#la_height").val(h);
            }
            toggleResolutionBlock();
            save();
        });
        $("#la_width").on("input", (e) => { settings.custom.width = Number(e.target.value); save(); });
        $("#la_height").on("input", (e) => { settings.custom.height = Number(e.target.value); save(); });
        $("#la_negative_prompt").on("input", (e) => { settings.custom.negativePrompt = e.target.value; save(); });

        $("#la_sampler").on("change", (e) => { settings.custom.defaults.sampler = e.target.value; save(); });
        $("#la_scheduler").on("change", (e) => { settings.custom.defaults.scheduler = e.target.value; save(); });
        $("#la_default_model").on("change", (e) => { settings.custom.defaults.model = e.target.value; save(); });
        $("#la_default_vae").on("change", (e) => { settings.custom.defaults.vae = e.target.value; save(); });
        $("#la_steps").on("input", (e) => { settings.custom.defaults.steps = Number(e.target.value); save(); });
        $("#la_scale").on("input", (e) => { settings.custom.defaults.scale = Number(e.target.value); save(); });
        $("#la_denoise").on("input", (e) => { settings.custom.defaults.denoise = Number(e.target.value); save(); });
        $("#la_clip_skip").on("input", (e) => { settings.custom.defaults.clipSkip = Number(e.target.value); save(); });
        $("#la_seed").on("input", (e) => { settings.custom.defaults.seed = Number(e.target.value); save(); });

        $("#la_cache_enabled").on("change", (e) => {
            settings.cacheEnabled = e.target.checked;
            if (!e.target.checked) imageCache.clear();
            save();
        });
        $("#la_throttle_ms").on("input", (e) => { settings.throttle.minIntervalMs = Number(e.target.value); save(); });
        $("#la_throttle_chardiff").on("input", (e) => { settings.throttle.minCharDiff = Number(e.target.value); save(); });
        $("#la_abort_enabled").on("change", (e) => { settings.abort.enabled = e.target.checked; save(); });
        $("#la_abort_timeout").on("input", (e) => { settings.abort.timeoutMs = Number(e.target.value); save(); });

        $("#la_add_char_override").on("click", () => addCharOverrideRow("", {}));

        $("#la_prompt_template").on("input", (e) => { settings.promptTemplate = e.target.value; save(); });
        $("#la_custom_instruction").on("input", (e) => { settings.customInstruction = e.target.value; save(); });
        $("#la_compress_window").on("input", (e) => { settings.compressWindowSize = Math.max(1, Number(e.target.value) || 1); save(); });
        $("#la_compress_prompt_template").on("input", (e) => { settings.compressPromptTemplate = e.target.value; save(); });
        $("#la_compress_instruction").on("input", (e) => { settings.compressInstruction = e.target.value; save(); });
        $("#la_compress_min_length").on("input", (e) => { settings.minCompressedContextLength = Math.max(0, Number(e.target.value) || 0); save(); });
        $("#la_char_select").on("change", refreshCurrentCharTagsField);
        $("#la_refresh_speakers").on("click", refreshCharSelectDropdown);
        $("#la_current_char_tags").on("input", (e) => saveCurrentCharTags(e.target.value));

        $("#la_reset_panel_pos").on("click", () => {
            settings.panel.usePosition = false;
            settings.panel.left = null;
            settings.panel.top = null;
            save();
            applyPanelPosition();
        });
    }

    // ---------------------------------------------------------------------
    // init
    // ---------------------------------------------------------------------

    jQuery(async () => {
        context = SillyTavern.getContext();
        eventTypes = context.eventTypes || context.event_types;
        settings = loadSettings();
        reloadChatContexts();

        await renderSettingsPanel();
        ensureAvatarPanel();

        context.eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onNewMessage);

        // Re-sync the speaker dropdown / tag field, and reload this chat's
        // saved per-character compressed context (so an interrupted
        // conversation resumes with its state intact), whenever the user
        // switches characters/chats in SillyTavern.
        if (eventTypes.CHAT_CHANGED) {
            context.eventSource.on(eventTypes.CHAT_CHANGED, () => {
                reloadChatContexts();
                refreshCharSelectDropdown();
            });
        }

        console.log("live-avatar: extension loaded");
    });
})();